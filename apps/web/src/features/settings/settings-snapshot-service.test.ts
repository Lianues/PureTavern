import { afterEach, describe, expect, it } from 'vitest';

import { AppDatabase } from '@/infrastructure/database/app-database';
import { initializeDatabase } from '@/infrastructure/database/initialize-database';

import {
  InvalidSettingsSnapshotNameError,
  SettingsSnapshotNotFoundError,
  SettingsSnapshotService,
} from './application/settings-snapshot-service';
import { SettingsService } from './application/settings-service';
import { IndexedDbSettingsRepository } from './adapters/indexeddb-settings-repository';
import { IndexedDbSettingsSnapshotRepository } from './adapters/indexeddb-settings-snapshot-repository';
import {
  MemorySettingsSnapshotRepository,
  ResilientSettingsSnapshotRepository,
} from './adapters/resilient-settings-snapshot-repository';
import { MemorySettingsRepository } from './adapters/resilient-settings-repository';
import type { SettingsSnapshotRepository } from './ports/settings-snapshot-repository';

const databases: AppDatabase[] = [];

function createSettingsService() {
  return new SettingsService(new MemorySettingsRepository(), async () => ({
    power_user: { fast_ui_mode: true },
  }));
}

function createTestDatabase() {
  const database = new AppDatabase(`pure-tavern-snapshot-test-${crypto.randomUUID()}`);
  databases.push(database);
  return database;
}

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('SettingsSnapshotService', () => {
  it('creates, lists, loads and restores a complete settings snapshot', async () => {
    const settings = createSettingsService();
    const snapshots = new SettingsSnapshotService(
      settings,
      new MemorySettingsSnapshotRepository(),
      () => Date.parse('2026-07-24T00:00:00.000Z'),
    );

    const created = await snapshots.createSnapshot();
    await settings.saveSettings({
      power_user: { fast_ui_mode: false },
      changedAfterSnapshot: true,
    });

    expect(await snapshots.listSnapshots()).toEqual([created]);
    expect(await snapshots.loadSnapshotContent(created.name)).toContain('"fast_ui_mode": true');

    await snapshots.restoreSnapshot(created.name);
    await expect(settings.getSettings()).resolves.toEqual({
      power_user: { fast_ui_mode: true },
    });
  });

  it('creates unique names when multiple snapshots use the same timestamp', async () => {
    const snapshots = new SettingsSnapshotService(
      createSettingsService(),
      new MemorySettingsSnapshotRepository(),
      () => 1_700_000_000_000,
    );

    const first = await snapshots.createSnapshot();
    const second = await snapshots.createSnapshot();

    expect(first.name).not.toBe(second.name);
    expect(second.name).toMatch(/-1\.json$/u);
  });

  it('persists snapshots in IndexedDB across repository instances', async () => {
    const database = createTestDatabase();
    await initializeDatabase(database);
    const settings = new SettingsService(new IndexedDbSettingsRepository(database), async () => ({
      power_user: { fast_ui_mode: true },
    }));
    const firstService = new SettingsSnapshotService(
      settings,
      new IndexedDbSettingsSnapshotRepository(database),
    );
    const created = await firstService.createSnapshot();

    const reloadedService = new SettingsSnapshotService(
      settings,
      new IndexedDbSettingsSnapshotRepository(database),
    );
    await expect(reloadedService.listSnapshots()).resolves.toContainEqual(created);
    await expect(reloadedService.loadSnapshotContent(created.name)).resolves.toContain(
      '"fast_ui_mode": true',
    );
  });

  it('rejects unsafe names and reports missing snapshots separately', async () => {
    const snapshots = new SettingsSnapshotService(
      createSettingsService(),
      new MemorySettingsSnapshotRepository(),
    );

    await expect(snapshots.loadSnapshotContent('../settings_bad.json')).rejects.toBeInstanceOf(
      InvalidSettingsSnapshotNameError,
    );
    await expect(
      snapshots.loadSnapshotContent('settings_default-user_missing.json'),
    ).rejects.toBeInstanceOf(SettingsSnapshotNotFoundError);
  });

  it('falls back to in-memory snapshots when IndexedDB is unavailable', async () => {
    const unavailable: SettingsSnapshotRepository = {
      async list() {
        throw new Error('IndexedDB unavailable');
      },
      async get() {
        throw new Error('IndexedDB unavailable');
      },
      async put() {
        throw new Error('IndexedDB unavailable');
      },
    };
    const repository = new ResilientSettingsSnapshotRepository(unavailable);
    const snapshots = new SettingsSnapshotService(createSettingsService(), repository);

    const created = await snapshots.createSnapshot();

    await expect(snapshots.listSnapshots()).resolves.toContainEqual(created);
    expect(repository.diagnostics).toMatchObject({
      status: 'degraded',
      backend: 'memory',
      message: 'IndexedDB unavailable',
    });
  });
});
