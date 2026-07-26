/**
 * On-demand available-update computation for self-hosted sqlite deployments.
 *
 * The Supabase path reads a pre-populated update_check_results table. That
 * table is only a cache of a comparison whose inputs both exist in sqlite
 * already - upload_history (what was deployed, at which version) and the
 * manifest API (the current version). Computing it directly keeps deployed
 * apps visible as out-of-date without needing the extra table or a scheduler.
 *
 * Shared by /api/updates/available (read) and /api/updates/refresh (recount).
 */

import { getDatabase } from '@/lib/db';
import { getFullManifest } from '@/lib/manifest-api';
import { compareVersions } from '@/lib/version-compare';
import { isSelfUpdatingApp } from '@/lib/self-updating-apps';
import type { UploadHistoryRecord } from '@/lib/db/types';
import type {
  AvailableUpdate,
  AutoUpdateHistoryWithPolicy,
  AutoUpdateStatus,
  UpdateType,
} from '@/types/update-policies';

// Bound the outbound manifest lookups so a large deployment history doesn't
// open one connection per app.
const UPDATE_SCAN_CONCURRENCY = 4;

/**
 * Compute available updates directly from deployment history.
 *
 * Used in self-hosted sqlite mode, where update_check_results does not exist.
 * Compares the highest version deployed per app against the current manifest
 * version, which goes through the same self-healing lookup the deploy path
 * uses, so a stale catalog snapshot cannot hide an available update.
 */
export async function computeUpdatesFromHistory(
  userId: string,
  tenantId: string | null,
  criticalOnly: boolean
): Promise<AvailableUpdate[]> {
  // Nothing is classified critical without a vulnerability feed, so a
  // critical-only request has no possible results.
  if (criticalOnly) return [];

  const db = getDatabase();
  const history = await db.uploadHistory.getByUserId(userId, 1000);

  // Keep the highest deployed version per app+tenant: that is what is actually
  // live in Intune, and it is what an available update must be newer than.
  const deployed = new Map<string, UploadHistoryRecord>();
  for (const row of history) {
    if (!row.winget_id) continue;
    if (tenantId && row.intune_tenant_id !== tenantId) continue;
    // Apps that update themselves on the device would otherwise show as
    // permanently outdated, since repackaging them changes nothing. The
    // Supabase path excludes these from detection too.
    if (isSelfUpdatingApp(row.winget_id)) continue;
    const key = `${row.winget_id}:${row.intune_tenant_id ?? ''}`;
    const existing = deployed.get(key);
    if (!existing || compareVersions(row.version, existing.version) > 0) {
      deployed.set(key, row);
    }
  }

  const rows = [...deployed.values()];
  const updates: AvailableUpdate[] = [];
  const now = new Date().toISOString();

  for (let i = 0; i < rows.length; i += UPDATE_SCAN_CONCURRENCY) {
    const batch = rows.slice(i, i + UPDATE_SCAN_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (row) => {
        const manifest = await getFullManifest(row.winget_id);
        return { row, latest: manifest?.Version || null };
      })
    );

    for (const result of results) {
      // A single unresolvable package must not blank out the whole report.
      if (result.status !== 'fulfilled') continue;
      const { row, latest } = result.value;
      if (!latest || !row.version) continue;
      if (compareVersions(latest, row.version) <= 0) continue;

      updates.push({
        id: `${row.winget_id}:${latest}`,
        user_id: userId,
        tenant_id: row.intune_tenant_id ?? '',
        winget_id: row.winget_id,
        intune_app_id: row.intune_app_id,
        display_name: row.display_name || row.winget_id,
        current_version: row.version,
        latest_version: latest,
        is_critical: false,
        detected_at: now,
        notified_at: null,
        dismissed_at: null,
        has_prior_deployment: true,
        is_managed: true,
        policy: null,
      });
    }
  }

  updates.sort((a, b) => a.display_name.localeCompare(b.display_name));
  return updates;
}

/**
 * Derive update history from packaging jobs.
 *
 * The Supabase path reads auto_update_history, which is written by
 * AutoUpdateTrigger. sqlite has no such table, but packaging_jobs already
 * records every deployment of every app - so for each app, each deployment
 * after the first is an update from the previously deployed version to this
 * one. That reconstructs the same history without storing it twice.
 */
export async function computeUpdateHistoryFromJobs(
  userId: string,
  options: { tenantId?: string | null; wingetId?: string | null; status?: string | null } = {}
): Promise<AutoUpdateHistoryWithPolicy[]> {
  const db = getDatabase();
  const jobs = await db.jobs.getByUserId(userId, 1000);

  // Group each app's deployments oldest-first so consecutive pairs describe a
  // version transition.
  const byApp = new Map<string, typeof jobs>();
  for (const job of jobs) {
    if (!job.winget_id) continue;
    if (options.tenantId && job.tenant_id !== options.tenantId) continue;
    if (options.wingetId && job.winget_id !== options.wingetId) continue;
    const key = `${job.winget_id}:${job.tenant_id ?? ''}`;
    const list = byApp.get(key) || [];
    list.push(job);
    byApp.set(key, list);
  }

  const history: AutoUpdateHistoryWithPolicy[] = [];

  for (const [, list] of byApp) {
    const ordered = [...list].sort((a, b) =>
      (a.created_at || '').localeCompare(b.created_at || '')
    );

    for (let i = 1; i < ordered.length; i++) {
      const job = ordered[i];
      const previous = ordered[i - 1];
      // Only a version change is an update; a redeploy of the same version is
      // not, and neither is a job that never produced a version.
      if (!job.version || !previous.version || job.version === previous.version) continue;

      const status = mapJobStatus(job.status);
      if (options.status && status !== options.status) continue;

      history.push({
        id: job.id,
        policy_id: '',
        packaging_job_id: job.id,
        from_version: previous.version,
        to_version: job.version,
        update_type: classifyUpdate(previous.version, job.version),
        status,
        error_message: job.error_message ?? null,
        triggered_at: job.created_at,
        completed_at: job.completed_at ?? null,
        policy: {
          winget_id: job.winget_id,
          tenant_id: job.tenant_id ?? '',
        },
        display_name: job.display_name || job.winget_id,
      });
    }
  }

  history.sort((a, b) => b.triggered_at.localeCompare(a.triggered_at));
  return history;
}

/** Map a packaging job status onto the update-history status vocabulary. */
function mapJobStatus(jobStatus: string): AutoUpdateStatus {
  switch (jobStatus) {
    case 'deployed':
    case 'completed':
    case 'duplicate_skipped':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'packaging':
      return 'packaging';
    case 'uploading':
      return 'deploying';
    default:
      return 'pending';
  }
}

/** Classify a version transition by which segment changed first. */
function classifyUpdate(from: string, to: string): UpdateType {
  const a = (from.match(/\d+/g) || []).map(Number);
  const b = (to.match(/\d+/g) || []).map(Number);
  if ((b[0] ?? 0) !== (a[0] ?? 0)) return 'major';
  if ((b[1] ?? 0) !== (a[1] ?? 0)) return 'minor';
  return 'patch';
}
