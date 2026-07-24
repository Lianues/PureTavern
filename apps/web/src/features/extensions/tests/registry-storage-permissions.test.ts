import { describe, expect, it } from 'vitest';

import {
  MemoryExtensionRegistry,
  RecordExtensionRegistry,
  ResilientExtensionRegistry,
} from '../infrastructure/extension-registry';
import {
  MemoryPluginPermissionBroker,
  RecordPluginPermissionBroker,
} from '../infrastructure/plugin-permission-broker';
import {
  MemoryPluginStorage,
  RecordPluginStorage,
  ResilientPluginStorage,
} from '../infrastructure/plugin-storage';
import type { ExtensionRecordStore, RecordStoreEntry } from '../infrastructure/record-store';
import { makeExtensionRecord } from './test-helpers';

describe('extension registry', () => {
  it('supports install, list, enable/disable, version and remove', async () => {
    const registry = new MemoryExtensionRegistry();
    const record = makeExtensionRecord('org.example.crud');

    await registry.install(record);
    await expect(registry.list()).resolves.toHaveLength(1);
    await expect(registry.getVersion(record.extensionId)).resolves.toMatchObject({
      extensionId: record.extensionId,
      manifestVersion: '1.0.0',
      packageHash: 'a'.repeat(64),
    });

    await registry.disable(record.extensionId);
    await expect(registry.discover()).resolves.toEqual([]);
    await registry.enable(record.extensionId);
    await expect(registry.discover()).resolves.toHaveLength(1);

    await registry.remove(record.extensionId);
    await expect(registry.get(record.extensionId)).resolves.toBeNull();
  });

  it('persists manifest/install/enabled in separate record namespaces', async () => {
    const records = new TestRecordStore();
    const registry = new RecordExtensionRegistry(records);
    const record = makeExtensionRecord('org.example.records');

    await registry.install(record);

    expect(records.collections()).toEqual(['enabled', 'installations', 'manifests']);
    await expect(registry.get(record.extensionId)).resolves.toMatchObject({
      extensionId: record.extensionId,
      enabled: true,
    });
  });

  it('degrades to memory when the record backend fails', async () => {
    const registry = new ResilientExtensionRegistry(
      new RecordExtensionRegistry(new FailingRecordStore()),
    );
    const record = makeExtensionRecord('org.example.fallback');

    await registry.install(record);

    expect(registry.diagnostics).toMatchObject({ status: 'degraded', backend: 'memory' });
    await expect(registry.get(record.extensionId)).resolves.toMatchObject({
      extensionId: record.extensionId,
    });
  });
});

describe('plugin KV isolation', () => {
  it('isolates identical keys by stable extension id', async () => {
    const storage = new MemoryPluginStorage();
    await storage.put('org.example.one', 'settings', { owner: 'one' });
    await storage.put('org.example.two', 'settings', { owner: 'two' });

    await expect(storage.get('org.example.one', 'settings')).resolves.toEqual({ owner: 'one' });
    await expect(storage.get('org.example.two', 'settings')).resolves.toEqual({ owner: 'two' });
    await storage.clear('org.example.one');
    await expect(storage.get('org.example.one', 'settings')).resolves.toBeNull();
    await expect(storage.get('org.example.two', 'settings')).resolves.toEqual({ owner: 'two' });
  });

  it('falls back to isolated memory KV after record failure', async () => {
    const storage = new ResilientPluginStorage(new RecordPluginStorage(new FailingRecordStore()));
    await storage.put('org.example.fallback', 'key', 'value');

    expect(storage.diagnostics.status).toBe('degraded');
    await expect(storage.get('org.example.fallback', 'key')).resolves.toBe('value');
  });
});

describe('permission broker', () => {
  it('denies sensitive capabilities by default and supports grant/revoke', async () => {
    const broker = new MemoryPluginPermissionBroker();
    const id = 'org.example.permissions';

    for (const capability of [
      'secrets:read',
      'network:fetch',
      'dom:legacy',
      'storage:modules',
    ] as const) {
      await expect(broker.check(id, capability)).resolves.toBe(false);
    }

    await broker.grant(id, 'storage:plugin');
    await expect(broker.check(id, 'storage:plugin')).resolves.toBe(true);
    await expect(broker.list(id)).resolves.toMatchObject([
      { extensionId: id, capability: 'storage:plugin' },
    ]);
    await broker.revoke(id, 'storage:plugin');
    await expect(broker.check(id, 'storage:plugin')).resolves.toBe(false);
  });

  it('stores grants in the permissions namespace', async () => {
    const records = new TestRecordStore();
    const broker = new RecordPluginPermissionBroker(records);
    await broker.grant('org.example.permissions', 'host:events');

    expect(records.collections()).toContain('permissions');
    await expect(broker.check('org.example.permissions', 'host:events')).resolves.toBe(true);
  });
});

class TestRecordStore implements ExtensionRecordStore {
  readonly #collections = new Map<string, Map<string, RecordStoreEntry<unknown>>>();

  async get<T>(collection: string, id: string): Promise<RecordStoreEntry<T> | null> {
    return (
      (structuredClone(this.#collections.get(collection)?.get(id)) as RecordStoreEntry<T>) ?? null
    );
  }

  async put<T>(collection: string, id: string, value: T): Promise<void> {
    let records = this.#collections.get(collection);
    if (!records) {
      records = new Map();
      this.#collections.set(collection, records);
    }
    records.set(id, { id, value: structuredClone(value), updatedAt: new Date().toISOString() });
  }

  async list<T>(collection: string): Promise<RecordStoreEntry<T>[]> {
    return [...(this.#collections.get(collection)?.values() ?? [])].map(
      (record) => structuredClone(record) as RecordStoreEntry<T>,
    );
  }

  async delete(collection: string, id: string): Promise<void> {
    this.#collections.get(collection)?.delete(id);
  }

  collections(): string[] {
    return [...this.#collections.keys()].sort();
  }
}

class FailingRecordStore implements ExtensionRecordStore {
  async get<T>(): Promise<RecordStoreEntry<T> | null> {
    throw new Error('IndexedDB unavailable');
  }

  async put(): Promise<void> {
    throw new Error('IndexedDB unavailable');
  }

  async list<T>(): Promise<RecordStoreEntry<T>[]> {
    throw new Error('IndexedDB unavailable');
  }

  async delete(): Promise<void> {
    throw new Error('IndexedDB unavailable');
  }
}
