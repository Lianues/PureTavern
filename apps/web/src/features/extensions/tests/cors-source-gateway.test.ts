import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import {
  CorsExtensionSourceGateway,
  ExtensionSourceError,
  parseSourceLocation,
} from '../infrastructure/cors-extension-source';
import type { RemoteExtensionSource } from '../domain/extension';
import { makeLegacyPackage } from './test-helpers';

describe('CORS extension source gateway', () => {
  it('normalizes GitHub, GitLab and direct CORS ZIP URLs', () => {
    expect(parseSourceLocation('https://github.com/Lianues/cocktail.git')).toMatchObject({
      provider: 'github',
      repositoryUrl: 'https://github.com/Lianues/cocktail',
      folderName: 'cocktail',
    });
    expect(parseSourceLocation('https://gitlab.com/group/nested/cocktail.git')).toMatchObject({
      provider: 'gitlab',
      repositoryUrl: 'https://gitlab.com/group/nested/cocktail',
      folderName: 'cocktail',
    });
    expect(parseSourceLocation('https://extensions.example/cocktail.zip')).toMatchObject({
      provider: 'cors-zip',
      folderName: 'cocktail',
    });
    expect(() => parseSourceLocation('https://example.com/repository.git')).toThrow(
      ExtensionSourceError,
    );
  });

  it('downloads GitHub catalogs even when declared file sizes exceed former quotas', async () => {
    const files = makeLegacyPackage();
    const byPath = new Map(files.map((file) => [file.path, file.data]));
    const nativeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.github.com')) {
        return new Response('GitHub REST must not be used during installation', { status: 500 });
      }
      if (url.includes('data.jsdelivr.com') && url.endsWith('/flat')) {
        expect(url).toContain('/Lianues/cocktail@HEAD/flat');
        return json({
          files: files.map((file) => ({
            name: `/${file.path}`,
            hash: `hash-${file.path}`,
            size: file.path === 'index.js' ? 60 * 1024 * 1024 : file.data.size,
          })),
        });
      }
      const match = /cdn\.jsdelivr\.net\/gh\/Lianues\/cocktail@HEAD\/(.+)$/u.exec(url);
      if (match) {
        const path = decodeURIComponent(match[1]!);
        const blob = byPath.get(path);
        return blob ? new Response(blob) : new Response('missing', { status: 404 });
      }
      return new Response('unexpected', { status: 500 });
    });
    const gateway = new CorsExtensionSourceGateway(nativeFetch as typeof fetch);

    const snapshot = await gateway.fetchSnapshot('https://github.com/Lianues/cocktail');

    expect(snapshot).toMatchObject({
      provider: 'github',
      resolvedRef: 'HEAD',
      folderName: 'cocktail',
    });
    expect(
      nativeFetch.mock.calls.every(([input]) => !String(input).includes('api.github.com')),
    ).toBe(true);
    expect(snapshot.files.map((file) => file.path)).toEqual([
      'manifest.json',
      'index.js',
      'style.css',
    ]);
    expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('falls back to one GitHub Tree request when the jsDelivr catalog rejects a large package', async () => {
    const files = makeLegacyPackage();
    const byPath = new Map(files.map((file) => [file.path, file.data]));
    const nativeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('data.jsdelivr.com')) {
        return new Response('package too large', { status: 403, statusText: 'Forbidden' });
      }
      if (url.includes('api.github.com') && url.includes('/git/trees/HEAD?recursive=1')) {
        return json({
          truncated: false,
          tree: [
            ...files.map((file) => ({
              mode: '100644',
              path: file.path,
              sha: `sha-${file.path}`,
              size: file.data.size,
              type: 'blob',
            })),
            {
              mode: '100644',
              path: 'dist/index.js.map',
              sha: 'source-map',
              size: 40 * 1024 * 1024,
              type: 'blob',
            },
          ],
        });
      }
      const match = /cdn\.jsdelivr\.net\/gh\/Lianues\/cocktail@HEAD\/(.+)$/u.exec(url);
      if (match) {
        const blob = byPath.get(decodeURIComponent(match[1]!));
        return blob ? new Response(blob) : new Response('missing', { status: 404 });
      }
      return new Response('unexpected', { status: 500 });
    });
    const gateway = new CorsExtensionSourceGateway(nativeFetch as typeof fetch);

    const snapshot = await gateway.fetchSnapshot('https://github.com/Lianues/cocktail');

    expect(snapshot.files.map((file) => file.path)).toEqual([
      'manifest.json',
      'index.js',
      'style.css',
    ]);
    expect(
      nativeFetch.mock.calls.filter(([input]) => String(input).includes('api.github.com')),
    ).toHaveLength(1);
    expect(
      nativeFetch.mock.calls.some(([input]) => String(input).includes('raw.githubusercontent')),
    ).toBe(false);
  });

  it('falls back from jsDelivr files to raw.githubusercontent.com without extra REST calls', async () => {
    const files = makeLegacyPackage();
    const byPath = new Map(files.map((file) => [file.path, file.data]));
    const nativeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('data.jsdelivr.com')) {
        return json({
          files: files.map((file) => ({
            name: `/${file.path}`,
            hash: `hash-${file.path}`,
            size: file.data.size,
          })),
        });
      }
      if (url.includes('cdn.jsdelivr.net')) {
        return new Response('CDN unavailable', { status: 503, statusText: 'Unavailable' });
      }
      const match = /raw\.githubusercontent\.com\/Lianues\/cocktail\/HEAD\/(.+)$/u.exec(url);
      if (match) {
        const blob = byPath.get(decodeURIComponent(match[1]!));
        return blob ? new Response(blob) : new Response('missing', { status: 404 });
      }
      return new Response('unexpected', { status: 500 });
    });
    const gateway = new CorsExtensionSourceGateway(nativeFetch as typeof fetch);

    const snapshot = await gateway.fetchSnapshot('https://github.com/Lianues/cocktail');

    expect(snapshot.files).toHaveLength(3);
    expect(nativeFetch.mock.calls.some(([input]) => String(input).includes('api.github.com'))).toBe(
      false,
    );
    expect(
      nativeFetch.mock.calls.filter(([input]) => String(input).includes('raw.githubusercontent')),
    ).toHaveLength(3);
  });

  it('fails safely when both jsDelivr and Raw file sources are unavailable', async () => {
    const files = makeLegacyPackage();
    const nativeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('data.jsdelivr.com')) {
        return json({
          files: files.map((file) => ({
            name: `/${file.path}`,
            hash: `hash-${file.path}`,
            size: file.data.size,
          })),
        });
      }
      if (url.includes('cdn.jsdelivr.net')) return new Response('down', { status: 503 });
      if (url.includes('raw.githubusercontent.com')) return new Response('down', { status: 502 });
      return new Response('unexpected', { status: 500 });
    });
    const gateway = new CorsExtensionSourceGateway(nativeFetch as typeof fetch);

    await expect(
      gateway.fetchSnapshot('https://github.com/Lianues/cocktail'),
    ).rejects.toMatchObject({ code: 'http' });
    expect(
      nativeFetch.mock.calls.some(([input]) => String(input).includes('raw.githubusercontent')),
    ).toBe(true);
  });

  it('rejects truncated GitHub fallback trees and reports REST reset details', async () => {
    const truncatedGateway = new CorsExtensionSourceGateway(
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('data.jsdelivr.com')) return new Response('too large', { status: 403 });
        if (url.includes('api.github.com')) return json({ truncated: true, tree: [] });
        return new Response('unexpected', { status: 500 });
      }) as typeof fetch,
    );
    await expect(
      truncatedGateway.fetchSnapshot('https://github.com/Lianues/cocktail'),
    ).rejects.toMatchObject({ code: 'listing-truncated' });

    const limitedGateway = new CorsExtensionSourceGateway(
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('data.jsdelivr.com')) return new Response('too large', { status: 403 });
        return new Response('limited', {
          status: 403,
          statusText: 'Forbidden',
          headers: {
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': '1893456000',
          },
        });
      }) as typeof fetch,
    );
    await expect(
      limitedGateway.fetchSnapshot('https://github.com/Lianues/cocktail'),
    ).rejects.toThrow(/remaining=0, resets=2030-01-01T00:00:00\.000Z/u);
  });

  it('downloads and unwraps direct CORS ZIP packages', async () => {
    const zip = zipSync({
      'cocktail-main/manifest.json': new TextEncoder().encode(
        JSON.stringify({ display_name: 'Cocktail', version: '1', js: 'index.js' }),
      ),
      'cocktail-main/index.js': new TextEncoder().encode('globalThis.cocktail = true'),
    });
    const nativeFetch = vi.fn(async () => {
      const copy = new Uint8Array(zip.byteLength);
      copy.set(zip);
      return new Response(copy.buffer, { headers: { 'Content-Type': 'application/zip' } });
    });
    const gateway = new CorsExtensionSourceGateway(nativeFetch as typeof fetch);

    const snapshot = await gateway.fetchSnapshot('https://extensions.example/cocktail.zip');

    expect(snapshot.provider).toBe('cors-zip');
    expect(snapshot.files.map((file) => file.path)).toEqual(['manifest.json', 'index.js']);
  });

  it('returns GitHub branches and tags with the current ref marked', async () => {
    const nativeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/branches')) return json([{ name: 'main', commit: { sha: 'abc' } }]);
      if (url.includes('/tags')) return json([{ name: 'v1', commit: { sha: 'def' } }]);
      return new Response('missing', { status: 404 });
    });
    const gateway = new CorsExtensionSourceGateway(nativeFetch as typeof fetch);
    const refs = await gateway.listRefs(remoteSource());

    expect(refs).toEqual([
      { current: true, commit: 'abc', name: 'main', label: 'Branch: main' },
      { current: false, commit: 'def', name: 'v1', label: 'Tag: v1' },
    ]);
  });

  it('reports CORS/network failures without pretending a Git clone succeeded', async () => {
    const gateway = new CorsExtensionSourceGateway(
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
    );
    await expect(
      gateway.fetchSnapshot('https://extensions.example/cocktail.zip'),
    ).rejects.toMatchObject({ code: 'network' });
  });
});

function remoteSource(): RemoteExtensionSource {
  return {
    kind: 'remote',
    provider: 'github',
    repositoryUrl: 'https://github.com/Lianues/cocktail',
    requestedRef: '',
    resolvedRef: 'main',
    revision: 'installed-revision',
    packageHash: 'a'.repeat(64),
    fileCount: 3,
    totalBytes: 100,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
}
