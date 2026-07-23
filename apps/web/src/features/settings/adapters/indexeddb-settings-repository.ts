import type { AppDatabase } from '@/infrastructure/database/app-database';

import { cloneSettingsDocument, type SettingsDocument } from '../domain/settings-document';
import type { SettingsRepository } from '../ports/settings-repository';

const CURRENT_SETTINGS_ID = 'current' as const;
const SETTINGS_DOCUMENT_VERSION = 1;

export class IndexedDbSettingsRepository implements SettingsRepository {
  readonly #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  async load(): Promise<SettingsDocument | null> {
    const record = await this.#database.settings.get(CURRENT_SETTINGS_ID);
    return record ? cloneSettingsDocument(record.document) : null;
  }

  async save(settings: SettingsDocument): Promise<void> {
    await this.#database.settings.put({
      id: CURRENT_SETTINGS_ID,
      document: cloneSettingsDocument(settings),
      documentVersion: SETTINGS_DOCUMENT_VERSION,
      updatedAt: new Date().toISOString(),
    });
  }
}
