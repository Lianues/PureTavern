import { afterEach, describe, expect, it } from 'vitest';

import { AppDatabase } from './app-database';
import { AppStorage } from './app-storage';
import { initializeStorage } from './initialize-storage';

const databases: AppDatabase[] = [];

function createStorage() {
  const database = new AppDatabase(`pure-tavern-storage-test-${crypto.randomUUID()}`);
  databases.push(database);
  return new AppStorage(database);
}

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('AppStorage', () => {
  it('opens one fixed generic records/blobs database without feature-specific stores', async () => {
    const storage = createStorage();

    await expect(initializeStorage(storage)).resolves.toEqual({
      status: 'ready',
      name: storage.database.name,
    });
    expect(storage.database.tables.map((table) => table.name).sort()).toEqual(['blobs', 'records']);
  });

  it('isolates JSON records by module and collection without schema changes', async () => {
    const storage = createStorage();
    await initializeStorage(storage);
    const settings = storage.records.forModule('settings');
    const characters = storage.records.forModule('characters');

    await settings.put('documents', 'current', { theme: 'dark' });
    await characters.put('documents', 'current', { name: 'Assistant' });
    await settings.put('snapshots', 'one', { theme: 'light' });

    await expect(settings.get('documents', 'current')).resolves.toMatchObject({
      value: { theme: 'dark' },
    });
    await expect(characters.get('documents', 'current')).resolves.toMatchObject({
      value: { name: 'Assistant' },
    });
    await expect(settings.list('snapshots')).resolves.toHaveLength(1);
    await expect(characters.list('snapshots')).resolves.toEqual([]);
  });

  it('provides a namespaced Blob container for future assets', async () => {
    const storage = createStorage();
    await initializeStorage(storage);
    const assets = storage.blobs.forModule('characters');
    const blob = new Blob(['avatar'], { type: 'text/plain' });

    await assets.put('avatars', 'example', blob, { fileName: 'example.txt' });

    const stored = await assets.get('avatars', 'example');
    // fake-indexeddb and jsdom use different Blob implementations, so byte content is
    // covered later by a real-browser asset test. Here we verify namespacing and metadata.
    expect(stored?.data).toBeDefined();
    expect(stored?.metadata).toEqual({ fileName: 'example.txt' });
  });
});
