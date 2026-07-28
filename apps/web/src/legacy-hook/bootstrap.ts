import { installLegacyExtensionInstallDefaultBranch } from '../features/extensions/legacy/install-default-branch';
import { featureModules } from '../features/registry';
import { installFeatureModules } from '../platform/features/feature-module';
import {
  CompatibilityRouter,
  installCompatibilityFetch,
  installCompatibilityXhr,
} from '../platform/legacy/compatibility-router';
import { registerCoreLegacyRoutes } from '../platform/legacy/register-core-routes';
import { loadUpstreamMetadata } from '../platform/legacy/upstream-metadata';
import { APP_VERSION } from '../platform/runtime/app-version';
import { RUNTIME_BUILD_ID } from '../platform/runtime/build-id';
import { installLegacyBranding } from '../platform/runtime/legacy-branding';
import { installLegacyFileAccept } from '../platform/runtime/legacy-file-accept';
import { installReleaseUpdateCheck } from '../platform/runtime/release-update';
import { installRuntimeUpdateWatcher } from '../platform/runtime/runtime-update';
import { appStorage } from '../platform/storage/app-storage';
import { initializeStorageSafely } from '../platform/storage/initialize-storage';
import { storagePersistence } from '../platform/storage/storage-persistence';

const router = new CompatibilityRouter();
const nativeFetch = installCompatibilityFetch(router);
const upstreamMetadata = loadUpstreamMetadata(nativeFetch);
installLegacyBranding(upstreamMetadata);
// 手机上的系统选择器只认 MIME，不放宽的话 .jsonl 之类的扩展名在导入时根本选不中。
installLegacyFileAccept();
// 原版扩展安装弹窗动态创建，使用自有 DOM hook 默认选择 main，不修改 Legacy 上游源码。
installLegacyExtensionInstallDefaultBranch();
registerCoreLegacyRoutes(router, upstreamMetadata);

const features = installFeatureModules(featureModules, {
  router,
  nativeFetch,
  storage: appStorage,
});
installCompatibilityXhr(router);

const database = initializeStorageSafely(appStorage);
void database.then((state) => {
  document.documentElement.dataset.databaseState = state.status;
});

// 不申请的话浏览器可以在磁盘紧张时静默清空整个库。越早申请越好，但不阻塞启动。
const persistence = storagePersistence.ensure();
void persistence.then((state) => {
  document.documentElement.dataset.storagePersistence = state.mode;
});

globalThis.__PURE_TAVERN__ = {
  hookVersion: APP_VERSION,
  buildId: RUNTIME_BUILD_ID,
  upstreamVersion: 'loading',
  upstreamMetadata,
  diagnostics: router.diagnostics,
  database,
  persistence,
  features: features.diagnostics,
};
void upstreamMetadata.then((metadata) => {
  globalThis.__PURE_TAVERN__.upstreamVersion = metadata.version;
});
installRuntimeUpdateWatcher(nativeFetch, RUNTIME_BUILD_ID);
installReleaseUpdateCheck(nativeFetch, APP_VERSION);

document.documentElement.dataset.pureTavernHook = 'installed';
console.info('[PureTavern Hook] Legacy compatibility runtime installed.');
