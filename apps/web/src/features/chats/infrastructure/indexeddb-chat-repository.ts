import type { ModuleRecordStore } from '@/platform/storage/app-storage';

import { cloneJson, type StoredChatSession } from '../domain/chat';
import type { ChatRepository } from '../ports/chat-repository';

export const CHAT_SESSIONS_COLLECTION = 'sessions';

export class IndexedDbChatRepository implements ChatRepository {
  readonly #records: ModuleRecordStore;

  constructor(records: ModuleRecordStore) {
    this.#records = records;
  }

  async list(): Promise<StoredChatSession[]> {
    const records = await this.#records.list<StoredChatSession>(CHAT_SESSIONS_COLLECTION);
    return records.map((record) => cloneJson(record.value));
  }

  async get(id: string): Promise<StoredChatSession | null> {
    const record = await this.#records.get<StoredChatSession>(CHAT_SESSIONS_COLLECTION, id);
    return record ? cloneJson(record.value) : null;
  }

  async findByOwnerAndFile(
    ownerId: string,
    legacyFileName: string,
  ): Promise<StoredChatSession | null> {
    const sessions = await this.list();
    return (
      sessions.find(
        (session) => session.ownerId === ownerId && session.legacyFileName === legacyFileName,
      ) ?? null
    );
  }

  async save(session: StoredChatSession): Promise<void> {
    await this.#records.put(CHAT_SESSIONS_COLLECTION, session.id, cloneJson(session));
  }

  async delete(id: string): Promise<void> {
    await this.#records.delete(CHAT_SESSIONS_COLLECTION, id);
  }
}
