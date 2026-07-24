import { assertExtensionId } from '../domain/extension';
import type { ExtensionStorageDiagnostics } from '../ports/extension-registry';
import type { PluginStorage, PluginStorageEntry } from '../ports/plugin-storage';
import { cloneRecordValue, type ExtensionRecordStore } from './record-store';

const PLUGIN_KV_PREFIX = 'plugin-kv:';

export class RecordPluginStorage implements PluginStorage {
  readonly #records: ExtensionRecordStore;

  constructor(records: ExtensionRecordStore) {
    this.#records = records;
  }

  async get<T>(extensionId: string, key: string): Promise<T | null> {
    const record = await this.#records.get<T>(collectionFor(extensionId), assertPluginKey(key));
    return record ? cloneRecordValue(record.value) : null;
  }

  async put<T>(extensionId: string, key: string, value: T): Promise<void> {
    await this.#records.put(
      collectionFor(extensionId),
      assertPluginKey(key),
      cloneRecordValue(value),
    );
  }

  async delete(extensionId: string, key: string): Promise<void> {
    await this.#records.delete(collectionFor(extensionId), assertPluginKey(key));
  }

  async list<T>(extensionId: string): Promise<PluginStorageEntry<T>[]> {
    const records = await this.#records.list<T>(collectionFor(extensionId));
    return records
      .map((record) => ({
        key: record.id,
        value: cloneRecordValue(record.value),
        updatedAt: record.updatedAt,
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  async clear(extensionId: string): Promise<void> {
    const records = await this.#records.list(collectionFor(extensionId));
    await Promise.all(
      records.map((record) => this.#records.delete(collectionFor(extensionId), record.id)),
    );
  }
}

export class MemoryPluginStorage implements PluginStorage {
  readonly #records = new Map<string, Map<string, PluginStorageEntry>>();

  async get<T>(extensionId: string, key: string): Promise<T | null> {
    assertExtensionId(extensionId);
    const record = this.#records.get(extensionId)?.get(assertPluginKey(key));
    return record ? cloneRecordValue(record.value as T) : null;
  }

  async put<T>(extensionId: string, key: string, value: T): Promise<void> {
    assertExtensionId(extensionId);
    let extensionRecords = this.#records.get(extensionId);
    if (!extensionRecords) {
      extensionRecords = new Map();
      this.#records.set(extensionId, extensionRecords);
    }
    extensionRecords.set(assertPluginKey(key), {
      key,
      value: cloneRecordValue(value),
      updatedAt: new Date().toISOString(),
    });
  }

  async delete(extensionId: string, key: string): Promise<void> {
    assertExtensionId(extensionId);
    this.#records.get(extensionId)?.delete(assertPluginKey(key));
  }

  async list<T>(extensionId: string): Promise<PluginStorageEntry<T>[]> {
    assertExtensionId(extensionId);
    return [...(this.#records.get(extensionId)?.values() ?? [])]
      .map((record) => cloneRecordValue(record) as PluginStorageEntry<T>)
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  async clear(extensionId: string): Promise<void> {
    assertExtensionId(extensionId);
    this.#records.delete(extensionId);
  }

  replace(extensionId: string, entries: readonly PluginStorageEntry[]): void {
    const next = new Map<string, PluginStorageEntry>();
    for (const entry of entries) next.set(entry.key, cloneRecordValue(entry));
    this.#records.set(extensionId, next);
  }
}

export class ResilientPluginStorage implements PluginStorage {
  readonly diagnostics: ExtensionStorageDiagnostics = {
    status: 'ready',
    backend: 'records',
    message: null,
    lastSavedAt: null,
  };

  readonly #primary: PluginStorage;
  readonly #fallback: MemoryPluginStorage;

  constructor(primary: PluginStorage, fallback: MemoryPluginStorage = new MemoryPluginStorage()) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async get<T>(extensionId: string, key: string): Promise<T | null> {
    if (this.diagnostics.status === 'degraded') return this.#fallback.get(extensionId, key);
    try {
      const value = await this.#primary.get<T>(extensionId, key);
      if (value === null) await this.#fallback.delete(extensionId, key);
      else await this.#fallback.put(extensionId, key, value);
      return value;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.get(extensionId, key);
    }
  }

  async put<T>(extensionId: string, key: string, value: T): Promise<void> {
    await this.#fallback.put(extensionId, key, value);
    await this.#write(() => this.#primary.put(extensionId, key, value));
  }

  async delete(extensionId: string, key: string): Promise<void> {
    await this.#fallback.delete(extensionId, key);
    await this.#write(() => this.#primary.delete(extensionId, key));
  }

  async list<T>(extensionId: string): Promise<PluginStorageEntry<T>[]> {
    if (this.diagnostics.status === 'degraded') return this.#fallback.list(extensionId);
    try {
      const records = await this.#primary.list<T>(extensionId);
      this.#fallback.replace(extensionId, records);
      return records;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.list(extensionId);
    }
  }

  async clear(extensionId: string): Promise<void> {
    await this.#fallback.clear(extensionId);
    await this.#write(() => this.#primary.clear(extensionId));
  }

  async #write(operation: () => Promise<void>): Promise<void> {
    if (this.diagnostics.status !== 'degraded') {
      try {
        await operation();
      } catch (error) {
        this.#degrade(error);
      }
    }
    this.diagnostics.lastSavedAt = new Date().toISOString();
  }

  #degrade(error: unknown): void {
    this.diagnostics.status = 'degraded';
    this.diagnostics.backend = 'memory';
    this.diagnostics.message = error instanceof Error ? error.message : String(error);
  }
}

function collectionFor(extensionId: string): string {
  assertExtensionId(extensionId);
  return `${PLUGIN_KV_PREFIX}${extensionId}`;
}

function assertPluginKey(key: string): string {
  const hasControlCharacter = [...key].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (!key || key.length > 256 || hasControlCharacter) {
    throw new TypeError('Plugin storage key must be 1-256 characters without control characters.');
  }
  return key;
}
