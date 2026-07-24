import { afterEach, describe, expect, it } from 'vitest';

import { AppDatabase } from '@/platform/storage/app-database';
import { AppStorage } from '@/platform/storage/app-storage';
import { initializeStorage } from '@/platform/storage/initialize-storage';

import { SecretService } from '../application/secret-service';
import {
  MAX_SECRET_VALUE_BYTES,
  SecretValidationError,
  type SecretDocument,
} from '../domain/secret';
import { IndexedDbSecretStore } from '../infrastructure/indexeddb-secret-store';
import { MemorySecretStore, ResilientSecretStore } from '../infrastructure/resilient-secret-store';
import type { SecretStore } from '../ports/secret-store';

const databases: AppDatabase[] = [];

function createService(store: SecretStore = new MemorySecretStore()) {
  let id = 0;
  return new SecretService(store, { createId: () => `secret-${++id}` });
}

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('SecretService', () => {
  it('supports multiple values, masked state, rotation, rename, view and active fallback', async () => {
    const service = createService();
    const first = await service.writeSecret('api_key_openai', 'short', 'First');
    const second = await service.writeSecret('api_key_openai', 'super-secret-value-789', 'Second');

    expect(first).toBe('secret-1');
    expect(second).toBe('secret-2');
    await expect(service.getLegacyState()).resolves.toMatchObject({
      api_key_openai: [
        { id: first, value: '**********', label: 'First', active: false },
        { id: second, value: '*******789', label: 'Second', active: true },
      ],
      api_key_claude: null,
    });
    await expect(service.resolveCredential('api_key_openai')).resolves.toBe(
      'super-secret-value-789',
    );
    await expect(service.resolveCredential('api_key_openai', first)).resolves.toBe('short');
    await expect(service.viewActiveSecrets()).resolves.toEqual({
      api_key_openai: 'super-secret-value-789',
    });

    await service.rotateSecret('api_key_openai', first);
    await service.renameSecret('api_key_openai', first, 'Primary');
    await expect(service.getLegacyState()).resolves.toMatchObject({
      api_key_openai: [
        { id: first, label: 'Primary', active: true },
        { id: second, active: false },
      ],
    });

    await service.deleteSecret('api_key_openai');
    await expect(service.resolveCredential('api_key_openai')).resolves.toBe(
      'super-secret-value-789',
    );
    await service.deleteSecret('api_key_openai', second);
    await expect(service.hasCredential('api_key_openai')).resolves.toBe(false);
    await expect(service.getLegacyState()).resolves.toMatchObject({ api_key_openai: null });
  });

  it('allows intentional empty values and keeps missing mutations idempotent', async () => {
    const service = createService();
    const id = await service.writeSecret('api_key_custom', '', 'Empty');
    await expect(service.resolveCredential('api_key_custom')).resolves.toBe('');
    await expect(service.rotateSecret('api_key_custom', 'missing')).resolves.toBe(false);
    await expect(service.renameSecret('api_key_custom', 'missing', 'Unused')).resolves.toBe(false);
    await expect(service.deleteSecret('api_key_custom', 'missing')).resolves.toBe(false);
    await expect(service.deleteSecret('api_key_custom', id)).resolves.toBe(true);
  });

  it('rejects unsafe keys, labels, IDs and oversized values without echoing values', async () => {
    const service = createService();
    await expect(service.writeSecret('__proto__', 'value', 'Label')).rejects.toThrow(
      SecretValidationError,
    );
    await expect(service.writeSecret(' key', 'value', 'Label')).rejects.toThrow(
      'Credential key is invalid.',
    );
    await expect(service.writeSecret('safe', 'value', 'bad\nlabel')).rejects.toThrow(
      'Credential label is invalid.',
    );
    await expect(service.rotateSecret('safe', 'bad\nid')).rejects.toThrow(
      'Credential ID is invalid.',
    );
    await expect(
      service.writeSecret('safe', 'x'.repeat(MAX_SECRET_VALUE_BYTES + 1), 'Label'),
    ).rejects.toThrow('Credential value is invalid or too large.');
  });

  it('serializes concurrent writes so the final invocation is the only active value', async () => {
    const service = createService();
    const ids = await Promise.all([
      service.writeSecret('api_key_openai', 'one', 'One'),
      service.writeSecret('api_key_openai', 'two', 'Two'),
      service.writeSecret('api_key_openai', 'three', 'Three'),
    ]);
    expect(ids).toEqual(['secret-1', 'secret-2', 'secret-3']);
    const state = await service.getLegacyState();
    expect(state.api_key_openai?.map((secret) => secret.active)).toEqual([false, false, true]);
    await expect(service.resolveCredential('api_key_openai')).resolves.toBe('three');
  });

  it('persists through the generic IndexedDB records store', async () => {
    const database = new AppDatabase(`pure-tavern-secrets-test-${crypto.randomUUID()}`);
    databases.push(database);
    const storage = new AppStorage(database);
    await initializeStorage(storage);
    const records = storage.records.forModule('secrets');

    const first = createService(new IndexedDbSecretStore(records));
    await first.writeSecret('api_key_openai', 'persisted-value', 'Persisted');

    const reloaded = new SecretService(new IndexedDbSecretStore(records));
    await expect(reloaded.resolveCredential('api_key_openai')).resolves.toBe('persisted-value');
    const stored = await records.get<SecretDocument>('store', 'current');
    expect(stored?.value.secrets.api_key_openai?.[0]).toMatchObject({
      value: 'persisted-value',
      label: 'Persisted',
      active: true,
    });
  });

  it('falls back permanently to page memory without leaking the failed payload in diagnostics', async () => {
    const failing: SecretStore = {
      async load() {
        throw new Error('database unavailable');
      },
      async save() {
        throw new Error('should not retry after degradation');
      },
    };
    const store = new ResilientSecretStore(failing);
    const service = createService(store);

    await expect(service.hasCredential('api_key_openai')).resolves.toBe(false);
    await service.writeSecret('api_key_openai', 'never-log-this', 'Local');
    await expect(service.resolveCredential('api_key_openai')).resolves.toBe('never-log-this');
    expect(store.diagnostics).toMatchObject({ status: 'degraded', backend: 'memory' });
    expect(JSON.stringify(store.diagnostics)).not.toContain('never-log-this');
  });
});
