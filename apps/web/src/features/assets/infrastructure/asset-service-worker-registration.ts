import { RUNTIME_BUILD_ID } from '@/platform/runtime/build-id';

const ASSET_WORKER_PATH = `/pure-tavern-assets-service-worker.js?v=${encodeURIComponent(RUNTIME_BUILD_ID)}`;

export async function registerAssetServiceWorker(): Promise<'ready' | 'skipped'> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'skipped';
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:')
    return 'skipped';

  const expectedScriptUrl = new URL(ASSET_WORKER_PATH, window.location.href).href;
  const registration = await navigator.serviceWorker.register(ASSET_WORKER_PATH, {
    scope: '/',
    updateViaCache: 'none',
  });
  await registration.update().catch(() => undefined);
  const candidate = registration.installing ?? registration.waiting ?? registration.active;
  if (candidate && candidate.scriptURL === expectedScriptUrl && candidate.state !== 'activated') {
    await waitForActivation(candidate);
  }

  await navigator.serviceWorker.ready;
  await waitForController(expectedScriptUrl);
  return 'ready';
}

function waitForActivation(worker: ServiceWorker, timeoutMs = 5_000): Promise<void> {
  if (worker.state === 'activated') return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(done, timeoutMs);
    function done() {
      window.clearTimeout(timeout);
      worker.removeEventListener('statechange', onStateChange);
      resolve();
    }
    function onStateChange() {
      if (worker.state === 'activated' || worker.state === 'redundant') done();
    }
    worker.addEventListener('statechange', onStateChange);
  });
}

function waitForController(expectedScriptUrl: string, timeoutMs = 5_000): Promise<void> {
  if (navigator.serviceWorker.controller?.scriptURL === expectedScriptUrl) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(done, timeoutMs);
    function done() {
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      resolve();
    }
    function onControllerChange() {
      if (navigator.serviceWorker.controller?.scriptURL === expectedScriptUrl) done();
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
  });
}
