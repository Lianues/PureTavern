import { afterEach, describe, expect, it, vi } from 'vitest';

import { CapabilityRegistry } from '@/platform/features/capability-registry';
import { archiveParticipantRegistryCapability } from '@/platform/features/standard-capabilities';
import { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { AppDatabase } from '@/platform/storage/app-database';
import { AppStorage } from '@/platform/storage/app-storage';
import { initializeStorage } from '@/platform/storage/initialize-storage';

import { LocalBackupTransport } from '../infrastructure/local-backup-transport';
import { MemoryBackupRepository } from '../infrastructure/resilient-backup-repository';
import { createImportExportFeature, dataManagementRuntimeCapability } from '../module';

const databases: AppDatabase[] = [];

async function createHarness() {
  const database = new AppDatabase(`pure-tavern-archive-routes-${crypto.randomUUID()}`);
  databases.push(database);
  const storage = new AppStorage(database);
  await initializeStorage(storage);
  const router = new CompatibilityRouter();
  const capabilities = new CapabilityRegistry();
  const result = createImportExportFeature({
    createBackupTransport: () => new LocalBackupTransport(new MemoryBackupRepository()),
  }).install({
    router,
    nativeFetch: window.fetch.bind(window),
    records: storage.records.forModule('import-export'),
    blobs: storage.blobs.forModule('import-export'),
    capabilities,
  });
  capabilities.get(archiveParticipantRegistryCapability)?.registerModule({
    moduleId: 'settings',
    displayName: 'Settings',
    dataVersion: 1,
    sensitive: false,
    defaultSelected: true,
    records: storage.records.forModule('settings'),
    blobs: storage.blobs.forModule('settings'),
  });
  await storage.records.forModule('settings').put('documents', 'current', { route: true });
  return { router, storage, capabilities, result };
}

async function postJson(
  router: CompatibilityRouter,
  pathname: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  const url = new URL(pathname, 'https://app.example');
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

async function postForm(
  router: CompatibilityRouter,
  pathname: string,
  archive: Blob,
  strategy = 'merge',
  method: string | null = null,
): Promise<Response> {
  const form = {
    get(name: string) {
      if (name === 'file') return archive;
      if (name === 'strategy') return strategy;
      if (name === 'method') return method;
      return null;
    },
  } as FormData;
  const url = new URL(pathname, 'https://app.example');
  const request = { method: 'POST', formData: async () => form } as Request;
  const response = await router.dispatch(request, url);
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

describe('M21 routes and module', () => {
  it('exposes participant, storage and future backend diagnostics', async () => {
    const { result } = await createHarness();
    expect(result.diagnostics).toMatchObject({
      storage: { status: 'ready', backend: 'indexeddb' },
      participants: { count: 1, moduleIds: ['settings'] },
      backupTransport: { kind: 'browser-local', opaqueArchiveStorage: true },
      optionalBackend: { implemented: false, contract: 'BackupTransport' },
    });
  });

  it('covers inspect/export/preview/import and local backup CRUD DTOs', async () => {
    const { router } = await createHarness();
    const inspect = await postJson(router, '/api/backups/archive/inspect');
    await expect(inspect.json()).resolves.toMatchObject({
      modules: [{ moduleId: 'settings', recordCount: 1 }],
    });

    const exported = await postJson(router, '/api/backups/archive/export');
    expect(exported.headers.get('Content-Type')).toBe('application/zip');
    const archive = await exported.blob();
    expect(archive.size).toBeGreaterThan(0);

    const preview = await postForm(router, '/api/backups/archive/import/preview', archive);
    await expect(preview.json()).resolves.toMatchObject({
      manifest: { format: 'pure-tavern-archive' },
      modules: [{ moduleId: 'settings', conflicts: 1 }],
    });
    const imported = await postForm(router, '/api/backups/archive/import', archive);
    await expect(imported.json()).resolves.toMatchObject({
      strategy: 'merge',
      recoveryBackupId: expect.any(String),
    });

    const created = await postJson(router, '/api/backups/archive/local/create', {
      label: 'Route backup',
      moduleIds: ['settings'],
    });
    const descriptor = (await created.json()) as { id: string };
    const list = await postJson(router, '/api/backups/archive/local/list');
    await expect(list.json()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: descriptor.id, label: 'Route backup' }),
      ]),
    );
    const download = await postJson(router, '/api/backups/archive/local/download', {
      id: descriptor.id,
    });
    expect(download.headers.get('Content-Type')).toBe('application/zip');
    expect(
      (await postJson(router, '/api/backups/archive/local/delete', { id: descriptor.id })).status,
    ).toBe(200);

    await expect((await postJson(router, '/api/backups/chat/get')).json()).resolves.toEqual([]);
  });

  it('dispatches fast and slow multipart previews to their matching service paths', async () => {
    const { router, capabilities } = await createHarness();
    const runtime = capabilities.get(dataManagementRuntimeCapability);
    if (!runtime) throw new Error('Missing data management runtime capability.');
    const exported = await postJson(router, '/api/backups/archive/export');
    const archive = await exported.blob();
    const fast = vi.spyOn(runtime.service, 'previewArchive');
    const slow = vi.spyOn(runtime.service, 'previewArchiveStreaming');

    expect(
      (await postForm(router, '/api/backups/archive/import/preview', archive, 'merge', 'fast'))
        .status,
    ).toBe(200);
    expect(fast).toHaveBeenCalledTimes(1);
    expect(slow).not.toHaveBeenCalled();

    expect(
      (await postForm(router, '/api/backups/archive/import/preview', archive, 'merge', 'slow'))
        .status,
    ).toBe(200);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed archives with bounded structured errors', async () => {
    const { router } = await createHarness();
    const response = await postForm(
      router,
      '/api/backups/archive/import/preview',
      new Blob(['not-a-zip']),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ pureTavern: true });
  });

  it('rejects an invalid import method before reading the package', async () => {
    const { router } = await createHarness();
    const response = await postForm(
      router,
      '/api/backups/archive/import/preview',
      new Blob(['not-a-zip']),
      'merge',
      'turbo',
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'invalid-import-method',
      pureTavern: true,
    });
  });

  it('rejects an invalid TauriTavern import mode before reading the package', async () => {
    const { router } = await createHarness();
    const response = await postForm(
      router,
      '/api/backups/tauritavern/import/preview',
      new Blob(['not-a-zip']),
      'unknown-mode',
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'invalid-strategy',
      pureTavern: true,
    });
  });
});
