export interface RecordStoreEntry<T> {
  id: string;
  value: T;
  updatedAt: string;
}

/** Structural subset of ModuleRecordStore, kept local so tests can inject a failing backend. */
export interface ExtensionRecordStore {
  get<T>(collection: string, id: string): Promise<RecordStoreEntry<T> | null>;
  put<T>(collection: string, id: string, value: T): Promise<void>;
  list<T>(collection: string): Promise<RecordStoreEntry<T>[]>;
  delete(collection: string, id: string): Promise<void>;
}

export function cloneRecordValue<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Extension records must be JSON-serializable.');
  return JSON.parse(serialized) as T;
}
