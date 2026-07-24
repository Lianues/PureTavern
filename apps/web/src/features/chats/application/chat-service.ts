import {
  byteLength,
  cloneJson,
  combineLegacyChat,
  formatBytes,
  isJsonObject,
  legacyFileId,
  normalizeLegacyFileName,
  previewMessage,
  readChatMetadata,
  serializeJsonl,
  splitLegacyChat,
  type ChatDocument,
  type ChatInfoDto,
  type ChatSearchResultDto,
  type OpaqueJsonObject,
  type RecentChatDto,
  type StoredChatSession,
} from '../domain/chat';
import type { ChatImportExportPort } from '../ports/chat-import-export-port';
import type { ChatRepository } from '../ports/chat-repository';
import type { MessageRepository } from '../ports/message-repository';
import type { OwnerIdentityResolver } from './owner-identity-resolver';

export class ChatValidationError extends Error {}
export class ChatIntegrityError extends Error {}
export class ChatNotFoundError extends Error {}
export class ChatConflictError extends Error {}

export interface SaveChatInput {
  avatarUrl: unknown;
  characterName: unknown;
  fileName: unknown;
  chat: unknown;
  force?: unknown;
}

export interface PinnedChatInput {
  file_name?: unknown;
  avatar?: unknown;
  group?: unknown;
}

export class ChatService {
  readonly #chats: ChatRepository;
  readonly #messages: MessageRepository;
  readonly #owners: OwnerIdentityResolver;
  readonly #codec: ChatImportExportPort;
  readonly #now: () => Date;
  readonly #uuid: () => string;
  readonly #serial = new KeyedSerialQueue();

  constructor(
    chats: ChatRepository,
    messages: MessageRepository,
    owners: OwnerIdentityResolver,
    codec: ChatImportExportPort,
    now: () => Date = () => new Date(),
    uuid: () => string = () => crypto.randomUUID(),
  ) {
    this.#chats = chats;
    this.#messages = messages;
    this.#owners = owners;
    this.#codec = codec;
    this.#now = now;
    this.#uuid = uuid;
  }

