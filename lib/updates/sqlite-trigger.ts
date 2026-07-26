/**
 * Update dispatch for self-hosted sqlite deployments.
 *
 * The Supabase path drives updates through app_update_policies and
 * AutoUpdateTrigger, neither of which exists here. But an update is not a
 * special kind of deployment - it is the same packaging job the normal deploy
 * path creates, for a newer version, reusing the configuration the app was
 * originally deployed with. So this rebuilds the original cart item, swaps in
 * the new version's installer, and queues an ordinary job the packager picks
 * up exactly like any other.
 */

import { getDatabase } from '@/lib/db';
import { getFullManifest, getInstallers } from '@/lib/manifest-api';
import { generateDetectionRules, generateInstallCommand } from '@/lib/detection-rules';
import { compareVersions } from '@/lib/version-compare';
import { isSelfUpdatingApp } from '@/lib/self-updating-apps';
import {
  enforceInstallerPreflight,
  InstallerPreflightError,
} from '@/lib/installer-preflight';
import type { Json } from '@/types/database';
import type { NormalizedInstaller } from '@/types/winget';
import { isStoreCartItem } from '@/types/upload';
import type { CartItem, Win32CartItem } from '@/types/upload';

export interface SqliteUpdateRequest {
  winget_id: string;
  tenant_id: string;
}

export interface SqliteUpdateResult {
  winget_id: string;
  tenant_id: string;
  success: boolean;
  error?: string;
  packaging_job_id?: string;
  from_version?: string;
  to_version?: string;
}

/**
 * Queue an update job for a single app.
 */
