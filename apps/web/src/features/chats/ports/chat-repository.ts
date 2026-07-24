import type { StoredChatSession } from '../domain/chat';

export interface ChatRepository {
  list(): Promise<StoredChatSession[]>;
  get(id: string): Promise<StoredChatSession | null>;
  findByOwnerAndFile(ownerId: string, legacyFileName: string): Promise<StoredChatSession | null>;
  save(session: StoredChatSession): Promise<void>;
  delete(id: string): Promise<void>;
}
