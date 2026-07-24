import type { ModuleBlobStore, ModuleRecordStore } from '@/platform/storage/app-storage';

import type { AssetCollection, AssetRecord } from '../domain/asset';
import type {
  AssetBlobRecord,
  AssetStorageDiagnostics,
  BlobRepository,
} from '../ports/blob-repository';

export class IndexedDbAssetBlobRepository implements BlobRepository {
  readonly #blobs: ModuleBlobStore;
  readonly #records: ModuleRecordStore | undefined;
  readonly #knownIds = new Map<AssetCollection, Set<string>>();

  constructor(blobs: ModuleBlobStore, records?: ModuleRecordStore) {
    this.#blobs = blobs;
    this.#records = records;
  }

  async put(
    collection: AssetCollection,
    id: string,
    data: Blob,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.#blobs.put(collection, id, data, metadata);
    this.#remember(collection, id);
  }

  async get(collection: AssetCollection, id: string): Promise<AssetBlobRecord | null> {
    const record = await this.#blobs.get(collection, id);
    if (!record) return null;
    this.#remember(collection, id);
    return {
      id: record.id,
      collection,
      data: record.data,
      metadata: structuredClone(record.metadata),
      updatedAt: record.updatedAt,
    };
  }

  async delete(collection: AssetCollection, id: string): Promise<void> {
    await this.#blobs.delete(collection, id);
    this.#knownIds.get(collection)?.delete(id);
  }

  async move(from: AssetCollection, to: AssetCollection, id: string): Promise<void> {
    if (from === to) return;
    const existing = await this.get(from, id);
    if (!existing) return;
    await this.put(to, id, existing.data, existing.metadata);
    try {
      await this.delete(from, id);
    } catch (error) {
      await this.delete(to, id).catch(() => undefined);
      throw error;
    }
  }

  async exists(collection: AssetCollection, id: string): Promise<boolean> {
    return (await this.get(collection, id)) !== null;
  }

  async list(collection: AssetCollection): Promise<AssetBlobRecord[]> {
    const ids = new Set(this.#knownIds.get(collection) ?? []);
    if (this.#records) {
      const index = await this.#records.list<AssetRecord>('index');
      for (const entry of index) {
        if (entry.value.collection === collection) ids.add(entry.value.id);
      }
    }
    const records = await Promise.all([...ids].map((id) => this.get(collection, id)));
    return records.filter((record): record is AssetBlobRecord => record !== null);
  }

  #remember(collection: AssetCollection, id: string): void {
    let ids = this.#knownIds.get(collection);
    if (!ids) {
      ids = new Set();
      this.#knownIds.set(collection, ids);
    }
    ids.add(id);
  }
}

export class MemoryBlobRepository implements BlobRepository {
  readonly #records = new Map<string, AssetBlobRecord>();

  async put(
    collection: AssetCollection,
    id: string,
    data: Blob,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    this.#records.set(makeKey(collection, id), {
      id,
      collection,
      data,
      metadata: structuredClone(metadata),
      updatedAt: new Date().toISOString(),
    });
  }

  async get(collection: AssetCollection, id: string): Promise<AssetBlobRecord | null> {
    return cloneBlobRecord(this.#records.get(makeKey(collection, id)) ?? null);
  }

  async delete(collection: AssetCollection, id: string): Promise<void> {
    this.#records.delete(makeKey(collection, id));
  }

  async move(from: AssetCollection, to: AssetCollection, id: string): Promise<void> {
    if (from === to) return;
    const record = await this.get(from, id);
    if (!record) return;
    await this.put(to, id, record.data, record.metadata);
    await this.delete(from, id);
  }

  async exists(collection: AssetCollection, id: string): Promise<boolean> {
    return this.#records.has(makeKey(collection, id));
  }

  async list(collection: AssetCollection): Promise<AssetBlobRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.collection === collection)
      .map((record) => cloneBlobRecord(record) as AssetBlobRecord);
  }
}

export class ResilientBlobRepository implements BlobRepository {
  readonly diagnostics: AssetStorageDiagnostics = {
    status: 'ready',
    backend: 'indexeddb',
    message: null,
    lastSavedAt: null,
  };

  readonly #primary: BlobRepository;
  readonly #fallback: BlobRepository;

  constructor(primary: BlobRepository, fallback: BlobRepository = new MemoryBlobRepository()) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async put(
    collection: AssetCollection,
    id: string,
    data: Blob,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.#fallback.put(collection, id, data, metadata);
    await this.#write(() => this.#primary.put(collection, id, data, metadata));
  }

  async get(collection: AssetCollection, id: string): Promise<AssetBlobRecord | null> {
    if (this.diagnostics.status === 'degraded') return this.#fallback.get(collection, id);
    try {
      const record = await this.#primary.get(collection, id);
      if (record) await this.#fallback.put(collection, id, record.data, record.metadata);
      else await this.#fallback.delete(collection, id);
      return record;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.get(collection, id);
    }
  }

  async delete(collection: AssetCollection, id: string): Promise<void> {
    await this.#fallback.delete(collection, id);
    await this.#write(() => this.#primary.delete(collection, id));
  }

  async move(from: AssetCollection, to: AssetCollection, id: string): Promise<void> {
    await this.#fallback.move(from, to, id);
    await this.#write(() => this.#primary.move(from, to, id));
  }

  async exists(collection: AssetCollection, id: string): Promise<boolean> {
    if (this.diagnostics.status === 'degraded') return this.#fallback.exists(collection, id);
    try {
      return await this.#primary.exists(collection, id);
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.exists(collection, id);
    }
  }

  async list(collection: AssetCollection): Promise<AssetBlobRecord[]> {
    if (this.diagnostics.status === 'degraded') return this.#fallback.list(collection);
    try {
      const records = await this.#primary.list(collection);
      await Promise.all(
        records.map((record) =>
          this.#fallback.put(collection, record.id, record.data, record.metadata),
        ),
      );
      return records;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.list(collection);
    }
  }

  async #write(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
      this.diagnostics.lastSavedAt = new Date().toISOString();
    } catch (error) {
      this.#degrade(error);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    }
  }

  #degrade(error: unknown): void {
    this.diagnostics.status = 'degraded';
    this.diagnostics.backend = 'memory';
    this.diagnostics.message = error instanceof Error ? error.message : String(error);
  }
}

function makeKey(collection: AssetCollection, id: string): string {
  return `${collection}\u001f${id}`;
}

function cloneBlobRecord(record: AssetBlobRecord | null): AssetBlobRecord | null {
  if (!record) return null;
  return {
    ...record,
    metadata: structuredClone(record.metadata),
  };
}
