'use client';

import { useState, useCallback } from 'react';
import { useCartStore } from '@/stores/cart-store';
import { generateDetectionRules, generateInstallCommand, generateUninstallCommand } from '@/lib/detection-rules';
import { DEFAULT_PSADT_CONFIG, getDefaultProcessesToClose } from '@/types/psadt';
import { toast } from 'sonner';
import type { NormalizedPackage } from '@/types/winget';

interface QuickAddOptions {
  architecture?: string;
}

interface QuickAddResult {
  quickAdd: (e: React.MouseEvent | React.KeyboardEvent) => Promise<void>;
  isLoading: boolean;
}

export function useQuickAdd(
  pkg: NormalizedPackage,
  options: QuickAddOptions = {}
): QuickAddResult {
  const { architecture = 'x64' } = options;
  const [isLoading, setIsLoading] = useState(false);
  const addItem = useCartStore((state) => state.addItem);
  const removeItem = useCartStore((state) => state.removeItem);

  const quickAdd = useCallback(
    async (e: React.MouseEvent | React.KeyboardEvent) => {
      e.stopPropagation();
      setIsLoading(true);

      try {
        // Store apps: no manifest fetch needed, add directly
        if (pkg.appSource === 'store') {
          addItem({
            appSource: 'store',
            wingetId: pkg.packageIdentifier || pkg.id,
            displayName: pkg.name,
            publisher: pkg.publisher,
            description: pkg.description,
            version: pkg.version,
            packageIdentifier: pkg.packageIdentifier || pkg.id,
            installExperience: 'user',
            iconPath: pkg.iconPath,
          });

          toast.success(`${pkg.name} added`, {
            description: 'Microsoft Store app',
            action: {
              label: 'Undo',
              onClick: () => {
                const items = useCartStore.getState().items;
                const addedItem = items.find(
                  (item) => item.wingetId === (pkg.packageIdentifier || pkg.id) && item.version === pkg.version
                );
                if (addedItem) {
                  removeItem(addedItem.id);
                }
              },
            },
          });
          return;
        }

        // Win32 apps: fetch manifest and select best installer
        const response = await fetch(
          `/api/winget/manifest?id=${encodeURIComponent(pkg.id)}&arch=${encodeURIComponent(architecture)}`
        );

        if (!response.ok) {
          throw new Error('Failed to fetch installers');
        }

        const data = await response.json();
        const installer = data.recommendedInstaller;

        if (installer) {
          // The manifest is requested without a version, so it resolves the
          // current release and `installer` belongs to that - not to
          // pkg.version, which comes from the catalog snapshot and lags
          // upstream. Pairing them produced a cart entry whose version and
          // SHA256 were from different releases, rejected by dispatch preflight.
          const resolvedVersion: string = data.manifest?.version || pkg.version;
          const detectionRules = generateDetectionRules(installer, pkg.name, pkg.id, resolvedVersion);
          const processesToClose = getDefaultProcessesToClose(pkg.name, installer.type);

          addItem({
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
            psadtConfig: {
              ...DEFAULT_PSADT_CONFIG,
              processesToClose,
              detectionRules,
            },
          });

          toast.success(`${pkg.name} added`, {
            description: `v${resolvedVersion} -- ${installer.architecture}`,
            action: {
              label: 'Undo',
              onClick: () => {
                const items = useCartStore.getState().items;
                const addedItem = items.find(
                  (item) => item.wingetId === pkg.id && item.version === pkg.version
                );
                if (addedItem) {
                  removeItem(addedItem.id);
                }
              },
            },
          });
        } else {
          toast.error('No compatible installer found', {
            description: `Could not find a suitable installer for ${pkg.name}`,
          });
        }
      } catch (error) {
        console.error('Error adding to cart:', error);
        toast.error('Failed to add app', {
          description: 'Could not fetch package information. Please try again.',
        });
      } finally {
        setIsLoading(false);
      }
    },
    [pkg.id, pkg.name, pkg.publisher, pkg.description, pkg.version, pkg.appSource, pkg.packageIdentifier, pkg.iconPath, architecture, addItem, removeItem]
  );

  return { quickAdd, isLoading };
}
