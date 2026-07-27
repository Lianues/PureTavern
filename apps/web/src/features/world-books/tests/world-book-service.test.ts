import { afterEach, describe, expect, it } from 'vitest';

import { AppDatabase } from '@/platform/storage/app-database';
import { AppStorage } from '@/platform/storage/app-storage';
import { initializeStorage } from '@/platform/storage/initialize-storage';

import { WorldBookImportCodec } from '../application/world-book-import-codec';
import { WorldBookService } from '../application/world-book-service';
import { WorldBookValidationError } from '../application/world-book-validation';
import type { StoredWorldBook } from '../domain/world-book';
import {
  IndexedDbWorldBookRepository,
  WORLD_BOOK_ALIASES_COLLECTION,
  WORLD_BOOKS_COLLECTION,
  type StoredWorldBookAlias,
} from '../infrastructure/indexeddb-world-book-repository';
import {
  MemoryWorldBookRepository,
  ResilientWorldBookRepository,
} from '../infrastructure/resilient-world-book-repository';
import type { WorldBookRepository } from '../ports/world-book-repository';

const databases: AppDatabase[] = [];

async function createHarness() {
  const database = new AppDatabase(`pure-tavern-world-books-test-${crypto.randomUUID()}`);
  databases.push(database);
  const storage = new AppStorage(database);
  await initializeStorage(storage);
  const records = storage.records.forModule('world-books');
  const repository = new IndexedDbWorldBookRepository(records);
  let id = 0;
  let timestamp = 0;
  const service = new WorldBookService(
    repository,
    new WorldBookImportCodec(),
    () => `book-${++id}`,
    () => new Date(++timestamp),
  );
  return { records, repository, service };
}

