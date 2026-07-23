import { initializeDatabaseSafely } from '../infrastructure/database/initialize-database';

import { registerBootstrapRoutes } from './api-compat/bootstrap-routes';
import { CompatibilityRouter, installCompatibilityFetch } from './transport/compatibility-fetch';
import { loadUpstreamMetadata } from './upstream-metadata';

const router = new CompatibilityRouter();
const nativeFetch = installCompatibilityFetch(router);
const upstreamMetadata = loadUpstreamMetadata(nativeFetch);
registerBootstrapRoutes(router, nativeFetch, upstreamMetadata);

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
};
void upstreamMetadata.then((metadata) => {
  globalThis.__PURE_TAVERN__.upstreamVersion = metadata.version;
});

document.documentElement.dataset.pureTavernHook = 'installed';
console.info('[PureTavern Hook] Legacy compatibility runtime installed.');
