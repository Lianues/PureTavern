import { afterEach, describe, expect, it, vi } from 'vitest';

import { CapabilityRegistry } from '@/platform/features/capability-registry';
import {
  credentialResolverCapability,
  generationProviderCapability,
} from '@/platform/features/standard-capabilities';
import { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { AppDatabase } from '@/platform/storage/app-database';
import { AppStorage } from '@/platform/storage/app-storage';
import { initializeStorage } from '@/platform/storage/initialize-storage';

import { GenerationService } from '../application/generation-service';
import { DirectFetchClient } from '../infrastructure/direct-fetch-client';
import { registerGenerationLegacyRoutes } from '../legacy/register-routes';
import { generationFeature } from '../module';
import { BrowserStreamingGeneration } from '../ports/streaming-generation';

const databases: AppDatabase[] = [];

function createHarness() {
  const nativeFetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'route-model' }] }));
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Route reply' } }] }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof window.fetch;
  const service = new GenerationService(
    {
      async resolveCredential() {
        return 'route-credential';
      },
      async hasCredential() {
        return true;
      },
    },
    new DirectFetchClient(nativeFetch),
    new BrowserStreamingGeneration(),
  );
  const router = new CompatibilityRouter();
  registerGenerationLegacyRoutes(router, service);
  return { router, service, nativeFetch };
}

async function post(
  router: CompatibilityRouter,
  pathname: string,
  body: unknown,
): Promise<Response> {
  const url = new URL(pathname, 'http://localhost');
  const response = await router.dispatch(
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    url,
  );
  if (!response) throw new Error(`Unhandled route: ${pathname}`);
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

describe('Generation Legacy routes', () => {
  it('handles model status, non-stream generation and honest bias maps', async () => {
    const { router } = createHarness();
    const base = {
      chat_completion_source: 'openai',
      reverse_proxy: 'http://127.0.0.1:43123/v1',
      proxy_password: 'route-proxy',
    };
    const status = await post(router, '/api/backends/chat-completions/status', base);
    await expect(status.json()).resolves.toEqual({ data: [{ id: 'route-model' }] });

    const generated = await post(router, '/api/backends/chat-completions/generate', {
      ...base,
      model: 'route-model',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(generated.headers.get('X-Pure-Tavern-Provider')).toBe('direct');
    await expect(generated.json()).resolves.toMatchObject({
      choices: [{ message: { content: 'Route reply' } }],
    });

    const bias = await post(router, '/api/backends/chat-completions/bias?model=ignored', [
      { text: '[7,8]', value: -2 },
      { text: 'not exact', value: 3 },
    ]);
    await expect(bias.json()).resolves.toEqual({ '7': -2, '8': -2 });
  });

  it('returns bounded errors without credentials', async () => {
    const { router } = createHarness();
    const invalid = await post(router, '/api/backends/chat-completions/generate', {
      chat_completion_source: 'unknown',
      proxy_password: 'must-not-echo',
    });
    expect(invalid.status).toBe(400);
    const text = await invalid.text();
    expect(text).not.toContain('must-not-echo');
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'unsupported-source' } });
  });
});

describe('Generation feature module', () => {
  it('registers the 26-source capability and diagnostics after M14', async () => {
    const database = new AppDatabase(`pure-tavern-generation-module-${crypto.randomUUID()}`);
    databases.push(database);
    const storage = new AppStorage(database);
    await initializeStorage(storage);
    const capabilities = new CapabilityRegistry();
    capabilities.register(credentialResolverCapability, {
      async resolveCredential() {
        return 'module-credential';
      },
      async hasCredential() {
        return true;
      },
    });
    const result = generationFeature.install({
      router: new CompatibilityRouter(),
      nativeFetch: vi.fn() as unknown as typeof window.fetch,
      records: storage.records.forModule('generation'),
      blobs: storage.blobs.forModule('generation'),
      capabilities,
    });

    expect(capabilities.get(generationProviderCapability)?.listSources()).toHaveLength(26);
    expect(result.diagnostics).toMatchObject({
      scope: 'chat-completion-only',
      directBrowserRequests: true,
      optionalBackend: true,
      transportModes: ['frontend', 'local-android', 'remote'],
      service: { providerCount: 26, protocolCount: 4 },
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain('module-credential');
  });
});
