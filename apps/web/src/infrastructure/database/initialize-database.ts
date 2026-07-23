import type { ModuleStateContract } from '@pure-tavern/contracts';

import { type AppDatabase, DATABASE_SCHEMA_VERSION, appDatabase } from './app-database';

export interface DatabaseReadyState {
  status: 'ready';
  name: string;
  schemaVersion: number;
}

export interface DatabaseErrorState {
  status: 'error';
  name: string;
  message: string;
}

export type DatabaseBootstrapState = DatabaseReadyState | DatabaseErrorState;

const INITIAL_MODULE_STATES: Omit<ModuleStateContract, 'updatedAt'>[] = [
  {
    moduleId: 'M00-application-shell',
    version: 1,
    status: 'legacy-hosted',
    details: 'Legacy UI is displayed in a script-disabled sandbox.',
  },
  {
    moduleId: 'M01-module-runtime',
    version: 1,
    status: 'designed',
    details: 'Only the bootstrap state contract exists in this phase.',
  },
  {
    moduleId: 'M02-local-database',
    version: DATABASE_SCHEMA_VERSION,
    status: 'browser-ready',
    details: 'Core metadata tables are available. Feature tables are added by module migrations.',
  },
];

export async function initializeDatabase(
  database: AppDatabase = appDatabase,
): Promise<DatabaseReadyState> {
  await database.open();
  const updatedAt = new Date().toISOString();

  await database.transaction('rw', database.meta, database.moduleStates, async () => {
    await database.meta.put({
      key: 'databaseSchemaVersion',
      value: DATABASE_SCHEMA_VERSION,
      updatedAt,
    });

    await database.meta.put({
      key: 'createdBy',
      value: 'pure-frontend-tavern',
      updatedAt,
    });

    await database.moduleStates.bulkPut(
      INITIAL_MODULE_STATES.map((state) => ({ ...state, updatedAt })),
    );
  });

  return {
    status: 'ready',
    name: database.name,
    schemaVersion: DATABASE_SCHEMA_VERSION,
  };
}

export async function initializeDatabaseSafely(
  database: AppDatabase = appDatabase,
): Promise<DatabaseBootstrapState> {
  try {
    return await initializeDatabase(database);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('IndexedDB initialization failed. Legacy UI will remain available.', error);
    return {
      status: 'error',
      name: database.name,
      message,
    };
  }
}
