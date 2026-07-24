import { afterEach, describe, expect, it } from 'vitest';

import {
  CompatibilityRouter,
  installCompatibilityXhr,
  jsonResponse,
  syncJsonResponse,
} from './compatibility-router';
import { registerCoreLegacyRoutes } from './register-core-routes';

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

  it('keeps discarded stats update as a narrow non-migrated boundary', async () => {
    const router = new CompatibilityRouter();
    registerCoreLegacyRoutes(
      router,
      Promise.resolve({
        project: 'SillyTavern',
        version: '1.18.0',
        upstreamRepository: 'https://example.test/upstream',
        syncedAt: '2026-07-24T00:00:00.000Z',
        fileCount: 591,
      }),
    );

    const statsUrl = new URL('/api/stats/update', window.location.href);
    const statsResponse = await router.dispatch(
      new Request(statsUrl, { method: 'POST', body: '{}' }),
      statsUrl,
    );
    expect(statsResponse?.status).toBe(200);
    expect(await statsResponse?.text()).toBe('');
  });
});
