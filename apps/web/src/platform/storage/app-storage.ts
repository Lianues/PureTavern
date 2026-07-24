import { type AppDatabase, appDatabase } from './app-database';

const KEY_SEPARATOR = '\u001f';

export interface ModuleRecord<T = unknown> {
  id: string;
  value: T;
  updatedAt: string;
}

export interface ModuleRecordSnapshot<T = unknown> extends ModuleRecord<T> {
  collection: string;
}

export interface ModuleBlobRecord {
  id: string;
  data: Blob;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface ModuleBlobSnapshot extends ModuleBlobRecord {
  collection: string;
}

function assertKeyPart(label: string, value: string) {
  if (!value || value.includes(KEY_SEPARATOR)) {
    throw new TypeError(`${label} must be non-empty and cannot contain the storage separator.`);
  }
}

function makeKey(moduleId: string, collection: string, id: string) {
  assertKeyPart('moduleId', moduleId);
  assertKeyPart('collection', collection);
  assertKeyPart('id', id);
  return [moduleId, collection, id].join(KEY_SEPARATOR);
}

function cloneJsonValue<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Module records must be JSON-serializable.');
  return JSON.parse(serialized) as T;
}

export class ModuleRecordStore {
  readonly #database: AppDatabase;
  readonly #moduleId: string;

  constructor(database: AppDatabase, moduleId: string) {
    assertKeyPart('moduleId', moduleId);
    this.#database = database;
    this.#moduleId = moduleId;
  }

  async get<T>(collection: string, id: string): Promise<ModuleRecord<T> | null> {
    const record = await this.#database.records.get(makeKey(this.#moduleId, collection, id));
    return record
      ? { id: record.id, value: cloneJsonValue(record.value) as T, updatedAt: record.updatedAt }
      : null;
  }

  async put<T>(collection: string, id: string, value: T): Promise<void> {
    const updatedAt = new Date().toISOString();
    await this.#database.records.put({
      key: makeKey(this.#moduleId, collection, id),
      module: this.#moduleId,
      collection,
      id,
      value: cloneJsonValue(value),
      updatedAt,
    });
  }

  async list<T>(collection: string): Promise<ModuleRecord<T>[]> {
    assertKeyPart('collection', collection);
    const records = await this.#database.records
      .where('[module+collection]')
      .equals([this.#moduleId, collection])
      .toArray();
    return records.map((record) => ({
      id: record.id,
      value: cloneJsonValue(record.value) as T,
      updatedAt: record.updatedAt,
    }));
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.#database.records.delete(makeKey(this.#moduleId, collection, id));
  }

  async listAll<T = unknown>(): Promise<ModuleRecordSnapshot<T>[]> {
    const records = await this.#database.records
      .filter((record) => record.module === this.#moduleId)
      .toArray();
    return records.map((record) => ({
      collection: record.collection,
      id: record.id,
      value: cloneJsonValue(record.value) as T,
      updatedAt: record.updatedAt,
    }));
  }

  async clearAll(): Promise<void> {
    const keys = await this.#database.records
      .filter((record) => record.module === this.#moduleId)
      .primaryKeys();
    await this.#database.records.bulkDelete(keys);
  }
}

export class ModuleBlobStore {
  readonly #database: AppDatabase;
  readonly #moduleId: string;

  constructor(database: AppDatabase, moduleId: string) {
    assertKeyPart('moduleId', moduleId);
    this.#database = database;
    this.#moduleId = moduleId;
  }

  async get(collection: string, id: string): Promise<ModuleBlobRecord | null> {
    const record = await this.#database.blobs.get(makeKey(this.#moduleId, collection, id));
    return record
      ? {
          id: record.id,
          data: record.data,
          metadata: cloneJsonValue(record.metadata),
          updatedAt: record.updatedAt,
        }
      : null;
  }

  async put(
    collection: string,
    id: string,
    data: Blob,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.#database.blobs.put({
      key: makeKey(this.#moduleId, collection, id),
      module: this.#moduleId,
      collection,
      id,
      data,
      metadata: cloneJsonValue(metadata),
      updatedAt: new Date().toISOString(),
    });
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.#database.blobs.delete(makeKey(this.#moduleId, collection, id));
  }

  async listAll(): Promise<ModuleBlobSnapshot[]> {
    const records = await this.#database.blobs
      .filter((record) => record.module === this.#moduleId)
      .toArray();
    return records.map((record) => ({
      collection: record.collection,
      id: record.id,
      data: record.data,
      metadata: cloneJsonValue(record.metadata),
      updatedAt: record.updatedAt,
    }));
  }

  async clearAll(): Promise<void> {
    const keys = await this.#database.blobs
      .filter((record) => record.module === this.#moduleId)
      .primaryKeys();
    await this.#database.blobs.bulkDelete(keys);
  }
}

export class ModuleRecordStoreFactory {
  readonly #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  forModule(moduleId: string) {
    return new ModuleRecordStore(this.#database, moduleId);
  }
}

export class ModuleBlobStoreFactory {
  readonly #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  forModule(moduleId: string) {
    return new ModuleBlobStore(this.#database, moduleId);
  }
}

export class AppStorage {
  readonly database: AppDatabase;
  readonly records: ModuleRecordStoreFactory;
  readonly blobs: ModuleBlobStoreFactory;

  constructor(database: AppDatabase = appDatabase) {
    this.database = database;
    this.records = new ModuleRecordStoreFactory(database);
    this.blobs = new ModuleBlobStoreFactory(database);
  }
}

export const appStorage = new AppStorage();
