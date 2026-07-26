import { defineCapability } from '@/platform/features/capability-registry';
import type { FeatureInstallContext, FeatureModule } from '@/platform/features/feature-module';
import { registerArchiveModule } from '@/platform/features/register-archive-module';
import {
  assetServiceWorkerCapability,
  extensionMigrationCapability,
  extensionPackageAssetsCapability,
  legacyExtensionSettingsCapability,
} from '@/platform/features/standard-capabilities';

import { ExtensionService } from './application/extension-service';
import type { ExtensionPackageLimits } from './application/package-validator';
import type { TrustedLegacyBuiltInDefinition } from './domain/extension';
import { CorsExtensionSourceGateway } from './infrastructure/cors-extension-source';
import {
  RecordExtensionRegistry,
  ResilientExtensionRegistry,
} from './infrastructure/extension-registry';
import { registerExtensionsLegacyRoutes } from './legacy/register-routes';
import {
  MissingExtensionPackageAssets,
  type ExtensionPackageAssets,
} from './ports/extension-package-assets';
import type { ExtensionRegistry } from './ports/extension-registry';
import type { ExtensionSourceGateway } from './ports/extension-source-gateway';
import { TRUSTED_LEGACY_BUILTINS } from './trusted-builtins';

export interface ExtensionsRuntimeCapability {
  ready: Promise<void>;
  registry: ExtensionRegistry;
  service: ExtensionService;
}

export const extensionsRuntimeCapability =
  defineCapability<ExtensionsRuntimeCapability>('extensions.runtime');

export interface ExtensionsFeatureOptions {
  packageAssets?: ExtensionPackageAssets;
  createPackageAssets?: (context: FeatureInstallContext) => ExtensionPackageAssets;
  sourceGateway?: ExtensionSourceGateway;
  createSourceGateway?: (context: FeatureInstallContext) => ExtensionSourceGateway;
  trustedBuiltIns?: readonly TrustedLegacyBuiltInDefinition[];
  loadTrustedBuiltIns?: (
    context: FeatureInstallContext,
  ) => Promise<readonly TrustedLegacyBuiltInDefinition[]>;
  packageLimits?: ExtensionPackageLimits;
}

export function createExtensionsFeature(options: ExtensionsFeatureOptions = {}): FeatureModule {
  return {
    id: 'extensions',
    install(context) {
      const { router, records, capabilities } = context;
      registerArchiveModule(context, {
        moduleId: 'extensions',
        displayName: 'Extensions & Plugin Data',
      });
      const registry = new ResilientExtensionRegistry(new RecordExtensionRegistry(records));
      const packageAssets =
        options.createPackageAssets?.(context) ??
        options.packageAssets ??
        new MissingExtensionPackageAssets();
      const sourceGateway =
        options.createSourceGateway?.(context) ??
        options.sourceGateway ??
        new CorsExtensionSourceGateway(context.nativeFetch);
      const service = new ExtensionService(
        registry,
        packageAssets,
        sourceGateway,
        options.packageLimits,
      );
      const seedDiagnostics = {
        status: 'pending' as 'pending' | 'ready' | 'fallback',
        source: options.loadTrustedBuiltIns ? 'generated-manifest' : 'compiled-fallback',
        count: 0,
        message: null as string | null,
      };
      const ready = (async () => {
        await (capabilities.get(assetServiceWorkerCapability)?.ready ?? Promise.resolve());
        let definitions = options.trustedBuiltIns ?? TRUSTED_LEGACY_BUILTINS;
        if (options.loadTrustedBuiltIns) {
          try {
            definitions = await options.loadTrustedBuiltIns(context);
            seedDiagnostics.status = 'ready';
          } catch (error) {
            seedDiagnostics.status = 'fallback';
            seedDiagnostics.source = 'compiled-fallback';
            seedDiagnostics.message = error instanceof Error ? error.message : String(error);
            definitions = TRUSTED_LEGACY_BUILTINS;
          }
        } else {
          seedDiagnostics.status = 'ready';
        }
        seedDiagnostics.count = definitions.length;
        await service.registerTrustedBuiltIns(definitions);
      })();

      const runtime: ExtensionsRuntimeCapability = { ready, registry, service };
      capabilities.register(extensionsRuntimeCapability, runtime);
      capabilities.register(extensionMigrationCapability, {
        buildImportedExtension: (input) => service.buildImportedExtension(input),
      });
      let unknownDisabledLegacyNames: string[] = [];
      capabilities.register(legacyExtensionSettingsCapability, {
        async getDisabledLegacyNames() {
          await ready;
          const disabled = (await registry.list())
            .filter((extension) => !extension.enabled)
            .map((extension) => extension.legacyName);
          return [...new Set([...disabled, ...unknownDisabledLegacyNames])].sort((left, right) =>
            left.localeCompare(right, 'en'),
          );
        },
        async applyDisabledLegacyNames(names) {
          await ready;
          const disabled = new Set(names.filter((name) => typeof name === 'string' && name));
          const installed = await registry.list();
          const knownNames = new Set(installed.map((extension) => extension.legacyName));
          unknownDisabledLegacyNames = [...disabled].filter((name) => !knownNames.has(name));
          for (const extension of installed) {
            if (disabled.has(extension.legacyName)) await service.disable(extension.extensionId);
            else await service.enable(extension.extensionId);
          }
        },
      });
      registerExtensionsLegacyRoutes(router, service, ready);

      return {
        diagnostics: {
          registry: registry.diagnostics,
          localPackageAssetsInjected: Boolean(options.packageAssets || options.createPackageAssets),
          trustedBuiltIns: seedDiagnostics,
          executionModel: 'legacy-same-context-user-approved',
          remoteSources: ['github-jsdelivr-cors', 'gitlab-cors-api', 'direct-cors-zip'],
          originalRiskWarningOwnedByLegacyUi: true,
        },
      };
    },
  };
}

export const extensionsFeature = createExtensionsFeature({
  createPackageAssets({ capabilities }) {
    return (
      capabilities.get(extensionPackageAssetsCapability) ?? new MissingExtensionPackageAssets()
    );
  },
  async loadTrustedBuiltIns({ nativeFetch }) {
    const response = await nativeFetch('/__pure_tavern/trusted-extensions.json', {
      cache: 'no-cache',
    });
    if (!response.ok) {
      throw new Error(`Trusted extension manifest failed to load: HTTP ${response.status}`);
    }
    const manifest = (await response.json()) as { extensions?: unknown };
    if (!Array.isArray(manifest.extensions)) {
      throw new TypeError('Trusted extension manifest does not contain an extensions array.');
    }
    return manifest.extensions as TrustedLegacyBuiltInDefinition[];
  },
});