function namedBlob(contents: BlobPart[], name: string, type = 'application/json'): Blob {
  const blob = new Blob(contents, { type });
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('WorldBook repository and service', () => {
  it('persists sorted CRUD data through books and stable alias records', async () => {
    const { records, service } = await createHarness();
    await service.editWorldBook('Zulu', { entries: {}, extensions: { color: 'red' } });
    await service.editWorldBook('Alpha', {
      name: 'Alpha Display',
      entries: { 0: { uid: 0, key: ['alpha'] } },
      extensions: { plugin: { enabled: true } },
    });

    await expect(service.listWorldBooks()).resolves.toEqual([
      {
        file_id: 'Alpha',
        name: 'Alpha Display',
        extensions: { plugin: { enabled: true } },
      },
      { file_id: 'Zulu', name: 'Zulu', extensions: { color: 'red' } },
    ]);
    await expect(service.listWorldNames()).resolves.toEqual(['Alpha', 'Zulu']);

    const aliases = await records.list<StoredWorldBookAlias>(WORLD_BOOK_ALIASES_COLLECTION);
    const booksBeforeEdit = await records.list<StoredWorldBook>(WORLD_BOOKS_COLLECTION);
    const alphaAlias = aliases.find((alias) => alias.id === 'Alpha');
    expect(alphaAlias?.value.bookId).toBe('book-2');
    expect(booksBeforeEdit.find((book) => book.id === 'book-2')?.value.createdAt).toBe(
      new Date(2).toISOString(),
    );

    await service.editWorldBook('Alpha', { entries: [], replacementOnly: true });
    const booksAfterEdit = await records.list<StoredWorldBook>(WORLD_BOOKS_COLLECTION);
    expect(booksAfterEdit).toHaveLength(2);
    expect(booksAfterEdit.find((book) => book.id === 'book-2')?.value).toMatchObject({
      id: 'book-2',
      legacyFileId: 'Alpha',
      createdAt: new Date(2).toISOString(),
      updatedAt: new Date(3).toISOString(),
    });
    await expect(service.getWorldBook('Alpha')).resolves.toEqual({
      entries: [],
      replacementOnly: true,
    });

    await service.deleteWorldBook('Alpha');
    await expect(service.listWorldNames()).resolves.toEqual(['Zulu']);
    await expect(records.get(WORLD_BOOK_ALIASES_COLLECTION, 'Alpha')).resolves.toBeNull();
    await expect(records.get(WORLD_BOOKS_COLLECTION, 'book-2')).resolves.toBeNull();
  });

  it('moves aliases without changing a repository stable ID', async () => {
    const { repository } = await createHarness();
    const original: StoredWorldBook = {
      id: 'stable-id',
      legacyFileId: 'Before',
      name: 'Before',
      document: { entries: {} },
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(1).toISOString(),
    };
    await repository.save(original);
    await repository.save({
      ...original,
      legacyFileId: 'After',
      name: 'After',
      updatedAt: new Date(2).toISOString(),
    });

    await expect(repository.get('Before')).resolves.toBeNull();
    await expect(repository.get('After')).resolves.toMatchObject({
      id: 'stable-id',
      legacyFileId: 'After',
    });
    await expect(
      repository.save({
        ...original,
        id: 'different-id',
        legacyFileId: 'After',
      }),
    ).rejects.toThrow('alias already belongs to another book');
  });

  it('round-trips unknown top-level and entry fields while full edit replaces old data', async () => {
    const { service } = await createHarness();
    const opaqueDocument = {
      entries: {
        7: {
          uid: 7,
          key: ['crystal'],
          pluginEntryField: { nested: [1, true, null] },
        },
      },
      extensions: { thirdParty: { version: 3 } },
      futureTopLevelField: ['untouched', { enabled: true }],
    };
    await service.editWorldBook('Opaque', opaqueDocument);
    const loaded = await service.getWorldBook('Opaque');
    expect(loaded).toEqual(opaqueDocument);

    (loaded.extensions as Record<string, unknown>).mutated = true;
    await expect(service.getWorldBook('Opaque')).resolves.toEqual(opaqueDocument);

    await service.editWorldBook('Opaque', { entries: {}, onlyNewField: 1 });
    await expect(service.getWorldBook('Opaque')).resolves.toEqual({
      entries: {},
      onlyNewField: 1,
    });
  });

  it('returns a Legacy dummy document for a missing safe name', async () => {
    const { service } = await createHarness();
    await expect(service.getWorldBook('Missing')).resolves.toEqual({ entries: {} });
  });

  it('degrades to page memory and exposes diagnostics when IndexedDB operations fail', async () => {
    const unavailable: WorldBookRepository = {
      async list() {
        throw new Error('IndexedDB unavailable');
      },
      async get() {
        throw new Error('IndexedDB unavailable');
      },
      async save() {
        throw new Error('IndexedDB unavailable');
      },
      async delete() {
        throw new Error('IndexedDB unavailable');
      },
    };
    const repository = new ResilientWorldBookRepository(
      unavailable,
      new MemoryWorldBookRepository(),
    );
    const service = new WorldBookService(repository, undefined, () => 'memory-id');

    await service.editWorldBook('Memory', { entries: {}, extensionData: { kept: true } });
    await service.editWorldBook('Memory', { entries: [], secondMemoryWrite: true });
    await expect(service.getWorldBook('Memory')).resolves.toEqual({
      entries: [],
      secondMemoryWrite: true,
    });
    expect(repository.diagnostics).toMatchObject({
      status: 'degraded',
      backend: 'memory',
      message: 'IndexedDB unavailable',
    });
  });

});

describe('WorldBookImportCodec', () => {
  it('imports native JSON and already converted Novel/Agnai/Risu data', async () => {
    const repository = new MemoryWorldBookRepository();
    let nextId = 0;
    const service = new WorldBookService(repository, undefined, () => `import-${++nextId}`);
    const native = {
      entries: { 1: { uid: 1, key: ['native'], unknown: 'preserved' } },
      extensions: { source: 'native' },
    };
    await expect(
      service.importWorldBook(namedBlob([JSON.stringify(native)], 'Native.json')),
    ).resolves.toBe('Native');
    await expect(service.getWorldBook('Native')).resolves.toEqual(native);

    const converted = {
      entries: [{ uid: 2, key: ['converted'], converterField: 42 }],
      sourceFormat: 'novel-or-agnai-or-risu',
    };
    await expect(
      service.importWorldBook(
        namedBlob(['PNG bytes are intentionally not decoded here'], 'Converted.png', 'image/png'),
        JSON.stringify(converted),
      ),
    ).resolves.toBe('Converted');
    await expect(service.getWorldBook('Converted')).resolves.toEqual(converted);
  });

  it('rejects invalid JSON, missing/invalid entries and unsafe names', async () => {
    const codec = new WorldBookImportCodec();
    await expect(codec.decode(namedBlob(['{'], 'Broken.json'))).rejects.toThrow(
      WorldBookValidationError,
    );
    await expect(
      codec.decode(namedBlob([JSON.stringify({ extensions: {} })], 'NoEntries.json')),
    ).rejects.toThrow('must contain entries');
    await expect(
      codec.decode(namedBlob([JSON.stringify({ entries: 'invalid' })], 'BadEntries.json')),
    ).rejects.toThrow('entries must be an object or array');

    await expect(
      codec.decode(namedBlob([JSON.stringify({ entries: {} })], '../escape.json')),
    ).rejects.toThrow('unsafe path characters');
    await expect(
      codec.decode(namedBlob([JSON.stringify({ entries: {} })], '..%2Fencoded.json')),
    ).rejects.toThrow('unsafe path characters');
  });

  it('accepts valid imports whose reported size exceeds the former 10 MiB quota', async () => {
    const codec = new WorldBookImportCodec();
    const large = namedBlob(
      [JSON.stringify({ entries: {}, extensions: { kept: true } })],
      'Large.json',
    );
    Object.defineProperty(large, 'size', { value: 10 * 1024 * 1024 + 1 });

    await expect(codec.decode(large)).resolves.toMatchObject({
      legacyFileId: 'Large',
      document: { entries: {}, extensions: { kept: true } },
    });
  });
});
