import { featureModules } from '../features/registry';
import { installFeatureModules } from '../platform/features/feature-module';
import {
  CompatibilityRouter,
  installCompatibilityFetch,
} from '../platform/legacy/compatibility-router';
import { registerCoreLegacyRoutes } from '../platform/legacy/register-core-routes';
import { loadUpstreamMetadata } from '../platform/legacy/upstream-metadata';
import { appStorage } from '../platform/storage/app-storage';
import { initializeStorageSafely } from '../platform/storage/initialize-storage';

const router = new CompatibilityRouter();
const nativeFetch = installCompatibilityFetch(router);
const upstreamMetadata = loadUpstreamMetadata(nativeFetch);
registerCoreLegacyRoutes(router, upstreamMetadata);

const features = installFeatureModules(featureModules, {
  router,
  nativeFetch,
  storage: appStorage,
});

const database = initializeStorageSafely(appStorage);
void database.then((state) => {
  document.documentElement.dataset.databaseState = state.status;
});

globalThis.__PURE_TAVERN__ = {
  hookVersion: '0.1.0',
  upstreamVersion: 'loading',
  upstreamMetadata,
  diagnostics: router.diagnostics,
  database,
  features: features.diagnostics,
};
void upstreamMetadata.then((metadata) => {
  globalThis.__PURE_TAVERN__.upstreamVersion = metadata.version;
});

document.documentElement.dataset.pureTavernHook = 'installed';
console.info('[PureTavern Hook] Legacy compatibility runtime installed.');
