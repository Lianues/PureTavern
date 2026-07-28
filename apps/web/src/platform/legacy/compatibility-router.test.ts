import { afterEach, describe, expect, it } from 'vitest';

import {
  CompatibilityRouter,
  installCompatibilityFetch,
  installCompatibilityXhr,
  jsonResponse,
  readCompatibilityFormData,
  syncJsonResponse,
} from './compatibility-router';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function requireFile(value: FormDataEntryValue | null): File {
  if (!(value instanceof File)) throw new TypeError('Expected a File form entry.');
  return value;
}

describe('CompatibilityRouter multipart bridge', () => {
  it('preserves the original Unicode File for compatibility fetch routes', async () => {
    const router = new CompatibilityRouter();
    const originalFetch = window.fetch;
    let receivedFile: FormDataEntryValue | null = null;
    router.register('POST', '/api/form-data-probe', async (request) => {
      const form = await readCompatibilityFormData(request);
      receivedFile = form.get('avatar');
      return jsonResponse({ ok: true });
    });
    installCompatibilityFetch(router);
    cleanups.push(() => {
      window.fetch = originalFetch;
    });

    const file = new File(['繁體中文世界書'], '韓國財閥世界觀.json', { type: '' });
    const form = new FormData();
    form.append('avatar', file);
    const response = await window.fetch('/api/form-data-probe', {
      method: 'POST',
      body: form,
    });

    expect(response.ok).toBe(true);
    expect(receivedFile).toBe(file);
    const received = requireFile(receivedFile);
    expect(received.name).toBe('韓國財閥世界觀.json');
    expect(received.type).toBe('');
    await expect(received.text()).resolves.toBe('繁體中文世界書');
  });

  it('preserves the original Unicode File for compatibility XHR routes', async () => {
    const router = new CompatibilityRouter();
    let receivedFile: FormDataEntryValue | null = null;
    router.register('POST', '/api/xhr-form-data-probe', async (request) => {
      const form = await readCompatibilityFormData(request);
      receivedFile = form.get('avatar');
      return jsonResponse({ ok: true });
    });
    cleanups.push(installCompatibilityXhr(router));

    const file = new File(['세계관'], '韓國財閥世界觀.json', { type: '' });
    const form = new FormData();
    form.append('avatar', file);
    const response = await new Promise<{ status: number }>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', new URL('/api/xhr-form-data-probe', window.location.href));
      request.onload = () => resolve({ status: request.status });
      request.onerror = () => reject(new Error('Compatibility XHR unexpectedly failed.'));
      request.send(form);
    });

    expect(response.status).toBe(200);
    expect(receivedFile).toBe(file);
    const received = requireFile(receivedFile);
    expect(received.name).toBe('韓國財閥世界觀.json');
    await expect(received.text()).resolves.toBe('세계관');
  });
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
