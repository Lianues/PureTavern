import type { ModuleRecordStore } from '@/platform/storage/app-storage';

import { cloneJson, type OpaqueJsonObject } from '../domain/chat';
import type { MessageRepository } from '../ports/message-repository';

export const CHAT_MESSAGES_COLLECTION = 'messages';

export class IndexedDbMessageRepository implements MessageRepository {
  readonly #records: ModuleRecordStore;

  constructor(records: ModuleRecordStore) {
    this.#records = records;
  }

  async get(chatId: string): Promise<OpaqueJsonObject[]> {
    const record = await this.#records.get<OpaqueJsonObject[]>(CHAT_MESSAGES_COLLECTION, chatId);
    return record ? cloneJson(record.value) : [];
  }

  async save(chatId: string, messages: OpaqueJsonObject[]): Promise<void> {
    await this.#records.put(CHAT_MESSAGES_COLLECTION, chatId, cloneJson(messages));
  }

  async delete(chatId: string): Promise<void> {
    await this.#records.delete(CHAT_MESSAGES_COLLECTION, chatId);
  }
}
