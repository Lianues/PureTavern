import type { ModuleRecordStore } from '@/platform/storage/app-storage';

import { cloneJson, type OwnerAlias } from '../domain/chat';
import type { OwnerAliasRepository } from '../ports/owner-alias-repository';

export const CHAT_OWNER_ALIASES_COLLECTION = 'owner-aliases';

export class IndexedDbOwnerAliasRepository implements OwnerAliasRepository {
  readonly #records: ModuleRecordStore;

  constructor(records: ModuleRecordStore) {
    this.#records = records;
  }

  async get(avatarUrl: string): Promise<OwnerAlias | null> {
    const record = await this.#records.get<OwnerAlias>(CHAT_OWNER_ALIASES_COLLECTION, avatarUrl);
    return record ? cloneJson(record.value) : null;
  }

  async save(alias: OwnerAlias): Promise<void> {
    await this.#records.put(CHAT_OWNER_ALIASES_COLLECTION, alias.avatarUrl, cloneJson(alias));
  }
}
