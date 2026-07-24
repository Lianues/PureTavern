import { afterEach, describe, expect, it } from 'vitest';

import {
  CompatibilityRouter,
  installCompatibilityXhr,
  jsonResponse,
  syncJsonResponse,
} from './compatibility-router';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('CompatibilityRouter XMLHttpRequest bridge', () => {
  it('routes same-origin Legacy jQuery XHR calls without sending them to the network', async () => {
    const router = new CompatibilityRouter();
    router.register('POST', '/api/xhr-probe', () => jsonResponse({ ok: true }));
    cleanups.push(installCompatibilityXhr(router));

    const result = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', new URL('/api/xhr-probe', window.location.href));
      request.setRequestHeader('Content-Type', 'application/json');
      request.onload = () => {
        resolve({ status: request.status, body: JSON.parse(request.responseText) });
      };
      request.onerror = () => reject(new Error('Compatibility XHR unexpectedly failed.'));
      request.send(JSON.stringify({ probe: true }));
    });

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(router.diagnostics.requests).toMatchObject([
      { method: 'POST', pathname: '/api/xhr-probe', handled: true },
    ]);
  });

  it('routes explicitly registered synchronous Legacy XHR without native network access', () => {
    const router = new CompatibilityRouter();
    router.registerSync('POST', '/api/sync-probe', (body) =>
      syncJsonResponse({ received: JSON.parse(body || '{}') }),
    );
    cleanups.push(installCompatibilityXhr(router));

    const request = new XMLHttpRequest();
    request.open('POST', new URL('/api/sync-probe', window.location.href), false);
    request.setRequestHeader('Content-Type', 'application/json');
    request.send(JSON.stringify({ probe: true }));

    expect(request.status).toBe(200);
    expect(JSON.parse(request.responseText)).toEqual({ received: { probe: true } });
    expect(router.diagnostics.requests).toMatchObject([
      { method: 'POST', pathname: '/api/sync-probe', handled: true },
    ]);
  });
});
