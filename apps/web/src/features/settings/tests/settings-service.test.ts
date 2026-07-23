import { afterEach, describe, expect, it } from 'vitest';

import { AppDatabase } from '@/platform/storage/app-database';
import { AppStorage } from '@/platform/storage/app-storage';
import { initializeStorage } from '@/platform/storage/initialize-storage';

import { SettingsService } from '../application/settings-service';
import { IndexedDbSettingsRepository } from '../infrastructure/indexeddb-settings-repository';
import {
  MemorySettingsRepository,
  ResilientSettingsRepository,
} from '../infrastructure/resilient-settings-repository';
import type { SettingsDocument } from '../domain/settings-document';
import type { SettingsRepository } from '../ports/settings-repository';

const databases: AppDatabase[] = [];

function createTestStorage() {
  const database = new AppDatabase(`pure-tavern-settings-test-${crypto.randomUUID()}`);
  databases.push(database);
  return new AppStorage(database);
}

function createDefaults(): SettingsDocument {
  return {
    firstRun: false,
    username: 'User',
    power_user: {
      fast_ui_mode: true,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('SettingsService', () => {
  it('initializes defaults once and returns isolated JSON documents', async () => {
    const repository = new MemorySettingsRepository();
    let defaultLoads = 0;
    const service = new SettingsService(repository, async () => {
      defaultLoads += 1;
      return createDefaults();
    });

    const first = await service.getSettings();
    (first.power_user as Record<string, unknown>).fast_ui_mode = false;
    const second = await service.getSettings();

    expect(defaultLoads).toBe(1);
    expect(second).toEqual(createDefaults());
  });

  it('persists an opaque Legacy settings document in IndexedDB across service instances', async () => {
    const storage = createTestStorage();
    await initializeStorage(storage);
    const repository = new IndexedDbSettingsRepository(storage.records.forModule('settings'));
    const firstService = new SettingsService(repository, async () => createDefaults());

    await firstService.getSettings();
    await firstService.saveSettings({
      ...createDefaults(),
      power_user: { fast_ui_mode: false },
      dynamicLegacyField: ['kept', 42],
    });

    const reloadedService = new SettingsService(repository, async () => {
      throw new Error('Stored settings should be loaded instead of defaults.');
    });
    await expect(reloadedService.getSettings()).resolves.toMatchObject({
      power_user: { fast_ui_mode: false },
      dynamicLegacyField: ['kept', 42],
    });
  });

  it('serializes concurrent saves so the last invocation wins', async () => {
    const savedValues: number[] = [];
    const repository: SettingsRepository = {
      async load() {
        return createDefaults();
      },
      async save(settings) {
        const sequence = Number(settings.sequence ?? 0);
        await new Promise((resolve) => setTimeout(resolve, sequence === 1 ? 20 : 0));
        savedValues.push(sequence);
      },
    };
    const service = new SettingsService(repository, async () => createDefaults());

    await Promise.all([
      service.saveSettings({ sequence: 1 }),
      service.saveSettings({ sequence: 2 }),
    ]);

    expect(savedValues).toEqual([1, 2]);
    await expect(service.getSettings()).resolves.toEqual({ sequence: 2 });
  });

  it('falls back to in-memory persistence when IndexedDB is unavailable', async () => {
    const unavailableRepository: SettingsRepository = {
      async load() {
        throw new Error('IndexedDB unavailable');
      },
      async save() {
        throw new Error('IndexedDB unavailable');
      },
    };
    const repository = new ResilientSettingsRepository(unavailableRepository);
    const service = new SettingsService(repository, async () => createDefaults());

    await service.getSettings();
    await service.saveSettings({ power_user: { fast_ui_mode: false } });

    const secondService = new SettingsService(repository, async () => createDefaults());
    await expect(secondService.getSettings()).resolves.toEqual({
      power_user: { fast_ui_mode: false },
    });
    expect(repository.diagnostics).toMatchObject({
      status: 'degraded',
      backend: 'memory',
      message: 'IndexedDB unavailable',
    });
  });

  it('rejects non-object settings payloads without replacing stored data', async () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository, async () => createDefaults());
    await service.getSettings();

    await expect(service.saveSettings(['invalid'])).rejects.toThrow(
      'Settings payload must be a JSON object.',
    );
    await expect(service.getSettings()).resolves.toEqual(createDefaults());
  });
});
