import { initializeDatabaseSafely } from '../infrastructure/database/initialize-database';

import { registerBootstrapRoutes } from './api-compat/bootstrap-routes';
import { createLegacySettingsRuntime } from './settings-runtime';
import { CompatibilityRouter, installCompatibilityFetch } from './transport/compatibility-fetch';
import { loadUpstreamMetadata } from './upstream-metadata';

const router = new CompatibilityRouter();
const nativeFetch = installCompatibilityFetch(router);
const upstreamMetadata = loadUpstreamMetadata(nativeFetch);
const settingsRuntime = createLegacySettingsRuntime(nativeFetch);
registerBootstrapRoutes(
  router,
  upstreamMetadata,
  settingsRuntime.service,
  settingsRuntime.snapshots,
);

const database = initializeDatabaseSafely();
void database.then((state) => {
  document.documentElement.dataset.databaseState = state.status;
});

globalThis.__PURE_TAVERN__ = {
  hookVersion: '0.1.0',
  upstreamVersion: 'loading',
  upstreamMetadata,
  diagnostics: router.diagnostics,
  database,
  settingsStorage: settingsRuntime.diagnostics,
  settingsSnapshotStorage: settingsRuntime.snapshotDiagnostics,
};
void upstreamMetadata.then((metadata) => {
  globalThis.__PURE_TAVERN__.upstreamVersion = metadata.version;
});

document.documentElement.dataset.pureTavernHook = 'installed';
console.info('[PureTavern Hook] Legacy compatibility runtime installed.');
