export type PluginStorageValue = unknown;

export interface PluginStorageEntry<T = PluginStorageValue> {
  key: string;
  value: T;
  updatedAt: string;
}

/** Storage is always addressed by stable extension id; callers cannot select a platform collection. */
export interface PluginStorage {
  get<T = PluginStorageValue>(extensionId: string, key: string): Promise<T | null>;
  put<T = PluginStorageValue>(extensionId: string, key: string, value: T): Promise<void>;
  delete(extensionId: string, key: string): Promise<void>;
  list<T = PluginStorageValue>(extensionId: string): Promise<PluginStorageEntry<T>[]>;
  clear(extensionId: string): Promise<void>;
}
