import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

import { AppDatabase, DATABASE_SCHEMA_VERSION } from './app-database';
import { initializeDatabase } from './initialize-database';

const databases: AppDatabase[] = [];

function createTestDatabase() {
  const database = new AppDatabase(`pure-tavern-test-${crypto.randomUUID()}`);
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

describe('initializeDatabase', () => {
  it('creates core metadata and the feature-owned settings table', async () => {
    const database = createTestDatabase();

    const state = await initializeDatabase(database);

    expect(state).toEqual({
      status: 'ready',
      name: database.name,
      schemaVersion: DATABASE_SCHEMA_VERSION,
    });
    await expect(database.meta.get('databaseSchemaVersion')).resolves.toMatchObject({
      value: DATABASE_SCHEMA_VERSION,
    });
    await expect(database.moduleStates.get('M02-local-database')).resolves.toMatchObject({
      status: 'browser-ready',
      version: DATABASE_SCHEMA_VERSION,
    });
    expect(database.tables.map((table) => table.name).sort()).toEqual([
      'meta',
      'moduleStates',
      'settings',
      'settingsSnapshots',
    ]);
    await expect(database.moduleStates.get('M03-settings')).resolves.toMatchObject({
      status: 'completed',
      version: 2,
    });
  });

  it('can run repeatedly without duplicating module state rows', async () => {
    const database = createTestDatabase();

    await initializeDatabase(database);
    await initializeDatabase(database);

    await expect(database.moduleStates.count()).resolves.toBe(4);
  });

  it('upgrades an existing schema v1 database without losing core records', async () => {
    const name = `pure-tavern-test-${crypto.randomUUID()}`;
    const legacyDatabase = new Dexie(name);
    legacyDatabase.version(1).stores({
      meta: '&key, updatedAt',
      moduleStates: '&moduleId, status, updatedAt',
    });
    await legacyDatabase.open();
    await legacyDatabase.table('meta').put({
      key: 'legacyProbe',
      value: 'preserved',
      updatedAt: new Date(0).toISOString(),
    });
    legacyDatabase.close();

    const database = new AppDatabase(name);
    databases.push(database);
    await initializeDatabase(database);

    await expect(database.meta.get('legacyProbe')).resolves.toMatchObject({ value: 'preserved' });
    expect(database.tables.some((table) => table.name === 'settings')).toBe(true);
    expect(database.tables.some((table) => table.name === 'settingsSnapshots')).toBe(true);
  });

  it('upgrades schema v2 settings without losing the current document', async () => {
    const name = `pure-tavern-test-${crypto.randomUUID()}`;
    const legacyDatabase = new Dexie(name);
    legacyDatabase.version(2).stores({
      meta: '&key, updatedAt',
      moduleStates: '&moduleId, status, updatedAt',
      settings: '&id, updatedAt',
    });
    await legacyDatabase.open();
    await legacyDatabase.table('settings').put({
      id: 'current',
      document: { power_user: { fast_ui_mode: false } },
      documentVersion: 1,
      updatedAt: new Date(0).toISOString(),
    });
    legacyDatabase.close();

    const database = new AppDatabase(name);
    databases.push(database);
    await initializeDatabase(database);

    await expect(database.settings.get('current')).resolves.toMatchObject({
      document: { power_user: { fast_ui_mode: false } },
    });
    expect(database.tables.some((table) => table.name === 'settingsSnapshots')).toBe(true);
  });
});
