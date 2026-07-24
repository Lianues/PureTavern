import type { ModuleRecordStore } from '@/platform/storage/app-storage';

import { AssetNotFoundError } from '../application/asset-errors';
import { normalizeLegacyPath } from '../application/asset-security';
import {
  cloneAssetRecord,
  cloneBackgroundFolder,
  type AssetIndexQuery,
  type AssetRecord,
  type BackgroundFolder,
  type ImageMetadata,
} from '../domain/asset';
import type { AssetIndex } from '../ports/asset-index';
import type { AssetStorageDiagnostics } from '../ports/blob-repository';

const INDEX_COLLECTION = 'index';
const ALIAS_COLLECTION = 'path-aliases';
const FOLDER_COLLECTION = 'background-folders';

interface AliasRecord {
  assetId: string;
}

export class IndexedDbAssetIndex implements AssetIndex {
  readonly #records: ModuleRecordStore;

  constructor(records: ModuleRecordStore) {
    this.#records = records;
  }

  async get(id: string): Promise<AssetRecord | null> {
    const record = await this.#records.get<AssetRecord>(INDEX_COLLECTION, id);
    return record ? cloneAssetRecord(record.value) : null;
  }

  async getByLegacyPath(path: string): Promise<AssetRecord | null> {
    const normalizedPath = normalizeLegacyPath(path);
    const alias = await this.#records.get<AliasRecord>(ALIAS_COLLECTION, normalizedPath);
    return alias ? this.get(alias.value.assetId) : null;
  }

  async put(record: AssetRecord): Promise<void> {
    await this.#records.put(INDEX_COLLECTION, record.id, cloneAssetRecord(record));
  }

  async delete(id: string): Promise<void> {
    await this.#records.delete(INDEX_COLLECTION, id);
  }

  async list(query: AssetIndexQuery = {}): Promise<AssetRecord[]> {
    const records = (await this.#records.list<AssetRecord>(INDEX_COLLECTION)).map((entry) =>
      cloneAssetRecord(entry.value),
    );
    return filterAndSort(records, query);
  }

  async setAlias(path: string, assetId: string): Promise<void> {
    await this.#records.put<AliasRecord>(ALIAS_COLLECTION, normalizeLegacyPath(path), { assetId });
  }

  async deleteAlias(path: string): Promise<void> {
    await this.#records.delete(ALIAS_COLLECTION, normalizeLegacyPath(path));
  }

  async moveAlias(fromPath: string, toPath: string, assetId: string): Promise<void> {
    const from = normalizeLegacyPath(fromPath);
    const to = normalizeLegacyPath(toPath);
    if (from === to) return;
    await this.setAlias(to, assetId);
    try {
      await this.deleteAlias(from);
    } catch (error) {
      await this.deleteAlias(to).catch(() => undefined);
      throw error;
    }
  }

  async listFolders(): Promise<BackgroundFolder[]> {
    const folders = await this.#records.list<BackgroundFolder>(FOLDER_COLLECTION);
    return folders
      .map((entry) => cloneBackgroundFolder(entry.value))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getFolder(id: string): Promise<BackgroundFolder | null> {
    const folder = await this.#records.get<BackgroundFolder>(FOLDER_COLLECTION, id);
    return folder ? cloneBackgroundFolder(folder.value) : null;
  }

  async putFolder(folder: BackgroundFolder): Promise<void> {
    await this.#records.put(FOLDER_COLLECTION, folder.id, cloneBackgroundFolder(folder));
  }

  async deleteFolder(id: string): Promise<void> {
    await this.#records.delete(FOLDER_COLLECTION, id);
  }

  async getImageMetadata(path: string): Promise<ImageMetadata | null> {
    const asset = await this.getByLegacyPath(path);
    return asset?.imageMetadata ? structuredClone(asset.imageMetadata) : null;
  }

  async putImageMetadata(path: string, metadata: ImageMetadata): Promise<void> {
    const asset = await this.getByLegacyPath(path);
    if (!asset)
      throw new AssetNotFoundError(`No asset is indexed at ${normalizeLegacyPath(path)}.`);
    asset.imageMetadata = structuredClone(metadata);
    asset.updatedAt = new Date().toISOString();
    await this.put(asset);
  }

  async deleteImageMetadata(path: string): Promise<void> {
    const asset = await this.getByLegacyPath(path);
    if (!asset) return;
    delete asset.imageMetadata;
    asset.updatedAt = new Date().toISOString();
    await this.put(asset);
  }
}

export class MemoryAssetIndex implements AssetIndex {
  readonly #assets = new Map<string, AssetRecord>();
  readonly #aliases = new Map<string, string>();
  readonly #folders = new Map<string, BackgroundFolder>();

