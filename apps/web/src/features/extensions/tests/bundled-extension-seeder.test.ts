import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import type { ModuleRecordStore } from '@/platform/storage/app-storage';

import { ExtensionService } from '../application/extension-service';
import { extractExtensionZip, sha256Hex } from '../application/package-validator';
import {
  createBundledExtensionSeedDiagnostics,
  seedBundledExtensions,
  type BundledExtensionManifestEntry,
} from '../infrastructure/bundled-extension-seeder';
import { MemoryExtensionRegistry } from '../infrastructure/extension-registry';
import { MemoryExtensionPackageAssets } from '../ports/extension-package-assets';
import { FakeExtensionSourceGateway } from './test-helpers';

interface BundledFixture {
  entry: BundledExtensionManifestEntry;
  archive: Blob;
}

class BundledFetchHarness {
  readonly calls: string[] = [];
  readonly failures = new Set<string>();
  readonly archives = new Map<string, Blob>();
  readonly manifest: { version: 1; extensions: BundledExtensionManifestEntry[] };

  constructor(fixtures: readonly BundledFixture[]) {
    this.manifest = { version: 1, extensions: fixtures.map((fixture) => fixture.entry) };
    for (const fixture of fixtures) this.archives.set(fixture.entry.archiveFile, fixture.archive);
  }

