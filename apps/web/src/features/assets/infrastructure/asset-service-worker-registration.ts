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
  await warmRuntimeCache(expectedScriptUrl).catch((error: unknown) => {
    console.warn(
      '[PureTavern Assets] Runtime cache warm-up failed; normal browser caching remains available.',
      error,
    );
  });
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

async function warmRuntimeCache(expectedScriptUrl: string): Promise<void> {
  if (document.readyState !== 'complete') {
    await new Promise<void>((resolve) =>
      window.addEventListener('load', () => resolve(), { once: true }),
    );
  }
  const controller = navigator.serviceWorker.controller;
  if (!controller || controller.scriptURL !== expectedScriptUrl) return;

  const urls = [
    ...performance.getEntriesByType('resource').map((entry) => entry.name),
    ...Array.from(
      document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src],link[href]'),
    )
      .map((element) => (element instanceof HTMLScriptElement ? element.src : element.href))
      .filter(Boolean),
  ];
  const channel = new MessageChannel();
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      channel.port1.close();
      reject(new Error('Runtime cache warm-up timed out.'));
    }, 20_000);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      const value = event.data;
      if (
        !value ||
        typeof value !== 'object' ||
        !('ok' in value) ||
        (value as { ok: unknown }).ok !== true
      ) {
        reject(new Error('Runtime cache warm-up was rejected by the Service Worker.'));
        return;
      }
      resolve();
    };
    controller.postMessage({ type: 'warm-runtime-cache', buildId: RUNTIME_BUILD_ID, urls }, [
      channel.port2,
    ]);
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
