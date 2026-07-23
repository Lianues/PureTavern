import { initializeStorageSafely } from '@/platform/storage/initialize-storage';

export interface ApplicationBootstrapState {
  database: Awaited<ReturnType<typeof initializeStorageSafely>>;
}

export async function bootstrapApplication(): Promise<ApplicationBootstrapState> {
  const database = await initializeStorageSafely();
  document.documentElement.dataset.databaseState = database.status;

  return { database };
}
