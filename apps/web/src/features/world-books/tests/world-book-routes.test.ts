import { describe, expect, it } from 'vitest';

import { CompatibilityRouter } from '@/platform/legacy/compatibility-router';

import { WorldBookService } from '../application/world-book-service';
import { MemoryWorldBookRepository } from '../infrastructure/resilient-world-book-repository';
import { registerWorldBooksLegacyRoutes } from '../legacy/register-routes';

function createHarness() {
  const router = new CompatibilityRouter();
  let nextId = 0;
  const service = new WorldBookService(
    new MemoryWorldBookRepository(),
    undefined,
    () => `route-book-${++nextId}`,
  );
  registerWorldBooksLegacyRoutes(router, service);
  return { router, service };
}

async function dispatch(router: CompatibilityRouter, request: Request): Promise<Response> {
  const response = await router.dispatch(request, new URL(request.url));
  if (!response) throw new Error(`Route was not handled: ${request.method} ${request.url}`);
  return response;
}

function postJson(pathname: string, body: unknown): Request {
  return new Request(`https://example.test${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postForm(pathname: string, formData: FormData): Request {
  const request = new Request(`https://example.test${pathname}`, { method: 'POST' });
  // jsdom's multipart Request parser hangs when a File is present. The browser-owned
  // FormData contract is tested here without relying on that environment bug.
  Object.defineProperty(request, 'formData', {
    value: async () => formData,
  });
  return request;
}

describe('World Books Legacy routes', () => {
  it('implements list/get/edit/delete responses and missing-book compatibility', async () => {
    const { router } = createHarness();

    const edit = await dispatch(
      router,
      postJson('/api/worldinfo/edit', {
        name: 'RouteBook',
        data: {
          name: 'Route Display',
          entries: { 0: { uid: 0, key: ['route'], opaque: true } },
          extensions: { routePlugin: 1 },
        },
      }),
    );
    expect(edit.status).toBe(200);
    await expect(edit.json()).resolves.toEqual({ ok: true });

    const list = await dispatch(router, postJson('/api/worldinfo/list', {}));
    await expect(list.json()).resolves.toEqual([
      {
        file_id: 'RouteBook',
        name: 'Route Display',
        extensions: { routePlugin: 1 },
      },
    ]);

    const get = await dispatch(router, postJson('/api/worldinfo/get', { name: 'RouteBook' }));
    await expect(get.json()).resolves.toMatchObject({
      entries: { 0: { opaque: true } },
      extensions: { routePlugin: 1 },
    });

    const missing = await dispatch(
      router,
      postJson('/api/worldinfo/get', { name: 'DoesNotExist' }),
    );
    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toEqual({ entries: {} });

    const deleted = await dispatch(
      router,
      postJson('/api/worldinfo/delete', { name: 'RouteBook' }),
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.text()).resolves.toBe('OK');

    const deleteMissing = await dispatch(
      router,
      postJson('/api/worldinfo/delete', { name: 'RouteBook' }),
    );
    expect(deleteMissing.status).toBe(404);
    await expect(deleteMissing.json()).resolves.toMatchObject({ pureTavern: true });
  });

  it('imports multipart native JSON and prefers convertedData for PNG submissions', async () => {
    const { router, service } = createHarness();
    const nativeData = new FormData();
    nativeData.append(
      'avatar',
      new File([JSON.stringify({ entries: {}, nativeField: true })], 'Native Route.json', {
        type: 'application/json',
      }),
    );
    const nativeResponse = await dispatch(router, postForm('/api/worldinfo/import', nativeData));
    expect(nativeResponse.status).toBe(200);
    await expect(nativeResponse.json()).resolves.toEqual({ name: 'Native Route' });

    const convertedData = new FormData();
    convertedData.append('avatar', new File(['not-json'], 'Converted Route.png'));
    convertedData.append(
      'convertedData',
      JSON.stringify({ entries: [], convertedField: { preserved: true } }),
    );
    const convertedResponse = await dispatch(
      router,
      postForm('/api/worldinfo/import', convertedData),
    );
    expect(convertedResponse.status).toBe(200);
    await expect(convertedResponse.json()).resolves.toEqual({ name: 'Converted Route' });
    await expect(service.getWorldBook('Converted Route')).resolves.toEqual({
      entries: [],
      convertedField: { preserved: true },
    });
  });

  it('returns 400 for malformed requests, invalid documents and missing import files', async () => {
    const { router } = createHarness();
    const invalidDocument = await dispatch(
      router,
      postJson('/api/worldinfo/edit', { name: 'Invalid', data: { entries: false } }),
    );
    expect(invalidDocument.status).toBe(400);

    const malformedJson = await dispatch(
      router,
      new Request('https://example.test/api/worldinfo/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
    );
    expect(malformedJson.status).toBe(400);

    const missingFile = await dispatch(router, postForm('/api/worldinfo/import', new FormData()));
    expect(missingFile.status).toBe(400);
  });
});
