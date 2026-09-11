/**
 * Cancel Package API Route
 * Cancels pending or in-process packaging jobs
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { cancelWorkflowRun, isGitHubActionsConfigured } from '@/lib/github-actions';
import { parseAccessToken } from '@/lib/auth-utils';
import { handleAutoUpdateJobCompletion } from '@/lib/auto-update/cleanup';
import type { PackagingJob } from '@/lib/db/types';

interface CancelRequestBody {
  jobId: string;
  dismiss?: boolean;
}

// is_auto_update only exists in the Supabase schema; the sqlite adapter has no
// such column, so read it defensively rather than through the shared type.
function isAutoUpdateJob(job: PackagingJob): boolean {
  return Boolean((job as PackagingJob & { is_auto_update?: boolean }).is_auto_update);
}

// Statuses that can be cancelled (active jobs)
const CANCELLABLE_STATUSES = ['queued', 'packaging', 'uploading'];
// Statuses that can be force-dismissed by the user
const DISMISSABLE_STATUSES = ['queued', 'packaging', 'uploading', 'completed', 'failed'];

export async function POST(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const userId = user.userId;
    const userEmail = user.userEmail;

    // Parse request body
    const body: CancelRequestBody = await request.json();
    const { jobId, dismiss } = body;

    if (!jobId) {
      return NextResponse.json(
        { error: 'jobId is required' },
        { status: 400 }
      );
    }

    // Use the database adapter so this works in both sqlite and Supabase modes
    const db = getDatabase();

    // Fetch the job to verify ownership and check status
    const typedJob = await db.jobs.getById(jobId);

    if (!typedJob) {
      return NextResponse.json(
        { error: 'Job not found' },
        { status: 404 }
      );
    }

    // Verify the user owns this job
    if (typedJob.user_id !== userId) {
      return NextResponse.json(
        { error: 'You do not have permission to cancel this job' },
        { status: 403 }
      );
    }

    // If dismiss is set for a terminal job, soft-archive it. The row remains
    // available to upload history and update-policy audit references.
    const terminalStatuses = ['completed', 'failed', 'cancelled', 'duplicate_skipped', 'deployed'];
    if (dismiss && terminalStatuses.includes(typedJob.status)) {
      // Run auto-update cleanup before deleting (defense-in-depth for stuck jobs)
      if (isAutoUpdateJob(typedJob)) {
        const dismissStatus = (typedJob.status === 'deployed' || typedJob.status === 'duplicate_skipped')
          ? typedJob.status as 'deployed' | 'duplicate_skipped'
          : 'cancelled';
        await handleAutoUpdateJobCompletion(jobId, dismissStatus).catch((err) => {
          console.error('[Cancel] Auto-update cleanup error on dismiss:', err);
        });
      }
      await db.jobs.deleteById(jobId);
      return NextResponse.json({
        success: true,
        message: 'Job dismissed',
        jobId,
        archived: true,
      });
    }

    // Check if job is already cancelled or deployed (cannot be modified)
    if (typedJob.status === 'cancelled') {
      return NextResponse.json({
        success: true,
        message: 'Job is already cancelled',
        jobId,
        githubCancelled: null,
      });
    }

    if (typedJob.status === 'deployed') {
      return NextResponse.json(
        { error: 'Cannot cancel a deployed job. It is already in Intune.' },
        { status: 400 }
      );
    }

    // Check if job can be dismissed
    if (!DISMISSABLE_STATUSES.includes(typedJob.status)) {
      return NextResponse.json(
        { error: `Job cannot be cancelled. Current status: ${typedJob.status}` },
        { status: 400 }
      );
    }

    // Attempt to cancel GitHub workflow if run ID exists and job is still active
    let githubCancelResult = null;
    const isActiveJob = CANCELLABLE_STATUSES.includes(typedJob.status);
    if (isActiveJob && isGitHubActionsConfigured()) {
      if (!typedJob.github_run_id) {
        return NextResponse.json(
          {
            error: 'This workflow run could not be identified, so cancellation cannot be confirmed. Refresh and try again shortly.',
            retryable: true,
          },
          { status: 409 },
        );
      }

      githubCancelResult = await cancelWorkflowRun(typedJob.github_run_id);
      if (!githubCancelResult.success) {
        const status = githubCancelResult.status === 'error' ? 502 : 409;
        return NextResponse.json(
          {
            error: githubCancelResult.message,
            githubCancelled: false,
            retryable: githubCancelResult.status === 'error',
          },
          { status },
        );
      }
    }

    // Update the database only after GitHub accepted cancellation (or when the
    // job is handled by the local packager and no GitHub run exists).
    let errorMessage = 'Job cancelled by user';
    if (!isActiveJob) {
      errorMessage = `Job dismissed by user (was ${typedJob.status})`;
    }

    // Use token email, or fall back to job's stored user_email
    const cancelledByEmail = userEmail || typedJob.user_email || 'unknown';

    const fullUpdateData: Partial<PackagingJob> = {
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancelled_by: cancelledByEmail,
      updated_at: new Date().toISOString(),
      error_message: errorMessage,
    };

    // Optimistic lock for active jobs prevents a race with the packager.
    // Non-active jobs need no status condition: the checks above already
    // returned early for 'cancelled' and 'deployed', which is exactly what
    // the previous .not('status','in',...) filter excluded.
    const updated = await db.jobs.update(
      jobId,
      fullUpdateData,
      isActiveJob ? { status: typedJob.status } : undefined
    );

    if (!updated) {
      return NextResponse.json(
        { error: 'Failed to update job status. The job may have already changed status.' },
        { status: 500 }
      );
    }

    // Clean up auto-update tracking
    handleAutoUpdateJobCompletion(jobId, 'cancelled', errorMessage).catch((err) => {
      console.error('[Cancel] Auto-update cleanup error:', err);
    });

    return NextResponse.json({
      success: true,
      message: 'Job cancelled successfully',
      jobId,
      githubCancelled: githubCancelResult?.success ?? null,
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
