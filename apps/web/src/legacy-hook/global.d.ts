import type { CompatibilityDiagnostics } from '@/platform/legacy/compatibility-router';
import type { UpstreamMetadata } from '@/platform/legacy/upstream-metadata';
import type { StorageBootstrapState } from '@/platform/storage/initialize-storage';
import type { StoragePersistenceState } from '@/platform/storage/storage-persistence';

declare global {
  var __PURE_TAVERN__: {
    hookVersion: string;
    buildId: string;
    upstreamVersion: string;
    upstreamMetadata: Promise<UpstreamMetadata>;
    diagnostics: CompatibilityDiagnostics;
    database: Promise<StorageBootstrapState>;
    persistence: Promise<StoragePersistenceState>;
    features: Record<string, Record<string, unknown>>;
  };
}

export {};
