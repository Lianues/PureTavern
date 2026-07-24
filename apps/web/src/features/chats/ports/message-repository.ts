import type { OpaqueJsonObject } from '../domain/chat';

export interface MessageRepository {
  get(chatId: string): Promise<OpaqueJsonObject[]>;
  save(chatId: string, messages: OpaqueJsonObject[]): Promise<void>;
  delete(chatId: string): Promise<void>;
}
