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

  it('downloads the GitHub default branch through jsDelivr HEAD without GitHub REST', async () => {
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
            size: file.data.size,
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
