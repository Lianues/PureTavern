import type { AssetCollection } from '../domain/asset';

export interface AssetBlobRecord {
  id: string;
  collection: AssetCollection;
  data: Blob;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface BlobRepository {
  put(
    collection: AssetCollection,
    id: string,
    data: Blob,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  get(collection: AssetCollection, id: string): Promise<AssetBlobRecord | null>;
  delete(collection: AssetCollection, id: string): Promise<void>;
  move(from: AssetCollection, to: AssetCollection, id: string): Promise<void>;
  exists(collection: AssetCollection, id: string): Promise<boolean>;
  list(collection: AssetCollection): Promise<AssetBlobRecord[]>;
}

export interface AssetStorageDiagnostics {
  status: 'ready' | 'degraded';
  backend: 'indexeddb' | 'memory';
  message: string | null;
  lastSavedAt: string | null;
}
