import {
  cloneJson,
  type OpaqueJsonObject,
  type OwnerAlias,
  type StoredChatSession,
} from '../domain/chat';
import type { ChatRepository } from '../ports/chat-repository';
import type { MessageRepository } from '../ports/message-repository';
import type { OwnerAliasRepository } from '../ports/owner-alias-repository';

export interface ChatStorageDiagnostics {
  status: 'ready' | 'degraded';
  backend: 'indexeddb' | 'memory';
  message: string | null;
  lastSavedAt: string | null;
}

function createDiagnostics(): ChatStorageDiagnostics {
  return { status: 'ready', backend: 'indexeddb', message: null, lastSavedAt: null };
}

export class MemoryChatRepository implements ChatRepository {
  readonly #sessions = new Map<string, StoredChatSession>();

  async list(): Promise<StoredChatSession[]> {
    return [...this.#sessions.values()].map(cloneJson);
  }

  async get(id: string): Promise<StoredChatSession | null> {
    const session = this.#sessions.get(id);
    return session ? cloneJson(session) : null;
  }

  async findByOwnerAndFile(
    ownerId: string,
    legacyFileName: string,
  ): Promise<StoredChatSession | null> {
    const session = [...this.#sessions.values()].find(
      (item) => item.ownerId === ownerId && item.legacyFileName === legacyFileName,
    );
    return session ? cloneJson(session) : null;
  }

  async save(session: StoredChatSession): Promise<void> {
    this.#sessions.set(session.id, cloneJson(session));
  }

  async delete(id: string): Promise<void> {
    this.#sessions.delete(id);
  }
}

export class MemoryMessageRepository implements MessageRepository {
  readonly #messages = new Map<string, OpaqueJsonObject[]>();

  async get(chatId: string): Promise<OpaqueJsonObject[]> {
    return cloneJson(this.#messages.get(chatId) ?? []);
  }

  async save(chatId: string, messages: OpaqueJsonObject[]): Promise<void> {
    this.#messages.set(chatId, cloneJson(messages));
  }

  async delete(chatId: string): Promise<void> {
    this.#messages.delete(chatId);
  }
}

export class MemoryOwnerAliasRepository implements OwnerAliasRepository {
  readonly #aliases = new Map<string, OwnerAlias>();

  async get(avatarUrl: string): Promise<OwnerAlias | null> {
    const alias = this.#aliases.get(avatarUrl);
    return alias ? cloneJson(alias) : null;
  }

  async save(alias: OwnerAlias): Promise<void> {
    this.#aliases.set(alias.avatarUrl, cloneJson(alias));
  }
}

export class ResilientChatRepository implements ChatRepository {
  readonly diagnostics = createDiagnostics();
  readonly #primary: ChatRepository;
  readonly #fallback: ChatRepository;

  constructor(primary: ChatRepository, fallback: ChatRepository = new MemoryChatRepository()) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async list(): Promise<StoredChatSession[]> {
    try {
      const sessions = await this.#primary.list();
      await Promise.all(sessions.map((session) => this.#fallback.save(session)));
      return sessions;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.list();
    }
  }

  async get(id: string): Promise<StoredChatSession | null> {
    try {
      const session = await this.#primary.get(id);
      if (session) await this.#fallback.save(session);
      return session;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.get(id);
    }
  }

  async findByOwnerAndFile(
    ownerId: string,
    legacyFileName: string,
  ): Promise<StoredChatSession | null> {
    try {
      const session = await this.#primary.findByOwnerAndFile(ownerId, legacyFileName);
      if (session) await this.#fallback.save(session);
      return session;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.findByOwnerAndFile(ownerId, legacyFileName);
    }
  }

  async save(session: StoredChatSession): Promise<void> {
    await this.#fallback.save(session);
    try {
      await this.#primary.save(session);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    } catch (error) {
      this.#degrade(error);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    }
  }

  async delete(id: string): Promise<void> {
    await this.#fallback.delete(id);
    try {
      await this.#primary.delete(id);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    } catch (error) {
      this.#degrade(error);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    }
  }

  #degrade(error: unknown) {
    degrade(this.diagnostics, error);
  }
}

export class ResilientMessageRepository implements MessageRepository {
  readonly diagnostics = createDiagnostics();
  readonly #primary: MessageRepository;
  readonly #fallback: MessageRepository;

  constructor(
    primary: MessageRepository,
    fallback: MessageRepository = new MemoryMessageRepository(),
  ) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async get(chatId: string): Promise<OpaqueJsonObject[]> {
    try {
      const messages = await this.#primary.get(chatId);
      await this.#fallback.save(chatId, messages);
      return messages;
    } catch (error) {
      degrade(this.diagnostics, error);
      return this.#fallback.get(chatId);
    }
  }

  async save(chatId: string, messages: OpaqueJsonObject[]): Promise<void> {
    await this.#fallback.save(chatId, messages);
    try {
      await this.#primary.save(chatId, messages);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    } catch (error) {
      degrade(this.diagnostics, error);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    }
  }

  async delete(chatId: string): Promise<void> {
    await this.#fallback.delete(chatId);
    try {
      await this.#primary.delete(chatId);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    } catch (error) {
      degrade(this.diagnostics, error);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    }
  }
}

export class ResilientOwnerAliasRepository implements OwnerAliasRepository {
  readonly diagnostics = createDiagnostics();
  readonly #primary: OwnerAliasRepository;
  readonly #fallback: OwnerAliasRepository;

  constructor(
    primary: OwnerAliasRepository,
    fallback: OwnerAliasRepository = new MemoryOwnerAliasRepository(),
  ) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async get(avatarUrl: string): Promise<OwnerAlias | null> {
    try {
      const alias = await this.#primary.get(avatarUrl);
      if (alias) await this.#fallback.save(alias);
      return alias;
    } catch (error) {
      degrade(this.diagnostics, error);
      return this.#fallback.get(avatarUrl);
    }
  }

  async save(alias: OwnerAlias): Promise<void> {
    await this.#fallback.save(alias);
    try {
      await this.#primary.save(alias);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    } catch (error) {
      degrade(this.diagnostics, error);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    }
  }
}

function degrade(diagnostics: ChatStorageDiagnostics, error: unknown): void {
  diagnostics.status = 'degraded';
  diagnostics.backend = 'memory';
  diagnostics.message = error instanceof Error ? error.message : String(error);
}
