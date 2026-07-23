import type { CompatibilityDiagnostics } from '@/platform/legacy/compatibility-router';
import type { UpstreamMetadata } from '@/platform/legacy/upstream-metadata';
import type { StorageBootstrapState } from '@/platform/storage/initialize-storage';

declare global {
  var __PURE_TAVERN__: {
    hookVersion: string;
    upstreamVersion: string;
    upstreamMetadata: Promise<UpstreamMetadata>;
    diagnostics: CompatibilityDiagnostics;
    database: Promise<StorageBootstrapState>;
    features: Record<string, Record<string, unknown>>;
  };
}

export {};
