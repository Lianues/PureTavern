export function registerCharacterAvatarServiceWorker(): Promise<unknown> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.resolve('skipped');
  }

  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
    return Promise.resolve('skipped');
  }

  return navigator.serviceWorker
    .register('/characters-service-worker.js', { scope: '/' })
    .then(async () => {
      await navigator.serviceWorker.ready;
      await waitForController();
      return 'ready';
    });
}

function waitForController(timeoutMs = 1500): Promise<void> {
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(done, timeoutMs);
    function done() {
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener('controllerchange', done);
      resolve();
    }
    navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
  });
}
