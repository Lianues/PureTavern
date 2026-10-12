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
  pendingWrites: number;
}

function createDiagnostics(): ChatStorageDiagnostics {
  return {
    status: 'ready',
    backend: 'indexeddb',
    message: null,
    lastSavedAt: null,
    pendingWrites: 0,
  };
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

/** Pending values and tombstones must win over an older, still-readable primary store. */
class PendingWrites {
  readonly #versions = new Map<string, number>();
  readonly #pending = new Set<string>();

  version(id: string): number {
    return this.#versions.get(id) ?? 0;
  }
  versions(): Map<string, number> {
    return new Map(this.#versions);
  }
  has(id: string): boolean {
    return this.#pending.has(id);
  }
  any(): boolean {
    return this.#pending.size > 0;
  }
  changedSince(id: string, versions: ReadonlyMap<string, number>): boolean {
    return this.version(id) !== (versions.get(id) ?? 0);
  }

  async write(
    id: string,
    diagnostics: ChatStorageDiagnostics,
    fallback: () => Promise<void>,
    primary: () => Promise<void>,
  ): Promise<void> {
    const version = this.version(id) + 1;
    this.#versions.set(id, version);
    this.#pending.add(id);
    diagnostics.pendingWrites = this.#pending.size;
    await fallback();
    try {
      await primary();
      if (this.version(id) === version) this.#pending.delete(id);
      if (!this.any()) {
        diagnostics.status = 'ready';
        diagnostics.backend = 'indexeddb';
        diagnostics.message = null;
      }
    } catch (error) {
      degrade(diagnostics, error);
    }
    diagnostics.pendingWrites = this.#pending.size;
    diagnostics.lastSavedAt = new Date().toISOString();
  }
}

export class ResilientChatRepository implements ChatRepository {
  readonly diagnostics = createDiagnostics();
  readonly #primary: ChatRepository;
  readonly #fallback: ChatRepository;
  readonly #pending = new PendingWrites();

  constructor(primary: ChatRepository, fallback: ChatRepository = new MemoryChatRepository()) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  hasPendingWrites(): boolean {
    return this.#pending.any();
  }

  async list(): Promise<StoredChatSession[]> {
    const versions = this.#pending.versions();
    try {
      const sessions = await this.#primary.list();
      for (const session of sessions) {
        if (!this.#pending.has(session.id) && !this.#pending.changedSince(session.id, versions)) {
          await this.#fallback.save(session);
        }
      }
      const merged = new Map(sessions.map((session) => [session.id, session]));
      const memory = new Map((await this.#fallback.list()).map((session) => [session.id, session]));
      for (const id of this.#pending.versions().keys()) {
        if (!this.#pending.has(id) && !this.#pending.changedSince(id, versions)) continue;
        const session = memory.get(id);
        if (session) merged.set(id, session);
        else merged.delete(id);
      }
      return [...merged.values()];
    } catch (error) {
      degrade(this.diagnostics, error);
      return this.#fallback.list();
    }
  }

  async get(id: string): Promise<StoredChatSession | null> {
    if (this.#pending.has(id)) return this.#fallback.get(id);
    const version = this.#pending.version(id);
    try {
      const session = await this.#primary.get(id);
      if (this.#pending.has(id) || this.#pending.version(id) !== version)
        return this.#fallback.get(id);
      if (session) await this.#fallback.save(session);
      return session;
    } catch (error) {
      degrade(this.diagnostics, error);
      return this.#fallback.get(id);
    }
  }

  async findByOwnerAndFile(
    ownerId: string,
    legacyFileName: string,
  ): Promise<StoredChatSession | null> {
    const versions = this.#pending.versions();
    try {
      const session = await this.#primary.findByOwnerAndFile(ownerId, legacyFileName);
      if (
        session &&
        !this.#pending.has(session.id) &&
        !this.#pending.changedSince(session.id, versions)
      ) {
        await this.#fallback.save(session);
        return session;
      }
      return (
        (await this.#fallback.list()).find(
          (candidate) =>
            candidate.ownerId === ownerId &&
            candidate.legacyFileName === legacyFileName &&
            (this.#pending.has(candidate.id) || this.#pending.changedSince(candidate.id, versions)),
        ) ?? null
      );
    } catch (error) {
      degrade(this.diagnostics, error);
      return this.#fallback.findByOwnerAndFile(ownerId, legacyFileName);
    }
  }

  async save(session: StoredChatSession): Promise<void> {
    await this.#pending.write(
      session.id,
      this.diagnostics,
      () => this.#fallback.save(session),
      () => this.#primary.save(session),
    );
  }

  async delete(id: string): Promise<void> {
    await this.#pending.write(
      id,
      this.diagnostics,
      () => this.#fallback.delete(id),
      () => this.#primary.delete(id),
    );
  }
}

export class ResilientMessageRepository implements MessageRepository {
  readonly diagnostics = createDiagnostics();
  readonly #primary: MessageRepository;
  readonly #fallback: MessageRepository;
  readonly #pending = new PendingWrites();

  constructor(
    primary: MessageRepository,
    fallback: MessageRepository = new MemoryMessageRepository(),
  ) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  hasPendingWrites(): boolean {
    return this.#pending.any();
  }

  async get(chatId: string): Promise<OpaqueJsonObject[]> {
    if (this.#pending.has(chatId)) return this.#fallback.get(chatId);
    const version = this.#pending.version(chatId);
    try {
      const messages = await this.#primary.get(chatId);
      if (this.#pending.has(chatId) || this.#pending.version(chatId) !== version)
        return this.#fallback.get(chatId);
      await this.#fallback.save(chatId, messages);
      return messages;
    } catch (error) {
      degrade(this.diagnostics, error);
      return this.#fallback.get(chatId);
    }
  }

  async save(chatId: string, messages: OpaqueJsonObject[]): Promise<void> {
    await this.#pending.write(
      chatId,
      this.diagnostics,
      () => this.#fallback.save(chatId, messages),
      () => this.#primary.save(chatId, messages),
    );
  }

  async delete(chatId: string): Promise<void> {
    await this.#pending.write(
      chatId,
      this.diagnostics,
      () => this.#fallback.delete(chatId),
      () => this.#primary.delete(chatId),
    );
  }
}

export class ResilientOwnerAliasRepository implements OwnerAliasRepository {
  readonly diagnostics = createDiagnostics();
  readonly #primary: OwnerAliasRepository;
  readonly #fallback: OwnerAliasRepository;
  readonly #pending = new PendingWrites();

  constructor(
    primary: OwnerAliasRepository,
    fallback: OwnerAliasRepository = new MemoryOwnerAliasRepository(),
  ) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  hasPendingWrites(): boolean {
    return this.#pending.any();
  }

  async get(avatarUrl: string): Promise<OwnerAlias | null> {
    if (this.#pending.has(avatarUrl)) return this.#fallback.get(avatarUrl);
    const version = this.#pending.version(avatarUrl);
    try {
      const alias = await this.#primary.get(avatarUrl);
      if (this.#pending.has(avatarUrl) || this.#pending.version(avatarUrl) !== version)
        return this.#fallback.get(avatarUrl);
      if (alias) await this.#fallback.save(alias);
      return alias;
    } catch (error) {
      degrade(this.diagnostics, error);
      return this.#fallback.get(avatarUrl);
    }
  }

  async save(alias: OwnerAlias): Promise<void> {
    await this.#pending.write(
      alias.avatarUrl,
      this.diagnostics,
      () => this.#fallback.save(alias),
      () => this.#primary.save(alias),
    );
  }
}

function degrade(diagnostics: ChatStorageDiagnostics, error: unknown): void {
  diagnostics.status = 'degraded';
  diagnostics.backend = 'memory';
  diagnostics.message = error instanceof Error ? error.message : String(error);
}
