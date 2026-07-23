import { initializeDatabaseSafely } from '@/infrastructure/database/initialize-database';

export interface ApplicationBootstrapState {
  database: Awaited<ReturnType<typeof initializeDatabaseSafely>>;
}

export async function bootstrapApplication(): Promise<ApplicationBootstrapState> {
  const database = await initializeDatabaseSafely();
  document.documentElement.dataset.databaseState = database.status;

  return { database };
}