  async get(id: string): Promise<AssetRecord | null> {
    const record = this.#assets.get(id);
    return record ? cloneAssetRecord(record) : null;
  }

  async getByLegacyPath(path: string): Promise<AssetRecord | null> {
    const id = this.#aliases.get(normalizeLegacyPath(path));
    return id ? this.get(id) : null;
  }

  async put(record: AssetRecord): Promise<void> {
    this.#assets.set(record.id, cloneAssetRecord(record));
  }

  async delete(id: string): Promise<void> {
    this.#assets.delete(id);
  }

  async list(query: AssetIndexQuery = {}): Promise<AssetRecord[]> {
    return filterAndSort(
      [...this.#assets.values()].map((record) => cloneAssetRecord(record)),
      query,
    );
  }

  async setAlias(path: string, assetId: string): Promise<void> {
    this.#aliases.set(normalizeLegacyPath(path), assetId);
  }

  async deleteAlias(path: string): Promise<void> {
    this.#aliases.delete(normalizeLegacyPath(path));
  }

  async moveAlias(fromPath: string, toPath: string, assetId: string): Promise<void> {
    const from = normalizeLegacyPath(fromPath);
    const to = normalizeLegacyPath(toPath);
    if (from === to) return;
    this.#aliases.set(to, assetId);
    this.#aliases.delete(from);
  }

  async listFolders(): Promise<BackgroundFolder[]> {
    return [...this.#folders.values()]
      .map((folder) => cloneBackgroundFolder(folder))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getFolder(id: string): Promise<BackgroundFolder | null> {
    const folder = this.#folders.get(id);
    return folder ? cloneBackgroundFolder(folder) : null;
  }

  async putFolder(folder: BackgroundFolder): Promise<void> {
    this.#folders.set(folder.id, cloneBackgroundFolder(folder));
  }

  async deleteFolder(id: string): Promise<void> {
    this.#folders.delete(id);
  }

  async getImageMetadata(path: string): Promise<ImageMetadata | null> {
    const asset = await this.getByLegacyPath(path);
    return asset?.imageMetadata ? structuredClone(asset.imageMetadata) : null;
  }

  async putImageMetadata(path: string, metadata: ImageMetadata): Promise<void> {
    const asset = await this.getByLegacyPath(path);
    if (!asset)
      throw new AssetNotFoundError(`No asset is indexed at ${normalizeLegacyPath(path)}.`);
    asset.imageMetadata = structuredClone(metadata);
    asset.updatedAt = new Date().toISOString();
    await this.put(asset);
  }

  async deleteImageMetadata(path: string): Promise<void> {
    const asset = await this.getByLegacyPath(path);
    if (!asset) return;
    delete asset.imageMetadata;
    asset.updatedAt = new Date().toISOString();
    await this.put(asset);
  }
}

export class ResilientAssetIndex implements AssetIndex {
  readonly diagnostics: AssetStorageDiagnostics = {
    status: 'ready',
    backend: 'indexeddb',
    message: null,
    lastSavedAt: null,
  };

  readonly #primary: AssetIndex;
  readonly #fallback: AssetIndex;

  constructor(primary: AssetIndex, fallback: AssetIndex = new MemoryAssetIndex()) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async get(id: string): Promise<AssetRecord | null> {
    return this.#read(
      () => this.#primary.get(id),
      () => this.#fallback.get(id),
      async (record) => {
        if (record) await this.#fallback.put(record);
        else await this.#fallback.delete(id);
      },
    );
  }

  async getByLegacyPath(path: string): Promise<AssetRecord | null> {
    return this.#read(
      () => this.#primary.getByLegacyPath(path),
      () => this.#fallback.getByLegacyPath(path),
      async (record) => {
        if (record) {
          await this.#fallback.put(record);
          await this.#fallback.setAlias(path, record.id);
        } else {
          await this.#fallback.deleteAlias(path);
        }
      },
    );
  }

  async put(record: AssetRecord): Promise<void> {
    await this.#fallback.put(record);
    await this.#write(() => this.#primary.put(record));
  }

  async delete(id: string): Promise<void> {
    await this.#fallback.delete(id);
    await this.#write(() => this.#primary.delete(id));
  }

  async list(query: AssetIndexQuery = {}): Promise<AssetRecord[]> {
    return this.#read(
      () => this.#primary.list(query),
      () => this.#fallback.list(query),
      async (records) => {
        await Promise.all(records.map((record) => this.#fallback.put(record)));
      },
    );
  }

  async setAlias(path: string, assetId: string): Promise<void> {
    await this.#fallback.setAlias(path, assetId);
    await this.#write(() => this.#primary.setAlias(path, assetId));
  }

  async deleteAlias(path: string): Promise<void> {
    await this.#fallback.deleteAlias(path);
    await this.#write(() => this.#primary.deleteAlias(path));
  }

  async moveAlias(fromPath: string, toPath: string, assetId: string): Promise<void> {
    await this.#fallback.moveAlias(fromPath, toPath, assetId);
    await this.#write(() => this.#primary.moveAlias(fromPath, toPath, assetId));
  }

  async listFolders(): Promise<BackgroundFolder[]> {
    return this.#read(
      () => this.#primary.listFolders(),
      () => this.#fallback.listFolders(),
      async (folders) => {
        await Promise.all(folders.map((folder) => this.#fallback.putFolder(folder)));
      },
    );
  }

  async getFolder(id: string): Promise<BackgroundFolder | null> {
    return this.#read(
      () => this.#primary.getFolder(id),
      () => this.#fallback.getFolder(id),
      async (folder) => {
        if (folder) await this.#fallback.putFolder(folder);
        else await this.#fallback.deleteFolder(id);
      },
    );
  }

  async putFolder(folder: BackgroundFolder): Promise<void> {
    await this.#fallback.putFolder(folder);
    await this.#write(() => this.#primary.putFolder(folder));
  }

  async deleteFolder(id: string): Promise<void> {
    await this.#fallback.deleteFolder(id);
    await this.#write(() => this.#primary.deleteFolder(id));
  }

  async getImageMetadata(path: string): Promise<ImageMetadata | null> {
    return this.#read(
      () => this.#primary.getImageMetadata(path),
      () => this.#fallback.getImageMetadata(path),
      async (metadata) => {
        if (metadata) {
          const asset = await this.#primary.getByLegacyPath(path);
          if (asset) {
            await this.#fallback.put(asset);
            await this.#fallback.setAlias(path, asset.id);
            await this.#fallback.putImageMetadata(path, metadata);
          }
        } else {
          await this.#fallback.deleteImageMetadata(path);
        }
      },
    );
  }

  async putImageMetadata(path: string, metadata: ImageMetadata): Promise<void> {
    await this.#fallback.putImageMetadata(path, metadata);
    await this.#write(() => this.#primary.putImageMetadata(path, metadata));
  }

  async deleteImageMetadata(path: string): Promise<void> {
    await this.#fallback.deleteImageMetadata(path);
    await this.#write(() => this.#primary.deleteImageMetadata(path));
  }

  async #read<T>(
    primary: () => Promise<T>,
    fallback: () => Promise<T>,
    synchronize: (value: T) => Promise<void>,
  ): Promise<T> {
    if (this.diagnostics.status === 'degraded') return fallback();
    try {
      const value = await primary();
      await synchronize(value);
      return value;
    } catch (error) {
      this.#degrade(error);
      return fallback();
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

function filterAndSort(records: AssetRecord[], query: AssetIndexQuery): AssetRecord[] {
  const filtered = records.filter((record) => {
    if (query.collection && record.collection !== query.collection) return false;
    if (query.owner && record.owner !== query.owner) return false;
    if (query.folder && record.folder !== query.folder) return false;
    if (query.category && record.category !== query.category) return false;
    if (query.mimePrefix && !record.mimeType.startsWith(query.mimePrefix)) return false;
    return true;
  });
  const sortBy = query.sortBy ?? 'filename';
  const direction = query.direction === 'desc' ? -1 : 1;
  return filtered.sort((left, right) => {
    const leftValue = left[sortBy];
    const rightValue = right[sortBy];
    const comparison =
      sortBy === 'filename'
        ? leftValue.localeCompare(rightValue, undefined, { sensitivity: 'base' })
        : leftValue.localeCompare(rightValue);
    return comparison * direction || left.id.localeCompare(right.id) * direction;
  });
}