  readonly fetch = (async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input), 'https://app.example').pathname;
    this.calls.push(pathname);
    if (pathname === '/__pure_tavern/bundled-extensions/manifest.json') {
      return new Response(JSON.stringify(this.manifest), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const prefix = '/__pure_tavern/bundled-extensions/';
    const archiveFile = decodeURIComponent(pathname.slice(prefix.length));
    if (this.failures.has(archiveFile))
      return new Response('temporarily unavailable', { status: 503 });
    const archive = this.archives.get(archiveFile);
    return archive
      ? new Response(await archive.arrayBuffer())
      : new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('seedBundledExtensions', () => {
  it('imports all snapshots once and never restores an extension the user removes', async () => {
    const fixtures = await createFixtures('a', 'b');
    const bundled = new BundledFetchHarness(fixtures);
    const records = createRecordStoreStub();
    const { service } = createServiceHarness();
    const first = createBundledExtensionSeedDiagnostics();

    await seedBundledExtensions(service, records, bundled.fetch, first, fixedClock);

    expect(first).toEqual({
      status: 'ready',
      installed: 2,
      skipped: 0,
      pending: 0,
      completed: true,
      message: null,
    });
    await expect(service.legacyDiscover()).resolves.toEqual([
      { name: 'third-party/BundleA', type: 'local' },
      { name: 'third-party/BundleB', type: 'local' },
    ]);

    const callsAfterFirstImport = bundled.calls.length;
    const second = createBundledExtensionSeedDiagnostics();
    await seedBundledExtensions(service, records, bundled.fetch, second, fixedClock);
    expect(second).toMatchObject({ status: 'ready', installed: 0, skipped: 0, completed: true });
    expect(bundled.calls).toHaveLength(callsAfterFirstImport);

    await service.removeByLegacyReference('BundleB');
    const afterDelete = createBundledExtensionSeedDiagnostics();
    await seedBundledExtensions(service, records, bundled.fetch, afterDelete, fixedClock);
    expect(bundled.calls).toHaveLength(callsAfterFirstImport);
    await expect(service.legacyDiscover()).resolves.not.toContainEqual({
      name: 'third-party/BundleB',
      type: 'local',
    });
  });

  it('respects an existing extension that already owns the bundled legacy path', async () => {
    const fixture = (await createFixtures('a'))[0]!;
    const bundled = new BundledFetchHarness([fixture]);
    const records = createRecordStoreStub();
    const { service } = createServiceHarness();
    const files = await extractExtensionZip(fixture.archive);
    await service.installSnapshot(
      {
        provider: 'github',
        repositoryUrl: 'https://github.com/example/existing-bundle-a',
        requestedRef: 'main',
        resolvedRef: 'main',
        revision: 'f'.repeat(40),
        folderName: fixture.entry.folderName,
        files,
      },
      'local',
    );

    const diagnostics = createBundledExtensionSeedDiagnostics();
    await seedBundledExtensions(service, records, bundled.fetch, diagnostics, fixedClock);

    expect(diagnostics).toMatchObject({
      status: 'ready',
      installed: 0,
      skipped: 1,
      pending: 0,
      completed: true,
    });
    const userExtensions = (await service.list()).filter(
      (extension) => extension.trust === 'user-approved-legacy',
    );
    expect(userExtensions).toHaveLength(1);
    expect(userExtensions[0]?.source).toMatchObject({
      repositoryUrl: 'https://github.com/example/existing-bundle-a',
    });
  });

  it('persists successful items and retries only a package that failed during first import', async () => {
    const fixtures = await createFixtures('a', 'b', 'c');
    const bundled = new BundledFetchHarness(fixtures);
    bundled.failures.add('bundle-b.zip');
    const records = createRecordStoreStub();
    const { service } = createServiceHarness();
    const first = createBundledExtensionSeedDiagnostics();

    await seedBundledExtensions(service, records, bundled.fetch, first, fixedClock);

    expect(first).toMatchObject({
      status: 'error',
      installed: 2,
      skipped: 0,
      pending: 1,
      completed: false,
    });
    expect(first.message).toContain('HTTP 503');
    expect(countCalls(bundled, 'bundle-a.zip')).toBe(1);
    expect(countCalls(bundled, 'bundle-b.zip')).toBe(1);
    expect(countCalls(bundled, 'bundle-c.zip')).toBe(1);

    bundled.failures.clear();
    const resumed = createBundledExtensionSeedDiagnostics();
    await seedBundledExtensions(service, records, bundled.fetch, resumed, fixedClock);

    expect(resumed).toEqual({
      status: 'ready',
      installed: 1,
      skipped: 0,
      pending: 0,
      completed: true,
      message: null,
    });
    expect(countCalls(bundled, 'bundle-a.zip')).toBe(1);
    expect(countCalls(bundled, 'bundle-b.zip')).toBe(2);
    expect(countCalls(bundled, 'bundle-c.zip')).toBe(1);
    expect(
      (await service.legacyDiscover()).filter((extension) => extension.type === 'local'),
    ).toHaveLength(3);
  });

  it('rejects a bundled archive whose runtime bytes fail SHA-256 validation', async () => {
    const fixture = (await createFixtures('a'))[0]!;
    const bundled = new BundledFetchHarness([fixture]);
    bundled.archives.set(fixture.entry.archiveFile, await flipLastByte(fixture.archive));
    const records = createRecordStoreStub();
    const { service } = createServiceHarness();
    const diagnostics = createBundledExtensionSeedDiagnostics();

    await seedBundledExtensions(service, records, bundled.fetch, diagnostics, fixedClock);

    expect(diagnostics).toMatchObject({
      status: 'error',
      installed: 0,
      skipped: 0,
      pending: 1,
      completed: false,
    });
    expect(diagnostics.message).toContain('SHA-256 mismatch');
    await expect(service.legacyDiscover()).resolves.toEqual([]);
  });
});

async function createFixtures(...names: string[]): Promise<BundledFixture[]> {
  return Promise.all(names.map((name, index) => createFixture(name, index + 1)));
}

async function createFixture(name: string, revisionDigit: number): Promise<BundledFixture> {
  const folderName = `Bundle${name.toUpperCase()}`;
  const version = `1.0.${revisionDigit}`;
  const archiveFile = `bundle-${name}.zip`;
  const archiveBytes = zipSync({
    [`${folderName}-${version}/manifest.json`]: strToU8(
      JSON.stringify({
        display_name: `Bundled ${name.toUpperCase()}`,
        loading_order: revisionDigit,
        requires: [],
        optional: [],
        js: 'index.js',
        author: 'PureTavern Test',
        version,
      }),
    ),
    [`${folderName}-${version}/index.js`]: strToU8(
      `globalThis.__bundled${name.toUpperCase()} = true;`,
    ),
  });
  const copy = new Uint8Array(archiveBytes.byteLength);
  copy.set(archiveBytes);
  const archive = new Blob([copy.buffer], { type: 'application/zip' });
  return {
    archive,
    entry: {
      id: `bundle-${name}-${version}`,
      repositoryUrl: `https://github.com/example/bundle-${name}`,
      releaseTag: version,
      revision: String(revisionDigit).repeat(40),
      folderName,
      manifestVersion: version,
      archiveFile,
      archiveBytes: archive.size,
      archiveSha256: await sha256Hex(archive),
    },
  };
}

function createServiceHarness() {
  const registry = new MemoryExtensionRegistry();
  const assets = new MemoryExtensionPackageAssets();
  const service = new ExtensionService(
    registry,
    assets,
    new FakeExtensionSourceGateway(),
    fixedClock,
  );
  return { registry, assets, service };
}

function createRecordStoreStub(): ModuleRecordStore {
  const values = new Map<string, unknown>();
  return {
    async get<T>(collection: string, id: string) {
      const value = values.get(`${collection}\u001f${id}`);
      return value === undefined
        ? null
        : { id, value: structuredClone(value) as T, updatedAt: fixedClock().toISOString() };
    },
    async put<T>(collection: string, id: string, value: T) {
      values.set(`${collection}\u001f${id}`, structuredClone(value));
    },
  } as unknown as ModuleRecordStore;
}

async function flipLastByte(blob: Blob): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
  return new Blob([bytes.buffer], { type: blob.type });
}

function countCalls(bundled: BundledFetchHarness, archiveFile: string): number {
  return bundled.calls.filter((path) => path.endsWith(`/${archiveFile}`)).length;
}

function fixedClock(): Date {
  return new Date('2026-07-28T00:00:00.000Z');
}
