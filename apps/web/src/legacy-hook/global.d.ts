import type { SettingsStorageDiagnostics } from '@/features/settings/adapters/resilient-settings-repository';
import type { DatabaseBootstrapState } from '@/infrastructure/database/initialize-database';

import type { CompatibilityDiagnostics } from './transport/compatibility-fetch';
import type { UpstreamMetadata } from './upstream-metadata';

declare global {
  var __PURE_TAVERN__: {
    hookVersion: string;
    upstreamVersion: string;
    upstreamMetadata: Promise<UpstreamMetadata>;
    diagnostics: CompatibilityDiagnostics;
    database: Promise<DatabaseBootstrapState>;
    settingsStorage: SettingsStorageDiagnostics;
    settingsSnapshotStorage: SettingsStorageDiagnostics;
  };
}

export {};
