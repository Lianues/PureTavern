import type { ModuleRecordStore } from '@/platform/storage/app-storage';

import {
  cloneSecretDocument,
  normalizeSecretDocument,
  type SecretDocument,
} from '../domain/secret';
import type { SecretStore } from '../ports/secret-store';

const SECRET_COLLECTION = 'store';
const CURRENT_SECRET_DOCUMENT = 'current';

export class IndexedDbSecretStore implements SecretStore {
  readonly #records: ModuleRecordStore;

  constructor(records: ModuleRecordStore) {
    this.#records = records;
  }

  async load(): Promise<SecretDocument | null> {
    const record = await this.#records.get<unknown>(SECRET_COLLECTION, CURRENT_SECRET_DOCUMENT);
    return record ? normalizeSecretDocument(record.value) : null;
  }

  async save(document: SecretDocument): Promise<void> {
    await this.#records.put(
      SECRET_COLLECTION,
      CURRENT_SECRET_DOCUMENT,
      cloneSecretDocument(document),
    );
  }
}
