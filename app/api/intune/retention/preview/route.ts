/**
 * Version Retention Preview
 *
 * Reports what version pruning would remove, without removing anything. Always
 * a dry run regardless of INTUNEGET_RETENTION_DRY_RUN, so it is safe to call at
 * any time to inspect the current state.
 *
 * GET /api/intune/retention/preview            - every app with deployment history
 * GET /api/intune/retention/preview?wingetId=X - a single app
 * GET /api/intune/retention/preview?keep=3     - override the retention count
 */

import { NextRequest, NextResponse } from 'next/server';
import { parseAccessToken } from '@/lib/auth-utils';
import { getDatabase } from '@/lib/db';
import { isSupabaseConfigured, createServerClient } from '@/lib/supabase';
import { resolveTargetTenantId } from '@/lib/msp/tenant-resolution';
import {
  pruneOldVersions,
  getRetentionKeep,
  isRetentionDryRun,
  DEFAULT_RETENTION_KEEP,
} from '@/lib/intune/version-retention';

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    let tenantId = user.tenantId;
    if (isSupabaseConfigured()) {
      const resolution = await resolveTargetTenantId({
        supabase: createServerClient(),
        userId: user.userId,
        tokenTenantId: user.tenantId,
        requestedTenantId: request.headers.get('X-MSP-Tenant-Id'),
      });
      if (resolution.errorResponse) return resolution.errorResponse;
      tenantId = resolution.tenantId;
    }

    const { searchParams } = new URL(request.url);
    const wingetIdFilter = searchParams.get('wingetId');
    const keepParam = searchParams.get('keep');
    const keep = keepParam
      ? Math.max(1, Number.parseInt(keepParam, 10) || DEFAULT_RETENTION_KEEP)
      : getRetentionKeep() || DEFAULT_RETENTION_KEEP;

    // One entry per deployed app, using the display name it was deployed with -
    // that is what identifies sibling versions in Intune.
    const db = getDatabase();
    const history = await db.uploadHistory.getByUserId(user.userId, 1000);
    const apps = new Map<string, { wingetId: string; displayName: string }>();
    for (const row of history) {
      if (!row.winget_id || !row.display_name) continue;
      if ((row.intune_tenant_id ?? '') !== tenantId) continue;
      if (wingetIdFilter && row.winget_id !== wingetIdFilter) continue;
      apps.set(`${row.winget_id}:${row.display_name}`, {
        wingetId: row.winget_id,
        displayName: row.display_name,
      });
    }

    const results = [];
    for (const { wingetId, displayName } of apps.values()) {
      results.push(
        await pruneOldVersions({
          tenantId,
          wingetId,
          displayName,
          keep,
          dryRun: true, // never deletes, whatever the environment says
        })
      );
    }

    const wouldDelete = results.reduce((n, r) => n + r.deleted.length, 0);
    const skipped = results.reduce((n, r) => n + r.skipped.length, 0);

    return NextResponse.json({
      dryRun: true,
      keep,
      // What the post-deploy hook would actually do, so the preview makes the
      // live configuration obvious rather than implying deletion is armed.
      liveConfig: {
        retentionEnabled: getRetentionKeep() >= 1,
        configuredKeep: getRetentionKeep(),
        deletionArmed: !isRetentionDryRun(),
      },
      summary: {
        appsChecked: results.length,
        wouldDelete,
        skipped,
      },
      results,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to preview retention',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
