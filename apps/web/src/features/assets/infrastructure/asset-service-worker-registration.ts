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

function waitForActivation(worker: ServiceWorker, timeoutMs = 10_000): Promise<void> {
  if (worker.state === 'activated') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Assets Service Worker activation timed out.'));
    }, timeoutMs);
    function cleanup() {
      window.clearTimeout(timeout);
      worker.removeEventListener('statechange', onStateChange);
    }
    function onStateChange() {
      if (worker.state === 'activated') {
        cleanup();
        resolve();
      } else if (worker.state === 'redundant') {
        cleanup();
        reject(new Error('Assets Service Worker became redundant before activation.'));
      }
    }
    worker.addEventListener('statechange', onStateChange);
  });
}

function waitForController(expectedScriptUrl: string, timeoutMs = 10_000): Promise<void> {
  if (navigator.serviceWorker.controller?.scriptURL === expectedScriptUrl) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Assets Service Worker did not take control of the page.'));
    }, timeoutMs);
    function cleanup() {
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    }
    function onControllerChange() {
      if (navigator.serviceWorker.controller?.scriptURL === expectedScriptUrl) {
        cleanup();
        resolve();
      }
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
  });
}
