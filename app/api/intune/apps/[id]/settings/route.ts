/**
 * Intune App Settings API Route
 * Updates assignments and categories on an existing Intune app without repackaging
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantForRequest, hasActiveTenantConsent } from '@/lib/msp/tenant-resolution';
import { getServicePrincipalToken } from '@/lib/intune/graph-client';
import {
  getApp,
  assignToGroups,
  convertToGraphAssignments,
  syncAppCategories,
} from '@/lib/intune-api';
import { parseAccessToken } from '@/lib/auth-utils';
import { getDatabase } from '@/lib/db';
import type { PackageAssignment, IntuneAppCategorySelection } from '@/types/upload';
import type { Json } from '@/types/database';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: intuneAppId } = await params;

    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    // Resolve tenant (MSP-aware)
    const mspTenantId = request.headers.get('X-MSP-Tenant-Id');

    const tenantResolution = await resolveTenantForRequest({
      userId: user.userId,
      tokenTenantId: user.tenantId,
      requestedTenantId: mspTenantId,
    });

    if (tenantResolution.errorResponse) {
      return tenantResolution.errorResponse;
    }

    const tenantId = tenantResolution.tenantId;

    // Verify admin consent
    if (!(await hasActiveTenantConsent(tenantId))) {
      return NextResponse.json(
        { error: 'Admin consent not found. Please complete the admin consent flow.' },
        { status: 403 }
      );
    }

    // Get service principal token
    const graphToken = await getServicePrincipalToken(tenantId);

    if (!graphToken) {
      return NextResponse.json(
        { error: 'Failed to get Graph API token' },
        { status: 500 }
      );
    }

    // Verify the app still exists in Intune
    const existingApp = await getApp(graphToken, intuneAppId);

    if (!existingApp) {
      return NextResponse.json(
        { error: 'App not found in Intune. It may have been deleted. Try redeploying instead.' },
        { status: 404 }
      );
    }

    // Parse request body
    const body = await request.json();
    const {
      assignments,
      categories,
      wingetId,
    } = body as {
      assignments?: PackageAssignment[];
      categories?: IntuneAppCategorySelection[];
      wingetId?: string;
    };

    // Apply assignments
    if (assignments) {
      const graphAssignments = convertToGraphAssignments(assignments);
      await assignToGroups(graphToken, intuneAppId, graphAssignments);
    }

    // Sync categories
    if (categories) {
      await syncAppCategories(graphToken, intuneAppId, categories);
    }

    // Persist updated assignments/categories in the most recent packaging_jobs
    // row. Uses the database adapter so this works in sqlite mode too, where
    // packaging_jobs is one of the two tables that do exist.
    if (wingetId) {
      const db = getDatabase();

      // Resolve via upload_history first: clearing the Uploads list archives
      // job rows, and getByUserId hides archived rows, which would silently
      // stop assignment/category changes from being persisted.
      const history = await db.uploadHistory.getByUserId(user.userId, 1000);
      const deployment = history
        .filter((h) => h.winget_id === wingetId && (h.intune_tenant_id ?? '') === tenantId)
        .sort((a, b) => (b.deployed_at || '').localeCompare(a.deployed_at || ''))[0];

      let latestJob = deployment?.packaging_job_id
        ? await db.jobs.getById(deployment.packaging_job_id)
        : null;

      if (!latestJob?.package_config) {
        const userJobs = await db.jobs.getByUserId(user.userId, 1000);
        latestJob =
          userJobs
            .filter(
              (job) =>
                (job.tenant_id ?? '') === tenantId &&
                job.winget_id === wingetId &&
                job.status === 'deployed' &&
                job.package_config
            )
            .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''))[0] || null;
      }

      if (
        latestJob?.package_config &&
        typeof latestJob.package_config === 'object' &&
        !Array.isArray(latestJob.package_config)
      ) {
        const updatedConfig: Record<string, Json | undefined> = {
          ...(latestJob.package_config as Record<string, Json | undefined>),
        };
        if (assignments) {
          updatedConfig.assignments = assignments as unknown as Json;
        }
        if (categories) {
          updatedConfig.categories = categories as unknown as Json;
        }
        await db.jobs.update(latestJob.id, {
          package_config: updatedConfig as Json,
        });
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update app settings';
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
