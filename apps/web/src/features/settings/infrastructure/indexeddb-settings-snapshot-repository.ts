import type { ModuleRecordStore } from '@/platform/storage/app-storage';

import { cloneSettingsSnapshot, type SettingsSnapshot } from '../domain/settings-snapshot';
import type { SettingsSnapshotRepository } from '../ports/settings-snapshot-repository';

const SNAPSHOTS_COLLECTION = 'snapshots';

export class IndexedDbSettingsSnapshotRepository implements SettingsSnapshotRepository {
  readonly #records: ModuleRecordStore;

  constructor(records: ModuleRecordStore) {
    this.#records = records;
  }

  async list(): Promise<SettingsSnapshot[]> {
    const records = await this.#records.list<SettingsSnapshot>(SNAPSHOTS_COLLECTION);
    return records
      .map((record) => cloneSettingsSnapshot(record.value))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async get(name: string): Promise<SettingsSnapshot | null> {
    const record = await this.#records.get<SettingsSnapshot>(SNAPSHOTS_COLLECTION, name);
    return record ? cloneSettingsSnapshot(record.value) : null;
  }

  async put(snapshot: SettingsSnapshot): Promise<void> {
    await this.#records.put(SNAPSHOTS_COLLECTION, snapshot.name, cloneSettingsSnapshot(snapshot));
  }
}
