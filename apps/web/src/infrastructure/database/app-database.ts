import type { ModuleStateContract } from '@pure-tavern/contracts';
import Dexie, { type Table } from 'dexie';

export const DATABASE_NAME = 'pure-frontend-tavern';
export const DATABASE_SCHEMA_VERSION = 2;

export interface MetaRecord {
  key: string;
  value: unknown;
  updatedAt: string;
}

export type ModuleStateRecord = ModuleStateContract;

export interface StoredSettingsRecord {
  id: 'current';
  document: Record<string, unknown>;
  documentVersion: number;
  updatedAt: string;
}

export class AppDatabase extends Dexie {
  meta!: Table<MetaRecord, string>;
  moduleStates!: Table<ModuleStateRecord, string>;
  settings!: Table<StoredSettingsRecord, string>;

  constructor(name = DATABASE_NAME) {
    super(name);

    this.version(1).stores({
      meta: '&key, updatedAt',
      moduleStates: '&moduleId, status, updatedAt',
    });

    this.version(DATABASE_SCHEMA_VERSION).stores({
      meta: '&key, updatedAt',
      moduleStates: '&moduleId, status, updatedAt',
      settings: '&id, updatedAt',
    });
  }
}

export const appDatabase = new AppDatabase();
