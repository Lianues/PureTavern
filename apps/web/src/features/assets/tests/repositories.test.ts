import { afterEach, describe, expect, it } from 'vitest';

import { AppDatabase } from '@/platform/storage/app-database';
import { AppStorage } from '@/platform/storage/app-storage';
import { initializeStorage } from '@/platform/storage/initialize-storage';

import { AssetService } from '../application/asset-service';
import type { AssetRecord } from '../domain/asset';
import {
  IndexedDbAssetBlobRepository,
  MemoryBlobRepository,
  ResilientBlobRepository,
} from '../infrastructure/asset-blob-repositories';
import {
  IndexedDbAssetIndex,
  MemoryAssetIndex,
  ResilientAssetIndex,
} from '../infrastructure/asset-index-repositories';
import { BrowserImageProcessor } from '../infrastructure/browser-image-processor';

const databases: AppDatabase[] = [];

async function createStores() {
  const database = new AppDatabase(`pure-tavern-assets-test-${crypto.randomUUID()}`);
  databases.push(database);
  const storage = new AppStorage(database);
  await initializeStorage(storage);
  return {
    records: storage.records.forModule('assets'),
    blobs: storage.blobs.forModule('assets'),
  };
}

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('Assets repositories', () => {
  it('supports BlobRepository put/get/list/move/exists/delete', async () => {
    const repository = new MemoryBlobRepository();
    const blob = new Blob(['hello'], { type: 'text/plain' });

    await repository.put('attachments', 'stable-id', blob, { filename: 'note.txt' });
    await expect(repository.exists('attachments', 'stable-id')).resolves.toBe(true);
    await expect(repository.list('attachments')).resolves.toMatchObject([
      { id: 'stable-id', collection: 'attachments', metadata: { filename: 'note.txt' } },
    ]);

    await repository.move('attachments', 'library', 'stable-id');
    await expect(repository.get('attachments', 'stable-id')).resolves.toBeNull();
    await expect(repository.get('library', 'stable-id')).resolves.toMatchObject({
      data: { size: 5, type: 'text/plain' },
    });

    await repository.delete('library', 'stable-id');
    await expect(repository.exists('library', 'stable-id')).resolves.toBe(false);
  });

  it('persists stable IDs, path aliases, sorting and folders through generic stores', async () => {
    const stores = await createStores();
    const first = new IndexedDbAssetIndex(stores.records);
    const now = new Date(10).toISOString();
    const record: AssetRecord = {
      id: 'asset-id',
      collection: 'backgrounds',
      legacyPath: '/backgrounds/z.png',
      filename: 'z.png',
      mimeType: 'image/png',
      size: 10,
      createdAt: now,
      updatedAt: now,
    };
    await first.put(record);
    await first.setAlias(record.legacyPath, record.id);
    await first.put({
      ...record,
      id: 'asset-a',
      legacyPath: '/backgrounds/a.png',
      filename: 'a.png',
    });
    await first.setAlias('/backgrounds/a.png', 'asset-a');
    await first.putFolder({
      id: 'folder-id',
      name: 'Scenes',
      thumbnailFile: 'a.png',
      createdAt: now,
      updatedAt: now,
    });

    const reopened = new IndexedDbAssetIndex(stores.records);
    await expect(reopened.getByLegacyPath('/backgrounds/z.png')).resolves.toMatchObject({
      id: 'asset-id',
    });
    await expect(reopened.list({ collection: 'backgrounds' })).resolves.toMatchObject([
      { filename: 'a.png' },
      { filename: 'z.png' },
    ]);
    await expect(reopened.listFolders()).resolves.toMatchObject([
      { id: 'folder-id', name: 'Scenes', thumbnailFile: 'a.png' },
    ]);

    await reopened.moveAlias('/backgrounds/z.png', '/backgrounds/renamed.png', 'asset-id');
    await expect(reopened.getByLegacyPath('/backgrounds/z.png')).resolves.toBeNull();
    await expect(reopened.getByLegacyPath('/backgrounds/renamed.png')).resolves.toMatchObject({
      id: 'asset-id',
    });
  });

  it('uses IndexedDB Blob storage and exposes same-runtime list semantics', async () => {
    const stores = await createStores();
    const repository = new IndexedDbAssetBlobRepository(stores.blobs, stores.records);
    const index = new IndexedDbAssetIndex(stores.records);
    await repository.put('attachments', 'one', new Blob(['one']), { order: 1 });
    await repository.put('attachments', 'two', new Blob(['two']), { order: 2 });
    const now = new Date().toISOString();
    for (const id of ['one', 'two']) {
      await index.put({
        id,
        collection: 'attachments',
        legacyPath: `/user/files/${id}.txt`,
        filename: `${id}.txt`,
        mimeType: 'text/plain',
        size: 3,
        createdAt: now,
        updatedAt: now,
      });
    }

    const reopened = new IndexedDbAssetBlobRepository(stores.blobs, stores.records);
    await expect(reopened.list('attachments')).resolves.toHaveLength(2);
    await expect(repository.get('attachments', 'one')).resolves.toMatchObject({
      id: 'one',
      metadata: { order: 1 },
    });
  });

  it('falls back to memory and reports diagnostics when IndexedDB adapters fail', async () => {
    class FailingBlobs extends MemoryBlobRepository {
      override async put(): Promise<void> {
        throw new Error('IndexedDB blobs unavailable');
      }
    }
    class FailingIndex extends MemoryAssetIndex {
      override async put(): Promise<void> {
        throw new Error('IndexedDB records unavailable');
      }
    }

    const blobs = new ResilientBlobRepository(new FailingBlobs());
    await blobs.put('attachments', 'memory-id', new Blob(['memory']));
    await expect(blobs.get('attachments', 'memory-id')).resolves.toMatchObject({ id: 'memory-id' });
    expect(blobs.diagnostics).toMatchObject({
      status: 'degraded',
      backend: 'memory',
      message: 'IndexedDB blobs unavailable',
    });

    const index = new ResilientAssetIndex(new FailingIndex());
    const now = new Date().toISOString();
    await index.put({
      id: 'memory-record',
      collection: 'attachments',
      legacyPath: '/user/files/memory.txt',
      filename: 'memory.txt',
      mimeType: 'text/plain',
      size: 1,
      createdAt: now,
      updatedAt: now,
    });
    await expect(index.get('memory-record')).resolves.toMatchObject({ id: 'memory-record' });
    expect(index.diagnostics).toMatchObject({
      status: 'degraded',
      backend: 'memory',
      message: 'IndexedDB records unavailable',
    });
  });

  it('compensates a failed index alias write instead of leaving an orphan Blob', async () => {
    class AliasFailingIndex extends MemoryAssetIndex {
      override async setAlias(): Promise<void> {
        throw new Error('alias write failed');
      }
    }
    const blobs = new MemoryBlobRepository();
    const index = new AliasFailingIndex();
    const service = new AssetService(blobs, index, new BrowserImageProcessor());

    await expect(service.uploadFile('note.txt', btoa('hello'))).rejects.toThrow(
      'alias write failed',
    );
    await expect(blobs.list('attachments')).resolves.toEqual([]);
    await expect(index.list()).resolves.toEqual([]);
  });
});
