/**
 * Version retention: keep only the newest N versions of an app in Intune.
 *
 * Deployments create a new Intune app per version rather than updating one in
 * place, so a frequently-updated app accumulates objects and makes the Intune
 * apps list unusable. This prunes the older ones.
 *
 * Deletion is irreversible - the app object, its assignments, and its install
 * history go with it - so this is deliberately conservative:
 *
 *  - it only ever considers apps carrying IntuneGet's fingerprint, using the
 *    same criteria as the duplicate detector (exact display name + a Winget
 *    marker naming this package, or the source marker). Apps created by any
 *    other means are invisible to it.
 *  - it only runs after a deployment has actually succeeded, so the replacement
 *    is confirmed present before anything old is removed. A failed deployment
 *    prunes nothing.
 *  - it refuses to delete anything still carrying assignments, which would
 *    otherwise silently pull an app away from devices still targeted by it.
 *  - it defaults to a dry run, reporting what it would delete without calling
 *    Graph at all.
 */

import {
  GRAPH_API_BASE,
  fetchWithRetry,
  getServicePrincipalToken,
} from '@/lib/intune/graph-client';
import { compareVersions } from '@/lib/version-compare';

export const INTUNE_APP_SOURCE_MARKER = 'Source: IntuneGet.com';

/** Default number of versions to keep per app, newest first. */
export const DEFAULT_RETENTION_KEEP = 2;

interface GraphApp {
  id: string;
  displayName?: string;
  description?: string;
  displayVersion?: string;
  createdDateTime?: string;
  '@odata.type'?: string;
}

interface GraphAppPage {
  value?: GraphApp[];
  '@odata.nextLink'?: string;
}

export interface RetentionApp {
  id: string;
  displayName: string;
  version: string | null;
  createdDateTime?: string;
  assignmentCount: number;
}

export interface RetentionResult {
  wingetId: string;
  displayName: string;
  keep: number;
  dryRun: boolean;
  /** Versions retained (newest first). */
  kept: RetentionApp[];
  /** Older versions removed, or that would be removed in a dry run. */
  deleted: RetentionApp[];
  /** Older versions left alone, with the reason. */
  skipped: { app: RetentionApp; reason: string }[];
  errors: string[];
}

/** Read the configured retention count; 0 or unset disables pruning. */
export function getRetentionKeep(): number {
  const raw = process.env.INTUNEGET_RETENTION_KEEP;
  if (raw === undefined || raw === '') return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 0;
  return n;
}

/**
 * Dry run unless explicitly disabled. Deletion has to be opted into, so a
 * missing or malformed value can never result in apps being removed.
 */
export function isRetentionDryRun(): boolean {
  return (process.env.INTUNEGET_RETENTION_DRY_RUN || 'true').toLowerCase() !== 'false';
}

/**
 * Same fingerprint test the packager's duplicate detector uses. A description
 * naming this winget id is definitive; otherwise fall back to the source
 * marker, which only identifies the app as IntuneGet's.
 */
function isIntuneGetFingerprint(description: string | undefined, wingetId: string): boolean {
  if (!description) return false;
  const wingetMarker = description.match(/Winget:\s*(\S+)/);
  if (wingetMarker) {
    return Boolean(wingetId) && wingetMarker[1].toLowerCase() === wingetId.toLowerCase();
  }
  return description.includes(INTUNE_APP_SOURCE_MARKER);
}

function graphPathFromNextLink(nextLink: string): string {
  return nextLink.replace(/^https:\/\/graph\.microsoft\.com\/(?:beta|v1\.0)/, '');
}

