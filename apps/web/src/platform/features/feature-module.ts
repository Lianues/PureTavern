import type { CompatibilityRouter } from '../legacy/compatibility-router';
import type { AppStorage, ModuleBlobStore, ModuleRecordStore } from '../storage/app-storage';
import { CapabilityRegistry } from './capability-registry';

export interface FeatureInstallContext {
  router: CompatibilityRouter;
  nativeFetch: typeof window.fetch;
  records: ModuleRecordStore;
  blobs: ModuleBlobStore;
  capabilities: CapabilityRegistry;
}

export interface FeatureInstallResult {
  diagnostics?: Record<string, unknown>;
}

export interface FeatureModule {
  id: string;
  install(context: FeatureInstallContext): FeatureInstallResult;
}

export interface FeatureRuntimeContext {
  router: CompatibilityRouter;
  nativeFetch: typeof window.fetch;
  storage: AppStorage;
}

export function installFeatureModules(
  modules: readonly FeatureModule[],
  context: FeatureRuntimeContext,
) {
  const diagnostics: Record<string, Record<string, unknown>> = {};
  const capabilities = new CapabilityRegistry();

  for (const feature of modules) {
    if (diagnostics[feature.id]) {
      throw new Error(`Feature module is registered more than once: ${feature.id}`);
    }
    const result = feature.install({
      router: context.router,
      nativeFetch: context.nativeFetch,
      records: context.storage.records.forModule(feature.id),
      blobs: context.storage.blobs.forModule(feature.id),
      capabilities,
    });
    diagnostics[feature.id] = result.diagnostics ?? {};
  }

  return { diagnostics, capabilities };
}
