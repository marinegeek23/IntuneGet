'use client';

import { useCallback } from 'react';
import { useCartStore } from '@/stores/cart-store';
import { generateDetectionRules, generateInstallCommand, generateUninstallCommand } from '@/lib/detection-rules';
import { DEFAULT_PSADT_CONFIG, getDefaultProcessesToClose } from '@/types/psadt';
import type { NormalizedPackage } from '@/types/winget';

const BATCH_SIZE = 5;

interface BulkAddProgress {
  completed: number;
  total: number;
  current: string;
}

interface BulkAddResult {
  succeeded: string[];
  failed: { id: string; name: string; error: string }[];
}

interface UseBulkAddReturn {
  bulkAdd: (
    packages: NormalizedPackage[],
    onProgress?: (progress: BulkAddProgress) => void
  ) => Promise<BulkAddResult>;
}

export function useBulkAdd(): UseBulkAddReturn {
  const addItemSilent = useCartStore((state) => state.addItemSilent);
  const bulkAdd = useCallback(
    async (
      packages: NormalizedPackage[],
      onProgress?: (progress: BulkAddProgress) => void
    ): Promise<BulkAddResult> => {
      const succeeded: string[] = [];
      const failed: { id: string; name: string; error: string }[] = [];
      let completed = 0;

      // Process in batches
      for (let i = 0; i < packages.length; i += BATCH_SIZE) {
        const batch = packages.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (pkg) => {
            onProgress?.({
              completed,
              total: packages.length,
              current: pkg.name,
            });

            const response = await fetch(
              `/api/winget/manifest?id=${encodeURIComponent(pkg.id)}&arch=x64`
            );

            if (!response.ok) {
              throw new Error('Failed to fetch installers');
            }

            const data = await response.json();
            const installer = data.recommendedInstaller;

            if (!installer) {
              throw new Error('No compatible installer found');
            }

            // The manifest is requested without a version, so it resolves the
            // current one - and `installer` belongs to *that* version, not to
            // pkg.version, which comes from the catalog snapshot and lags
            // upstream. Pairing the two produced a cart entry whose version and
            // SHA256 were from different releases, which dispatch preflight
            // then rejected as not matching the trusted manifest.
            const resolvedVersion: string = data.manifest?.version || pkg.version;

            const detectionRules = generateDetectionRules(installer, pkg.name, pkg.id, resolvedVersion);
            const processesToClose = getDefaultProcessesToClose(pkg.name, installer.type);

            addItemSilent({
              appSource: 'win32',
              wingetId: pkg.id,
              displayName: pkg.name,
              publisher: pkg.publisher,
              description: pkg.description,
              version: resolvedVersion,
              architecture: installer.architecture,
              installScope: installer.scope || 'machine',
              installerType: installer.type,
              nestedInstallerType: installer.nestedInstallerType,
              nestedInstallerPath: installer.nestedInstallerPath,
              manifestDependencies: installer.packageDependencies,
              installerUrl: installer.url,
              installerSha256: installer.sha256,
              installCommand: generateInstallCommand(installer, installer.scope || 'machine'),
              uninstallCommand: generateUninstallCommand(installer, pkg.name),
              detectionRules,
              iconPath: pkg.iconPath,
              psadtConfig: {
                ...DEFAULT_PSADT_CONFIG,
                processesToClose,
                detectionRules,
              },
            });

            return pkg;
          })
        );

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          const pkg = batch[j];
          completed++;

          if (result.status === 'fulfilled') {
            succeeded.push(pkg.name);
          } else {
            failed.push({
              id: pkg.id,
              name: pkg.name,
              error: result.reason instanceof Error ? result.reason.message : 'Unknown error',
            });
          }

          onProgress?.({
            completed,
            total: packages.length,
            current: pkg.name,
          });
        }
      }

      return { succeeded, failed };
    },
    [addItemSilent]
  );

  return { bulkAdd };
}