async function graphGet<T>(token: string, path: string): Promise<T> {
  const response = await fetchWithRetry(`${GRAPH_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Graph GET ${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function countAssignments(token: string, appId: string): Promise<number> {
  try {
    const data = await graphGet<{ value?: unknown[] }>(
      token,
      `/deviceAppManagement/mobileApps/${encodeURIComponent(appId)}/assignments`
    );
    return data.value?.length ?? 0;
  } catch {
    // Unknown assignment state must not be treated as "no assignments", or a
    // transient Graph error could let a still-targeted app be deleted.
    return -1;
  }
}

/**
 * Prune older versions of one app.
 *
 * `displayName` should be the display name the deployment used, since that is
 * what identifies sibling versions of the same app in Intune.
 */
export async function pruneOldVersions(options: {
  tenantId: string;
  wingetId: string;
  displayName: string;
  keep?: number;
  dryRun?: boolean;
}): Promise<RetentionResult> {
  const keep = options.keep ?? getRetentionKeep();
  const dryRun = options.dryRun ?? isRetentionDryRun();

  const result: RetentionResult = {
    wingetId: options.wingetId,
    displayName: options.displayName,
    keep,
    dryRun,
    kept: [],
    deleted: [],
    skipped: [],
    errors: [],
  };

  if (keep < 1) {
    result.errors.push('Retention is disabled (INTUNEGET_RETENTION_KEEP unset or < 1)');
    return result;
  }

  const token = await getServicePrincipalToken(options.tenantId);
  if (!token) {
    result.errors.push('Could not acquire a Graph token for this tenant');
    return result;
  }

  // Collect every Win32 app in the tenant. The collection endpoint rejects a
  // $select of Win32-only fields alongside an isof() filter, so page through
  // unfiltered and narrow by @odata.type here.
  const apps: GraphApp[] = [];
  let path: string | null = '/deviceAppManagement/mobileApps?$top=200';
  try {
    while (path) {
      const page: GraphAppPage = await graphGet<GraphAppPage>(token, path);
      apps.push(...(page.value ?? []));
      path = page['@odata.nextLink'] ? graphPathFromNextLink(page['@odata.nextLink']) : null;
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : 'Failed to list Intune apps');
    return result;
  }

  const wantName = options.displayName.trim().toLowerCase();
  const matches = apps.filter(
    (a) =>
      (a['@odata.type'] || '').endsWith('win32LobApp') &&
      (a.displayName || '').trim().toLowerCase() === wantName &&
      isIntuneGetFingerprint(a.description, options.wingetId)
  );

  if (matches.length <= keep) {
    result.kept = matches.map((a) => ({
      id: a.id,
      displayName: a.displayName || '',
      version: a.displayVersion ?? null,
      createdDateTime: a.createdDateTime,
      assignmentCount: 0,
    }));
    return result;
  }

  // Newest first: by version, falling back to creation time when a version is
  // missing or two objects report the same one.
  const ordered = [...matches].sort((a, b) => {
    const av = a.displayVersion;
    const bv = b.displayVersion;
    if (av && bv) {
      const cmp = compareVersions(bv, av);
      if (cmp !== 0) return cmp;
    }
    return (b.createdDateTime || '').localeCompare(a.createdDateTime || '');
  });

  const toKeep = ordered.slice(0, keep);
  const candidates = ordered.slice(keep);

  for (const a of toKeep) {
    result.kept.push({
      id: a.id,
      displayName: a.displayName || '',
      version: a.displayVersion ?? null,
      createdDateTime: a.createdDateTime,
      assignmentCount: 0,
    });
  }

  for (const a of candidates) {
    const assignmentCount = await countAssignments(token, a.id);
    const entry: RetentionApp = {
      id: a.id,
      displayName: a.displayName || '',
      version: a.displayVersion ?? null,
      createdDateTime: a.createdDateTime,
      assignmentCount,
    };

    if (assignmentCount !== 0) {
      result.skipped.push({
        app: entry,
        reason:
          assignmentCount < 0
            ? 'Could not read assignments; refusing to delete with unknown targeting'
            : `Still has ${assignmentCount} assignment(s)`,
      });
      continue;
    }

    if (dryRun) {
      result.deleted.push(entry);
      continue;
    }

    try {
      const response = await fetchWithRetry(
        `${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${encodeURIComponent(a.id)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(`HTTP ${response.status}`);
      }
      result.deleted.push(entry);
    } catch (error) {
      result.errors.push(
        `Failed to delete ${a.displayName} ${a.displayVersion}: ` +
          (error instanceof Error ? error.message : 'unknown error')
      );
    }
  }

  return result;
}
