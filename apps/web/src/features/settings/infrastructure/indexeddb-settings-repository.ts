import type { ModuleRecordStore } from '@/platform/storage/app-storage';

import { cloneSettingsDocument, type SettingsDocument } from '../domain/settings-document';
import type { SettingsRepository } from '../ports/settings-repository';

const SETTINGS_COLLECTION = 'documents';
const CURRENT_SETTINGS_ID = 'current';

export class IndexedDbSettingsRepository implements SettingsRepository {
  readonly #records: ModuleRecordStore;

  constructor(records: ModuleRecordStore) {
    this.#records = records;
  }

  async load(): Promise<SettingsDocument | null> {
    const record = await this.#records.get<SettingsDocument>(
      SETTINGS_COLLECTION,
      CURRENT_SETTINGS_ID,
    );
    return record ? cloneSettingsDocument(record.value) : null;
  }

  async save(settings: SettingsDocument): Promise<void> {
    await this.#records.put(
      SETTINGS_COLLECTION,
      CURRENT_SETTINGS_ID,
      cloneSettingsDocument(settings),
    );
  }
}