  async saveChat(input: SaveChatInput): Promise<StoredChatSession> {
    if (!Array.isArray(input.chat)) {
      throw new ChatValidationError("The request's body.chat is not an array.");
    }
    const chat = input.chat;
    const owner = await this.#owners.resolve(input.avatarUrl);
    const legacyFileName = this.#fileName(input.fileName);

    return this.#serial.run(owner.ownerId, async () => {
      let document: ChatDocument;
      try {
        document = splitLegacyChat(chat);
      } catch (error) {
        throw new ChatValidationError(error instanceof Error ? error.message : String(error));
      }
      const chatMetadata = readChatMetadata(document.header);
      const existing = await this.#chats.findByOwnerAndFile(owner.ownerId, legacyFileName);
      const incomingIntegrity = chatMetadata.integrity;
      const storedIntegrity = existing?.chatMetadata.integrity;
      if (
        existing &&
        incomingIntegrity &&
        storedIntegrity &&
        incomingIntegrity !== storedIntegrity &&
        input.force !== true
      ) {
        throw new ChatIntegrityError('Chat integrity check failed.');
      }

      const now = this.#now().toISOString();
      const serialized = serializeJsonl(document);
      const lastMessage = document.messages.at(-1);
      const session: StoredChatSession = {
        id: existing?.id ?? this.#uuid(),
        ownerId: owner.ownerId,
        ownerAlias: owner.avatarUrl,
        characterName: String(input.characterName ?? existing?.characterName ?? ''),
        legacyFileName,
        header: cloneJson(document.header),
        chatMetadata,
        messageCount: document.messages.length,
        byteSize: byteLength(serialized),
        lastMessage: lastMessage
          ? String(lastMessage.mes ?? '[The message is empty]')
          : '[The chat is empty]',
        lastMessageAt: readMessageDate(lastMessage) ?? now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      await this.#messages.save(session.id, document.messages);
      await this.#chats.save(session);
      return cloneJson(session);
    });
  }

  async getChat(avatarUrl: unknown, fileName: unknown): Promise<OpaqueJsonObject[]> {
    if (!fileName) return [];
    const owner = await this.#owners.resolve(avatarUrl);
    const legacyFileName = this.#fileName(fileName);
    return this.#serial.run(owner.ownerId, async () => {
      const session = await this.#chats.findByOwnerAndFile(owner.ownerId, legacyFileName);
      if (!session) return [];
      const messages = await this.#messages.get(session.id);
      return combineLegacyChat({ header: session.header, messages });
    });
  }

  async renameChat(
    avatarUrl: unknown,
    originalFile: unknown,
    renamedFile: unknown,
  ): Promise<{ sanitizedFileName: string; chatId: string }> {
    const owner = await this.#owners.resolve(avatarUrl);
    const original = this.#fileName(originalFile);
    const renamed = this.#fileName(renamedFile);
    return this.#serial.run(owner.ownerId, async () => {
      const session = await this.#chats.findByOwnerAndFile(owner.ownerId, original);
      if (!session) throw new ChatNotFoundError(`Chat not found: ${original}`);
      const collision = await this.#chats.findByOwnerAndFile(owner.ownerId, renamed);
      if (collision && collision.id !== session.id) {
        throw new ChatConflictError(`Chat already exists: ${renamed}`);
      }
      if (session.legacyFileName !== renamed) {
        session.legacyFileName = renamed;
        session.ownerAlias = owner.avatarUrl;
        session.updatedAt = this.#now().toISOString();
        await this.#chats.save(session);
      }
      return { sanitizedFileName: legacyFileId(renamed), chatId: session.id };
    });
  }

  async deleteChat(avatarUrl: unknown, fileName: unknown): Promise<void> {
    const owner = await this.#owners.resolve(avatarUrl);
    const legacyFileName = this.#fileName(fileName);
    await this.#serial.run(owner.ownerId, async () => {
      const session = await this.#chats.findByOwnerAndFile(owner.ownerId, legacyFileName);
      if (!session) return;
      await this.#messages.delete(session.id);
      await this.#chats.delete(session.id);
    });
  }

  async deleteChatsForOwner(ownerId: string): Promise<void> {
    await this.#serial.run(ownerId, async () => {
      const sessions = (await this.#chats.list()).filter((session) => session.ownerId === ownerId);
      for (const session of sessions) {
        await this.#messages.delete(session.id);
        await this.#chats.delete(session.id);
      }
    });
  }

  async listOwnerChats(
    avatarUrl: unknown,
    options: { simple?: boolean; metadata?: boolean } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const owner = await this.#owners.resolve(avatarUrl);
    return this.#serial.run(owner.ownerId, async () => {
      const sessions = (await this.#chats.list())
        .filter((session) => session.ownerId === owner.ownerId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      if (options.simple) {
        return sessions.map((session) => ({
          file_name: session.legacyFileName,
          file_id: legacyFileId(session.legacyFileName),
        }));
      }
      return sessions.map((session) => this.#chatInfo(session, options.metadata));
    });
  }

  async searchChats(avatarUrl: unknown, queryInput: unknown): Promise<ChatSearchResultDto[]> {
    const owner = await this.#owners.resolve(avatarUrl);
    const query = String(queryInput ?? '');
    const fragments = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);

    return this.#serial.run(owner.ownerId, async () => {
      const sessions = (await this.#chats.list()).filter(
        (session) => session.ownerId === owner.ownerId,
      );
      const results: ChatSearchResultDto[] = [];
      for (const session of sessions) {
        const messages = fragments.length > 0 ? await this.#messages.get(session.id) : [];
        const messageText = messages.map((message) =>
          String(message.mes ?? '').toLocaleLowerCase(),
        );
        const messageMatch = fragments.every((fragment) =>
          messageText.some((text) => text.includes(fragment)),
        );
        const fileText = legacyFileId(session.legacyFileName).toLocaleLowerCase();
        const fileMatch = fragments.every((fragment) => fileText.includes(fragment));
        if (fragments.length > 0 && !messageMatch && !fileMatch) continue;
        results.push({
          file_name: legacyFileId(session.legacyFileName),
          file_size: formatBytes(session.byteSize),
          message_count: session.messageCount,
          last_mes: session.lastMessageAt,
          preview_message: previewMessage(session.lastMessage),
        });
      }
      return results;
    });
  }

  async recentChats(
    maxInput: unknown,
    pinnedInput: unknown,
    withMetadata = false,
  ): Promise<RecentChatDto[]> {
    const pinned = Array.isArray(pinnedInput)
      ? (pinnedInput.filter(isJsonObject) as PinnedChatInput[])
      : [];
    const sessions = await this.#chats.list();
    const enriched = await Promise.all(
      sessions.map(async (session) => ({
        session,
        avatar: await this.#owners.getCurrentAvatar(session.ownerId, session.ownerAlias),
      })),
    );
    const isPinned = ({ session, avatar }: (typeof enriched)[number]) =>
      pinned.some(
        (item) =>
          String(item.file_name ?? '') === session.legacyFileName &&
          String(item.avatar ?? '') === avatar &&
          !item.group,
      );
    enriched.sort((left, right) => {
      const leftPinned = isPinned(left);
      const rightPinned = isPinned(right);
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      return right.session.updatedAt.localeCompare(left.session.updatedAt);
    });

    const parsedMax = Number.parseInt(String(maxInput ?? Number.MAX_SAFE_INTEGER), 10);
    const max = Number.isFinite(parsedMax)
      ? Math.max(0, parsedMax) + pinned.length
      : Number.MAX_SAFE_INTEGER;
    return enriched.slice(0, max).map(({ session, avatar }) => ({
      avatar,
      ...this.#chatInfo(session, withMetadata),
    }));
  }

  async importChats(input: {
    avatarUrl: unknown;
    characterName: unknown;
    userName: unknown;
    fileType: unknown;
    file: Blob;
  }): Promise<string[]> {
    const owner = await this.#owners.resolve(input.avatarUrl);
    const fileType = String(input.fileType ?? '').toLocaleLowerCase();
    if (fileType !== 'json' && fileType !== 'jsonl') {
      throw new ChatValidationError(`Unsupported chat import format: ${fileType}.`);
    }
    const characterName = String(input.characterName ?? 'Character').trim() || 'Character';
    const userName = String(input.userName ?? 'User').trim() || 'User';
    const documents = await this.#codec.import(input.file, { fileType, characterName, userName });
    if (documents.length === 0) throw new ChatValidationError('Chat import contains no chats.');

    return this.#serial.run(owner.ownerId, async () => {
      const existing = new Set(
        (await this.#chats.list())
          .filter((session) => session.ownerId === owner.ownerId)
          .map((session) => session.legacyFileName),
      );
      const fileNames: string[] = [];
      for (const [index, document] of documents.entries()) {
        const candidate = this.#uniqueImportedFileName(characterName, existing, index);
        existing.add(candidate);
        await this.#saveDocument(owner, characterName, candidate, document);
        fileNames.push(candidate);
      }
      return fileNames;
    });
  }

  async exportChat(input: {
    avatarUrl: unknown;
    fileName: unknown;
    exportFileName: unknown;
    format: unknown;
  }): Promise<{ message: string; result: string }> {
    const owner = await this.#owners.resolve(input.avatarUrl);
    const legacyFileName = this.#fileName(input.fileName);
    const format = String(input.format ?? '').toLocaleLowerCase();
    if (format !== 'jsonl' && format !== 'txt') {
      throw new ChatValidationError(`Unsupported chat export format: ${format}.`);
    }
    return this.#serial.run(owner.ownerId, async () => {
      const session = await this.#chats.findByOwnerAndFile(owner.ownerId, legacyFileName);
      if (!session) throw new ChatNotFoundError(`Chat not found: ${legacyFileName}`);
      const messages = await this.#messages.get(session.id);
      const result = this.#codec.export({ header: session.header, messages }, format);
      const exportFileName = String(input.exportFileName ?? legacyFileName);
      return { message: `Chat saved to ${exportFileName}`, result };
    });
  }

  async #saveDocument(
    owner: { ownerId: string; avatarUrl: string },
    characterName: string,
    legacyFileName: string,
    document: ChatDocument,
  ): Promise<StoredChatSession> {
    const now = this.#now().toISOString();
    const serialized = serializeJsonl(document);
    const lastMessage = document.messages.at(-1);
    const session: StoredChatSession = {
      id: this.#uuid(),
      ownerId: owner.ownerId,
      ownerAlias: owner.avatarUrl,
      characterName,
      legacyFileName,
      header: cloneJson(document.header),
      chatMetadata: readChatMetadata(document.header),
      messageCount: document.messages.length,
      byteSize: byteLength(serialized),
      lastMessage: lastMessage
        ? String(lastMessage.mes ?? '[The message is empty]')
        : '[The chat is empty]',
      lastMessageAt: readMessageDate(lastMessage) ?? now,
      createdAt: now,
      updatedAt: now,
    };
    await this.#messages.save(session.id, document.messages);
    await this.#chats.save(session);
    return session;
  }

  #chatInfo(session: StoredChatSession, withMetadata = false): ChatInfoDto {
    return {
      file_id: legacyFileId(session.legacyFileName),
      file_name: session.legacyFileName,
      file_size: formatBytes(session.byteSize),
      chat_items: session.messageCount,
      mes: session.lastMessage,
      last_mes: session.lastMessageAt,
      ...(withMetadata ? { chat_metadata: cloneJson(session.chatMetadata) } : {}),
    };
  }

  #uniqueImportedFileName(
    characterName: string,
    existing: Set<string>,
    documentIndex: number,
  ): string {
    const timestamp = this.#now().toISOString().replace(/[:.]/gu, '-');
    const base = `${characterName} - ${timestamp} imported${documentIndex > 0 ? ` ${documentIndex + 1}` : ''}`;
    let candidate = this.#fileName(base);
    let suffix = 1;
    while (existing.has(candidate)) candidate = this.#fileName(`${base} ${suffix++}`);
    return candidate;
  }

  #fileName(input: unknown): string {
    try {
      return normalizeLegacyFileName(input);
    } catch (error) {
      throw new ChatValidationError(error instanceof Error ? error.message : String(error));
    }
  }
}

function readMessageDate(message: OpaqueJsonObject | undefined): string | number | null {
  const value = message?.send_date;
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

class KeyedSerialQueue {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
