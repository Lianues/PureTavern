import Dexie, { type Table } from 'dexie';

export const DATABASE_NAME = 'pure-frontend-tavern-modular-dev';

export interface StoredModuleRecord {
  key: string;
  module: string;
  collection: string;
  id: string;
  value: unknown;
  updatedAt: string;
}

export interface StoredModuleBlob {
  key: string;
  module: string;
  collection: string;
  id: string;
  data: Blob;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export class AppDatabase extends Dexie {
  records!: Table<StoredModuleRecord, string>;
  blobs!: Table<StoredModuleBlob, string>;

  constructor(name = DATABASE_NAME) {
    super(name);

    // IndexedDB requires an initial physical format number. Feature modules never change it:
    // they add namespaced records instead of Object Stores.
    this.version(1).stores({
      records: '&key, [module+collection], updatedAt',
      blobs: '&key, [module+collection], updatedAt',
    });
  }
}

export const appDatabase = new AppDatabase();
