import { defineCapability } from '@/platform/features/capability-registry';
import type { FeatureInstallContext, FeatureModule } from '@/platform/features/feature-module';
import {
  extensionPackageAssetsCapability,
  legacyExtensionSettingsCapability,
} from '@/platform/features/standard-capabilities';

import { ExtensionService } from './application/extension-service';
import {
  SandboxProtocolHost,
  type SandboxCapabilityHandler,
  type SandboxEnvelope,
} from './application/sandbox-protocol';
import type { ExtensionPackageFile, ExtensionPackageLimits } from './application/package-validator';
import type {
  ExtensionCapability,
  ExtensionRecord,
  TrustedLegacyBuiltInDefinition,
} from './domain/extension';
import {
  RecordExtensionRegistry,
  ResilientExtensionRegistry,
} from './infrastructure/extension-registry';
import {
  RecordPluginPermissionBroker,
  ResilientPluginPermissionBroker,
} from './infrastructure/plugin-permission-broker';
import { RecordPluginStorage, ResilientPluginStorage } from './infrastructure/plugin-storage';
import { registerExtensionsLegacyRoutes } from './legacy/register-routes';
import {
  MissingExtensionPackageAssets,
  type ExtensionPackageAssets,
} from './ports/extension-package-assets';
import type { ExtensionRegistry } from './ports/extension-registry';
import type { PluginPermissionBroker } from './ports/plugin-permission-broker';
import type { PluginStorage } from './ports/plugin-storage';
import { TRUSTED_LEGACY_BUILTINS } from './trusted-builtins';

export interface SandboxHostConnectionOptions {
  extensionId: string;
  sessionId: string;
  expectedSource: unknown;
  expectedOrigin: string;
  send: (envelope: SandboxEnvelope) => Promise<void> | void;
  timeoutMs?: number;
  capabilityHandlers?: Partial<Record<ExtensionCapability, SandboxCapabilityHandler>>;
}

export interface ExtensionsRuntimeCapability {
  ready: Promise<void>;
  registry: ExtensionRegistry;
  pluginStorage: PluginStorage;
  permissions: PluginPermissionBroker;
  service: ExtensionService;
  installLocalPackage(files: readonly ExtensionPackageFile[]): Promise<ExtensionRecord>;
  registerTrustedBuiltIns(definitions: readonly TrustedLegacyBuiltInDefinition[]): Promise<void>;
  createSandboxHost(options: SandboxHostConnectionOptions): Promise<SandboxProtocolHost>;
}

export const extensionsRuntimeCapability =
  defineCapability<ExtensionsRuntimeCapability>('extensions.runtime');

export interface ExtensionsFeatureOptions {
  packageAssets?: ExtensionPackageAssets;
  createPackageAssets?: (context: FeatureInstallContext) => ExtensionPackageAssets;
  trustedBuiltIns?: readonly TrustedLegacyBuiltInDefinition[];
  loadTrustedBuiltIns?: (
    context: FeatureInstallContext,
  ) => Promise<readonly TrustedLegacyBuiltInDefinition[]>;
  packageLimits?: ExtensionPackageLimits;
  createCapabilityHandlers?: (
    extensionId: string,
  ) => Partial<Record<ExtensionCapability, SandboxCapabilityHandler>>;
}

export function createExtensionsFeature(options: ExtensionsFeatureOptions = {}): FeatureModule {
  return {
    id: 'extensions',
    install(context) {
      const { router, records, capabilities } = context;
      const registry = new ResilientExtensionRegistry(new RecordExtensionRegistry(records));
      const pluginStorage = new ResilientPluginStorage(new RecordPluginStorage(records));
      const permissions = new ResilientPluginPermissionBroker(
        new RecordPluginPermissionBroker(records),
      );
      const packageAssets =
        options.createPackageAssets?.(context) ??
        options.packageAssets ??
        new MissingExtensionPackageAssets();
      const service = new ExtensionService(registry, pluginStorage, permissions, packageAssets);
      const seedDiagnostics = {
        status: 'pending' as 'pending' | 'ready' | 'fallback' | 'error',
        source: options.loadTrustedBuiltIns ? 'generated-manifest' : 'compiled-fallback',
        count: 0,
        message: null as string | null,
      };
      const ready = (async () => {
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

      const runtime: ExtensionsRuntimeCapability = {
        ready,
        registry,
        pluginStorage,
        permissions,
        service,
        async installLocalPackage(files) {
          await ready;
          return service.installLocalPackage(files, options.packageLimits);
        },
        async registerTrustedBuiltIns(definitions) {
          await ready;
          await service.registerTrustedBuiltIns(definitions);
        },
        async createSandboxHost(connection) {
          await ready;
          const plan = await service.getExecutionPlan(connection.extensionId);
          if (plan.mode === 'same-context' || plan.expectedMessageOrigin === null) {
            throw new Error('Sandbox channels are created only for isolated user extensions.');
          }
          if (connection.expectedOrigin !== plan.expectedMessageOrigin) {
            throw new Error(
              `Sandbox origin must match the execution plan: ${plan.expectedMessageOrigin}`,
            );
          }
          const handlers = {
            ...options.createCapabilityHandlers?.(connection.extensionId),
            ...connection.capabilityHandlers,
            'storage:plugin': createPluginStorageHandler(pluginStorage, connection.extensionId),
          };
          return new SandboxProtocolHost({
            extensionId: connection.extensionId,
            sessionId: connection.sessionId,
            expectedSource: connection.expectedSource,
            expectedOrigin: connection.expectedOrigin,
            send: connection.send,
            permissions: {
              check: (extensionId, capability) => service.checkPermission(extensionId, capability),
              list: (extensionId) => permissions.list(extensionId),
              grant: (extensionId, capability) => service.grantPermission(extensionId, capability),
              revoke: (extensionId, capability) =>
                service.revokePermission(extensionId, capability),
              revokeAll: (extensionId) => permissions.revokeAll(extensionId),
            },
            capabilityHandlers: handlers,
            ...(connection.timeoutMs === undefined ? {} : { timeoutMs: connection.timeoutMs }),
          });
        },
      };

      capabilities.register(extensionsRuntimeCapability, runtime);
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
          pluginStorage: pluginStorage.diagnostics,
          permissions: permissions.diagnostics,
          localPackageAssetsInjected: Boolean(options.packageAssets || options.createPackageAssets),
          trustedBuiltIns: seedDiagnostics,
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

function createPluginStorageHandler(
  storage: PluginStorage,
  extensionId: string,
): SandboxCapabilityHandler {
  return async (payload) => {
    if (!isRecord(payload) || typeof payload.operation !== 'string') {
      throw new TypeError('Plugin storage capability payload is invalid.');
    }
    switch (payload.operation) {
      case 'get':
        return storage.get(extensionId, requiredKey(payload));
      case 'put':
        await storage.put(extensionId, requiredKey(payload), payload.value);
        return null;
      case 'delete':
        await storage.delete(extensionId, requiredKey(payload));
        return null;
      case 'list':
        return storage.list(extensionId);
      default:
        throw new TypeError(`Unsupported plugin storage operation: ${payload.operation}`);
    }
  };
}

function requiredKey(payload: Record<string, unknown>): string {
  if (typeof payload.key !== 'string' || !payload.key) {
    throw new TypeError('Plugin storage key is required.');
  }
  return payload.key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