async function triggerOne(
  req: SqliteUpdateRequest,
  userId: string,
  userEmail: string | null
): Promise<SqliteUpdateResult> {
  const base: SqliteUpdateResult = {
    winget_id: req.winget_id,
    tenant_id: req.tenant_id,
    success: false,
  };
  if (isSelfUpdatingApp(req.winget_id)) {
    return {
      ...base,
      error: 'This app updates itself on the device; redeploying it would change nothing',
    };
  }

  const db = getDatabase();

  // Resolve the previous deployment from upload_history, not by scanning
  // packaging_jobs. upload_history is the durable record of what is actually
  // deployed; job rows are soft-archived whenever the user clears the Uploads
  // list, and treating that cosmetic cleanup as "this app was never deployed"
  // would silently make its updates impossible.
  const history = await db.uploadHistory.getByUserId(userId, 1000);
  const deployment = history
    .filter((h) => h.winget_id === req.winget_id && (h.intune_tenant_id ?? '') === req.tenant_id)
    .sort((a, b) => (b.deployed_at || '').localeCompare(a.deployed_at || ''))[0];

  if (!deployment) {
    return { ...base, error: 'No previous deployment found to update' };
  }

  // The originating job holds the configuration the app was deployed with
  // (install commands, PSADT settings, assignments, categories). getById does
  // not filter archived rows, so a cleared Uploads list stays updatable.
  let previous = deployment.packaging_job_id
    ? await db.jobs.getById(deployment.packaging_job_id)
    : null;

  // Older history rows may predate packaging_job_id, or point at a job that was
  // hard-deleted. Fall back to the newest job for this app that still carries a
  // config, archived or not.
  if (!previous?.package_config) {
    const jobs = await db.jobs.getByUserId(userId, 1000);
    previous =
      jobs
        .filter(
          (j) =>
            j.winget_id === req.winget_id &&
            (j.tenant_id ?? '') === req.tenant_id &&
            j.status === 'deployed' &&
            j.package_config
        )
        .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''))[0] || null;
  }

  if (!previous?.package_config) {
    return {
      ...base,
      error:
        'The original deployment configuration for this app is no longer available. ' +
        'Remove it from Intune and deploy it again from the catalog.',
    };
  }

  const storedConfig = previous.package_config as unknown as CartItem | null;
  if (!storedConfig) {
    return { ...base, error: 'The previous deployment has no saved configuration to reuse' };
  }
  if (isStoreCartItem(storedConfig)) {
    return {
      ...base,
      error: 'Store apps update themselves through the Microsoft Store and cannot be redeployed',
    };
  }
  const previousConfig = storedConfig as Win32CartItem;

  const manifest = await getFullManifest(req.winget_id);
  if (!manifest?.Version) {
    return { ...base, error: 'Could not resolve the current version from the WinGet manifest' };
  }

  const latestVersion = manifest.Version;
  base.from_version = deployment.version;
  base.to_version = latestVersion;

  if (compareVersions(latestVersion, deployment.version) <= 0) {
    return { ...base, error: `Already at the latest version (${deployment.version})` };
  }

  // Match the architecture and scope the app was originally deployed with, so
  // an update cannot silently switch a machine-scope x64 app to something else.
  const installers = await getInstallers(req.winget_id, latestVersion);
  if (installers.length === 0) {
    return { ...base, error: `No installers published for ${latestVersion}` };
  }

  const wantArch = (previousConfig.architecture || 'x64').toLowerCase();
  const wantScope = (previousConfig.installScope || 'machine').toLowerCase();

  // Architecture must match exactly. Falling back to "any installer" could
  // quietly replace an x64 deployment with an x86 (or arm64) build, which is a
  // different product on the device - better to refuse and let the user
  // redeploy deliberately. Scope is allowed to fall back, since many manifests
  // publish a single installer usable at either scope.
  const archMatches = installers.filter((i) => i.architecture?.toLowerCase() === wantArch);
  if (archMatches.length === 0) {
    return {
      ...base,
      error:
        `${latestVersion} does not publish a ${wantArch} installer ` +
        `(this app is deployed as ${wantArch}). Redeploy it from the catalog to change architecture.`,
    };
  }

  const installer: NormalizedInstaller | undefined =
    archMatches.find((i) => (i.scope || '').toLowerCase() === wantScope) || archMatches[0];

  if (!installer?.url || !installer.sha256) {
    return {
      ...base,
      error: `No ${wantArch} installer with a trusted hash published for ${latestVersion}`,
    };
  }

  // Detection rules embed the version (the PSADT registry marker compares
  // against it), so carrying the old rules forward would leave Intune checking
  // for the previous version. Regenerate them for the new version.
  const detectionRules = generateDetectionRules(
    installer,
    previousConfig.displayName || req.winget_id,
    req.winget_id,
    latestVersion
  );

  // An update is intentionally a second app with the same name and winget id,
  // so the packager's tenant-wide duplicate guard has to be told this is
  // deliberate (forceCreate) - otherwise every update is rejected as a
  // duplicate of the app it is replacing. Pointing sourceIntuneAppId at the
  // app being replaced and setting both assignment-migration flags makes the
  // new version take over targeting and strips it from the old app, so devices
  // move to the new version instead of both apps staying assigned.
  const updateMetadata = {
    forceCreate: true,
    sourceIntuneAppId: deployment.intune_app_id || previous.intune_app_id || undefined,
    carryOverAssignments: true,
    removeAssignmentsFromPreviousApp: true,
  };

  const item = {
    ...previousConfig,
    ...updateMetadata,
    version: latestVersion,
    architecture: installer.architecture || previousConfig.architecture,
    installerType: installer.type || previousConfig.installerType,
    installerUrl: installer.url,
    installerSha256: installer.sha256,
    installScope: (installer.scope as Win32CartItem['installScope']) || previousConfig.installScope,
    installCommand: generateInstallCommand(installer, previousConfig.installScope || 'machine'),
    detectionRules,
    psadtConfig: previousConfig.psadtConfig
      ? { ...previousConfig.psadtConfig, detectionRules }
      : previousConfig.psadtConfig,
  } as Win32CartItem & typeof updateMetadata;

  // Same trusted-installer gate the normal deploy path enforces. An update must
  // not bypass verification just because the app was trusted at an older
  // version.
  try {
    await enforceInstallerPreflight({
      wingetId: item.wingetId,
      version: item.version,
      architecture: item.architecture,
      installerUrl: item.installerUrl,
      installerSha256: item.installerSha256,
      installerType: item.installerType,
      installScope: item.installScope,
      sourceType: item.sourceType,
    });
  } catch (error) {
    if (error instanceof InstallerPreflightError) {
      return { ...base, error: error.message };
    }
    throw error;
  }

  const jobId = crypto.randomUUID();
  const created = await db.jobs.create({
    id: jobId,
    user_id: userId,
    user_email: userEmail,
    tenant_id: req.tenant_id,
    winget_id: item.wingetId,
    version: item.version,
    display_name: item.displayName,
    publisher: item.publisher,
    architecture: item.architecture,
    installer_type: item.installerType,
    installer_url: item.installerUrl,
    installer_sha256: item.installerSha256,
    install_command: item.installCommand,
    uninstall_command: item.uninstallCommand,
    install_scope: item.installScope,
    detection_rules: item.detectionRules as unknown as Json,
    package_config: item as unknown as Json,
    status: 'queued',
    progress_percent: 0,
  });

  if (!created) {
    return { ...base, error: 'Failed to create the packaging job' };
  }

  return { ...base, success: true, packaging_job_id: jobId };
}

/**
 * Queue update jobs for a batch of apps. Failures are per-app: one app that
 * cannot be updated must not prevent the rest of the batch from going out.
 */
export async function triggerUpdatesSqlite(
  requests: SqliteUpdateRequest[],
  userId: string,
  userEmail: string | null
): Promise<SqliteUpdateResult[]> {
  const results: SqliteUpdateResult[] = [];
  for (const req of requests) {
    try {
      results.push(await triggerOne(req, userId, userEmail));
    } catch (error) {
      results.push({
        winget_id: req.winget_id,
        tenant_id: req.tenant_id,
        success: false,
        error: error instanceof Error ? error.message : 'Update failed',
      });
    }
  }
  return results;
}
