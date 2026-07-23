import type { ModuleStateContract } from '@pure-tavern/contracts';
import Dexie, { type Table } from 'dexie';

export const DATABASE_NAME = 'pure-frontend-tavern';
export const DATABASE_SCHEMA_VERSION = 1;

export interface MetaRecord {
  key: string;
  value: unknown;
  updatedAt: string;
}

export type ModuleStateRecord = ModuleStateContract;

export class AppDatabase extends Dexie {
  meta!: Table<MetaRecord, string>;
  moduleStates!: Table<ModuleStateRecord, string>;

  constructor(name = DATABASE_NAME) {
    super(name);

    this.version(DATABASE_SCHEMA_VERSION).stores({
      meta: '&key, updatedAt',
      moduleStates: '&moduleId, status, updatedAt',
    });
  }
}

export const appDatabase = new AppDatabase();
