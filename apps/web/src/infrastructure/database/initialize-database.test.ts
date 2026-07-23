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
  it('creates core metadata without feature-specific tables', async () => {
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
    expect(database.tables.map((table) => table.name).sort()).toEqual(['meta', 'moduleStates']);
  });

  it('can run repeatedly without duplicating module state rows', async () => {
    const database = createTestDatabase();

    await initializeDatabase(database);
    await initializeDatabase(database);

    await expect(database.moduleStates.count()).resolves.toBe(3);
  });
});
