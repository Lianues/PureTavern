import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(
  scriptsDirectory,
  '../src/features/assets/infrastructure/pure-tavern-assets-service-worker.js',
);

describe('shared Assets Service Worker', () => {
  it('opens the existing Dexie database without owning a native schema version', async () => {
    const source = await readFile(workerPath, 'utf8');

    expect(source).toContain('indexedDB.open(DATABASE_NAME);');
    expect(source).not.toMatch(/indexedDB\.open\(DATABASE_NAME\s*,/u);
    expect(source).not.toContain('createObjectStore');
  });

  it('covers all browser resource namespaces without a second Characters worker', async () => {
    const source = await readFile(workerPath, 'utf8');

    for (const namespace of [
      '/thumbnail',
      '/backgrounds/',
      '/User Avatars/',
      '/user/files/',
      '/user/images/',
      '/characters/',
      '/assets/',
      '/scripts/extensions/third-party/',
    ]) {
      expect(source).toContain(namespace);
    }
    expect(source).toContain("[CHARACTERS_MODULE, 'avatars', avatarFile]");
    expect(source).toContain("[ASSETS_MODULE, 'path-aliases', legacyPath]");
    expect(source).toContain("return 'assets/extensions'");
    expect(source).toContain("const WORKER_VERSION = '3'");
    expect(source).toContain("const RUNTIME_CACHE_PREFIX = 'pure-tavern-runtime-'");
    expect(source).toContain("data.type !== 'warm-runtime-cache'");
    expect(source).toContain("cache: 'force-cache'");
    expect(source).toContain("pathname.startsWith('/api/')");
    expect(source).toContain("segment === '..'");
    expect(source).not.toContain("segment.startsWith('.')");
    expect(source).not.toContain("segment.includes('..')");
  });

  it('serves code cache-first within one Build ID and switches namespaces without stale reuse', async () => {
    const harness = await createWorkerHarness('build-alpha-0001');
    harness.cacheNames.add('pure-tavern-runtime-obsolete-0001');
    await harness.dispatchActivate();
    expect(harness.cacheNames).not.toContain('pure-tavern-runtime-obsolete-0001');

    const first = await harness.dispatchFetch(
      'https://pure-tavern.local/scripts/app.js?__pt_build=build-alpha-0001',
    );
    expect(await first?.text()).toBe('network:/scripts/app.js');
    expect(harness.networkFetch).toHaveBeenCalledTimes(1);

    const cached = await harness.dispatchFetch('https://pure-tavern.local/scripts/app.js');
    expect(cached?.headers.get('X-Pure-Tavern-Runtime-Cache')).toBe('hit');
    expect(cached?.headers.get('X-Pure-Tavern-Runtime-Build')).toBe('build-alpha-0001');
    expect(await cached?.text()).toBe('network:/scripts/app.js');
    expect(harness.networkFetch).toHaveBeenCalledTimes(1);

    const nextBuild = await harness.dispatchFetch(
      'https://pure-tavern.local/scripts/app.js?__pt_build=build-beta-0002',
    );
    expect(await nextBuild?.text()).toBe('network:/scripts/app.js');
    expect(harness.networkFetch).toHaveBeenCalledTimes(2);
    expect(harness.cacheNames).toContain('pure-tavern-runtime-build-alpha-0001');
    expect(harness.cacheNames).toContain('pure-tavern-runtime-build-beta-0002');

    expect(await harness.dispatchFetch('https://pure-tavern.local/api/settings/get')).toBeNull();
    expect(
      await harness.dispatchFetch('https://pure-tavern.local/__pure_tavern/runtime-version.json'),
    ).toBeNull();
    expect(harness.networkFetch).toHaveBeenCalledTimes(2);
  });

  it('warms only same-origin code/config resources through the existing HTTP cache', async () => {
    const harness = await createWorkerHarness('build-alpha-0001');
    const reply = vi.fn();
    await harness.dispatchMessage(
      {
        type: 'warm-runtime-cache',
        buildId: 'build-alpha-0001',
        urls: [
          'https://pure-tavern.local/style.css?__pt_build=build-alpha-0001',
          'https://pure-tavern.local/backgrounds/large.png',
          'https://pure-tavern.local/api/settings/get',
          'https://cdn.example/external.js',
        ],
      },
      reply,
    );

    expect(harness.networkFetch).toHaveBeenCalledTimes(1);
    expect(harness.networkFetch).toHaveBeenCalledWith(
      'https://pure-tavern.local/style.css?__pt_build=build-alpha-0001',
      expect.objectContaining({ cache: 'force-cache' }),
    );
    expect(reply).toHaveBeenCalledWith({ ok: true, count: 1 });
  });
});

interface TestWorkerEvent {
  request?: Request;
  data?: unknown;
  ports?: Array<{ postMessage(value: unknown): void }>;
  respondWith?(value: Promise<Response>): void;
  waitUntil?(value: Promise<unknown>): void;
}

async function createWorkerHarness(buildId: string) {
  const source = await readFile(workerPath, 'utf8');
  const listeners = new Map<string, (event: TestWorkerEvent) => void>();
  const cacheStores = new Map<string, Map<string, Response>>();
  const cacheNames = new Set<string>();
  const networkFetch = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    return new Response(`network:${url.pathname}`, {
      status: 200,
      headers: { 'Content-Type': contentTypeForPath(url.pathname) },
    });
  });
  const caches = {
    async open(name: string) {
      cacheNames.add(name);
      const store = cacheStores.get(name) ?? new Map<string, Response>();
      cacheStores.set(name, store);
      return {
        async match(request: Request) {
          return store.get(request.url)?.clone();
        },
        async put(request: Request, response: Response) {
          store.set(request.url, response.clone());
        },
      };
    },
    async keys() {
      return [...cacheNames];
    },
    async delete(name: string) {
      cacheStores.delete(name);
      return cacheNames.delete(name);
    },
  };
  const self = {
    location: new URL(
      `https://pure-tavern.local/pure-tavern-assets-service-worker.js?v=${buildId}`,
    ),
    clients: { claim: vi.fn(() => Promise.resolve()) },
    skipWaiting: vi.fn(() => Promise.resolve()),
    addEventListener(type: string, listener: (event: TestWorkerEvent) => void) {
      listeners.set(type, listener);
    },
  };
  runInNewContext(source, {
    self,
    URL,
    Response,
    Request,
    Headers,
    fetch: networkFetch,
    console,
    indexedDB: {},
    caches,
  });

  return {
    cacheNames,
    networkFetch,
    async dispatchActivate() {
      let task: Promise<unknown> = Promise.resolve();
      listeners.get('activate')?.({
        waitUntil(value: Promise<unknown>) {
          task = value;
        },
      });
      await task;
    },
    async dispatchFetch(url: string): Promise<Response | null> {
      let response: Promise<Response> | null = null;
      listeners.get('fetch')?.({
        request: new Request(url),
        respondWith(value: Promise<Response>) {
          response = value;
        },
      });
      return response ? await response : null;
    },
    async dispatchMessage(data: unknown, reply: (value: unknown) => void) {
      let task: Promise<unknown> = Promise.resolve();
      listeners.get('message')?.({
        data,
        ports: [{ postMessage: reply }],
        waitUntil(value: Promise<unknown>) {
          task = value;
        },
      });
      await task;
      await Promise.resolve();
    },
  };
}

function contentTypeForPath(pathname: string): string {
  if (pathname.endsWith('.css')) return 'text/css';
  if (pathname.endsWith('.json')) return 'application/json';
  return 'application/javascript';
}
