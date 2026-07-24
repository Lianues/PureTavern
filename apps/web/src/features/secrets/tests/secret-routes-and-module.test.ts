import { afterEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '@/platform/features/capability-registry';
import { credentialResolverCapability } from '@/platform/features/standard-capabilities';
import { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { AppDatabase } from '@/platform/storage/app-database';
import { AppStorage } from '@/platform/storage/app-storage';
import { initializeStorage } from '@/platform/storage/initialize-storage';

import { SecretService } from '../application/secret-service';
import { MemorySecretStore } from '../infrastructure/resilient-secret-store';
import { registerSecretsLegacyRoutes } from '../legacy/register-routes';
import { secretsFeature } from '../module';

const databases: AppDatabase[] = [];

function createHarness() {
  let nextId = 0;
  const service = new SecretService(new MemorySecretStore(), {
    createId: () => `route-secret-${++nextId}`,
  });
  const router = new CompatibilityRouter();
  registerSecretsLegacyRoutes(router, service);
  return { router, service };
}

async function post(
  router: CompatibilityRouter,
  pathname: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const url = new URL(pathname, 'http://localhost');
  const init: RequestInit = { method: 'POST' };
  if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const request = new Request(url, init);
  const response = await router.dispatch(request, url);
  if (!response) throw new Error(`Route was not handled: ${pathname}`);
  return response;
}

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('Secrets Legacy routes', () => {
  it('covers write/read/find/view/rotate/rename/delete/settings with Legacy DTOs', async () => {
    const { router } = createHarness();
    const settings = await post(router, '/api/secrets/settings');
    await expect(settings.json()).resolves.toEqual({ allowKeysExposure: true });

    const firstResponse = await post(router, '/api/secrets/write', {
      key: 'api_key_openai',
      value: 'first-secret-value',
      label: 'First',
    });
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as { id: string };
    const secondResponse = await post(router, '/api/secrets/write', {
      key: 'api_key_openai',
      value: 'second-secret-value',
      label: 'Second',
    });
    const second = (await secondResponse.json()) as { id: string };

    const stateResponse = await post(router, '/api/secrets/read');
    const state = (await stateResponse.json()) as Record<
      string,
      Array<{ id: string; value: string; label: string; active: boolean }> | null
    >;
    expect(state.api_key_openai).toEqual([
      { id: first.id, value: '*******lue', label: 'First', active: false },
      { id: second.id, value: '*******lue', label: 'Second', active: true },
    ]);
    expect(state.api_key_claude).toBeNull();

    const found = await post(router, '/api/secrets/find', {
      key: 'api_key_openai',
      id: first.id,
    });
    await expect(found.json()).resolves.toEqual({ value: 'first-secret-value' });
    const view = await post(router, '/api/secrets/view');
    await expect(view.json()).resolves.toEqual({ api_key_openai: 'second-secret-value' });

    expect(
      (await post(router, '/api/secrets/rotate', { key: 'api_key_openai', id: first.id })).status,
    ).toBe(204);
    expect(
      (
        await post(router, '/api/secrets/rename', {
          key: 'api_key_openai',
          id: first.id,
          label: 'Primary',
        })
      ).status,
    ).toBe(204);
    expect(
      (await post(router, '/api/secrets/delete', { key: 'api_key_openai', id: first.id })).status,
    ).toBe(204);
    const activeAfterDelete = await post(router, '/api/secrets/find', {
      key: 'api_key_openai',
    });
    await expect(activeAfterDelete.json()).resolves.toEqual({ value: 'second-secret-value' });
  });

  it('returns bounded validation errors and a 404 for missing credentials', async () => {
    const { router } = createHarness();
    const invalid = await post(router, '/api/secrets/write', {
      key: '__proto__',
      value: 'do-not-echo',
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('do-not-echo');

    const missing = await post(router, '/api/secrets/find', { key: 'api_key_openai' });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('Not Found');
  });
});

describe('Secrets feature module', () => {
  it('registers a narrow resolver capability and plaintext diagnostics without values', async () => {
    const database = new AppDatabase(`pure-tavern-secrets-module-${crypto.randomUUID()}`);
    databases.push(database);
    const storage = new AppStorage(database);
    await initializeStorage(storage);
    const router = new CompatibilityRouter();
    const capabilities = new CapabilityRegistry();
    const result = secretsFeature.install({
      router,
      nativeFetch: window.fetch.bind(window),
      records: storage.records.forModule('secrets'),
      blobs: storage.blobs.forModule('secrets'),
      capabilities,
    });

    await post(router, '/api/secrets/write', {
      key: 'api_key_openai',
      value: 'module-secret-value',
      label: 'Module',
    });
    const resolver = capabilities.get(credentialResolverCapability);
    await expect(resolver?.resolveCredential('api_key_openai')).resolves.toBe(
      'module-secret-value',
    );
    expect(result.diagnostics).toMatchObject({
      storage: { status: 'ready', backend: 'indexeddb' },
      security: { atRest: 'plaintext', encrypted: false, sameOriginSecurityBoundary: false },
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain('module-secret-value');
  });
});
