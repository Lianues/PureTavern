import { type AppStorage, appStorage } from './app-storage';

export interface StorageReadyState {
  status: 'ready';
  name: string;
}

export interface StorageErrorState {
  status: 'error';
  name: string;
  message: string;
}

export type StorageBootstrapState = StorageReadyState | StorageErrorState;

export async function initializeStorage(
  storage: AppStorage = appStorage,
): Promise<StorageReadyState> {
  await storage.database.open();
  return {
    status: 'ready',
    name: storage.database.name,
  };
}

export async function initializeStorageSafely(
  storage: AppStorage = appStorage,
): Promise<StorageBootstrapState> {
  try {
    return await initializeStorage(storage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('IndexedDB initialization failed. Legacy UI will remain available.', error);
    return {
      status: 'error',
      name: storage.database.name,
      message,
    };
  }
}
