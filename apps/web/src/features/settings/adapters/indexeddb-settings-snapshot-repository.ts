import type { AppDatabase } from '@/infrastructure/database/app-database';

import { cloneSettingsSnapshot, type SettingsSnapshot } from '../domain/settings-snapshot';
import type { SettingsSnapshotRepository } from '../ports/settings-snapshot-repository';

export class IndexedDbSettingsSnapshotRepository implements SettingsSnapshotRepository {
  readonly #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  async list(): Promise<SettingsSnapshot[]> {
    const records = await this.#database.settingsSnapshots.orderBy('createdAt').reverse().toArray();
    return records.map((record) => cloneSettingsSnapshot(record));
  }

  async get(name: string): Promise<SettingsSnapshot | null> {
    const record = await this.#database.settingsSnapshots.get(name);
    return record ? cloneSettingsSnapshot(record) : null;
  }

  async put(snapshot: SettingsSnapshot): Promise<void> {
    await this.#database.settingsSnapshots.put(cloneSettingsSnapshot(snapshot));
  }
}
