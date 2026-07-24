import { afterEach, describe, expect, it } from 'vitest';

import type { CharacterIdentityCapability } from '@/platform/features/standard-capabilities';
import { AppDatabase } from '@/platform/storage/app-database';
import { AppStorage } from '@/platform/storage/app-storage';
import { initializeStorage } from '@/platform/storage/initialize-storage';

import { ChatIntegrityError, ChatService } from '../application/chat-service';
import { OwnerIdentityResolver } from '../application/owner-identity-resolver';
import { BrowserChatImportExportAdapter } from '../infrastructure/chat-import-export-adapter';
import { IndexedDbChatRepository } from '../infrastructure/indexeddb-chat-repository';
import { IndexedDbMessageRepository } from '../infrastructure/indexeddb-message-repository';
import { IndexedDbOwnerAliasRepository } from '../infrastructure/indexeddb-owner-alias-repository';
import {
  MemoryChatRepository,
  MemoryMessageRepository,
  MemoryOwnerAliasRepository,
  ResilientChatRepository,
  ResilientMessageRepository,
} from '../infrastructure/resilient-repositories';
import type { ChatRepository } from '../ports/chat-repository';
import type { MessageRepository } from '../ports/message-repository';

const databases: AppDatabase[] = [];

async function createHarness(identity: CharacterIdentityCapability | null = null) {
  const database = new AppDatabase(`pure-tavern-chat-test-${crypto.randomUUID()}`);
  databases.push(database);
  const storage = new AppStorage(database);
  await initializeStorage(storage);
  const records = storage.records.forModule('chats');
  const chats = new IndexedDbChatRepository(records);
  const messages = new IndexedDbMessageRepository(records);
  const aliases = new IndexedDbOwnerAliasRepository(records);
  let nowMs = Date.parse('2026-07-24T00:00:00.000Z');
  let nextId = 0;
  const service = new ChatService(
    chats,
    messages,
    new OwnerIdentityResolver(aliases, identity),
    new BrowserChatImportExportAdapter(() => new Date(nowMs)),
    () => new Date(nowMs),
    () => `chat-${++nextId}`,
  );
  return {
    service,
    chats,
    messages,
    records,
    advance(milliseconds = 1_000) {
      nowMs += milliseconds;
    },
  };
}

function chatDocument(message: string, integrity = 'integrity-a') {
  return [
    {
      chat_metadata: { integrity, custom: { nested: true } },
      user_name: 'unused',
      character_name: 'unused',
      future_header: 'preserved',
    },
    {
      name: 'Alice',
      is_user: false,
      send_date: '2026-07-24T00:00:00.000Z',
      mes: message,
      extra: { bookmark_link: 'branch.jsonl', custom: ['opaque'] },
      swipes: ['one', 'two'],
      swipe_id: 1,
      swipe_info: [{ extra: { future: 42 } }],
      future_message_field: { retained: true },
    },
  ];
}

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('ChatService and repositories', () => {
  it('stores sessions and opaque messages in fixed generic collections and restores the document', async () => {
    const { service, chats, records } = await createHarness();

    const saved = await service.saveChat({
      avatarUrl: 'Alice.png',
      characterName: 'Alice',
      fileName: 'Alice - main',
      chat: chatDocument('Hello'),
    });

    expect(saved).toMatchObject({
      id: 'chat-1',
      legacyFileName: 'Alice - main.jsonl',
      messageCount: 1,
      chatMetadata: { integrity: 'integrity-a', custom: { nested: true } },
    });
    expect(await records.list('sessions')).toHaveLength(1);
    expect(await records.list('messages')).toHaveLength(1);
    expect(await service.getChat('Alice.png', 'Alice - main')).toEqual(chatDocument('Hello'));

    const beforeRename = await chats.get(saved.id);
    const renamed = await service.renameChat(
      'Alice.png',
      'Alice - main.jsonl',
      'Alice renamed.jsonl',
    );
    expect(renamed).toEqual({ sanitizedFileName: 'Alice renamed', chatId: saved.id });
    expect((await chats.get(saved.id))?.id).toBe(beforeRename?.id);
    expect(await service.getChat('Alice.png', 'Alice renamed')).toEqual(chatDocument('Hello'));

    await service.deleteChat('Alice.png', 'Alice renamed.jsonl');
    expect(await service.getChat('Alice.png', 'Alice renamed')).toEqual([]);
    expect(await records.list('sessions')).toEqual([]);
    expect(await records.list('messages')).toEqual([]);
  });

  it('serializes same-owner writes, applies last-writer-wins, and enforces integrity unless forced', async () => {
    class DelayedChatRepository extends MemoryChatRepository {
      override async save(session: Parameters<MemoryChatRepository['save']>[0]): Promise<void> {
        if (session.lastMessage === 'first') {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await super.save(session);
      }
    }
    const chats = new DelayedChatRepository();
    const service = new ChatService(
      chats,
      new MemoryMessageRepository(),
      new OwnerIdentityResolver(new MemoryOwnerAliasRepository()),
      new BrowserChatImportExportAdapter(),
      () => new Date('2026-07-24T00:00:00.000Z'),
      () => 'stable-chat',
    );

    const first = service.saveChat({
      avatarUrl: 'Alice.png',
      characterName: 'Alice',
      fileName: 'main',
      chat: chatDocument('first'),
    });
    await Promise.resolve();
    const second = service.saveChat({
      avatarUrl: 'Alice.png',
      characterName: 'Alice',
      fileName: 'main',
      chat: chatDocument('second'),
    });
    await Promise.all([first, second]);
    expect((await service.getChat('Alice.png', 'main')).at(-1)?.mes).toBe('second');

    await expect(
      service.saveChat({
        avatarUrl: 'Alice.png',
        characterName: 'Alice',
        fileName: 'main',
        chat: chatDocument('conflict', 'integrity-b'),
      }),
    ).rejects.toBeInstanceOf(ChatIntegrityError);
    await expect(
      service.saveChat({
        avatarUrl: 'Alice.png',
        characterName: 'Alice',
        fileName: 'main',
        chat: chatDocument('forced', 'integrity-b'),
        force: true,
      }),
    ).resolves.toMatchObject({ lastMessage: 'forced' });
  });

  it('supports fragment search, compatible owner lists, recent pinned/max ordering and metadata', async () => {
    const { service, advance } = await createHarness();
    await service.saveChat({
      avatarUrl: 'Alice.png',
      characterName: 'Alice',
      fileName: 'older',
      chat: chatDocument('alpha text'),
    });
    advance();
    await service.saveChat({
      avatarUrl: 'Alice.png',
      characterName: 'Alice',
      fileName: 'newer',
      chat: chatDocument('beta text'),
    });

    await expect(service.searchChats('Alice.png', 'alpha text')).resolves.toMatchObject([
      { file_name: 'older', message_count: 1, preview_message: 'alpha text' },
    ]);
    await expect(service.searchChats('Alice.png', 'newer')).resolves.toMatchObject([
      { file_name: 'newer' },
    ]);
    await expect(service.listOwnerChats('Alice.png', { simple: true })).resolves.toEqual([
      { file_name: 'newer.jsonl', file_id: 'newer' },
      { file_name: 'older.jsonl', file_id: 'older' },
    ]);
    const detailed = await service.listOwnerChats('Alice.png', { metadata: true });
    expect(detailed[0]).toMatchObject({
      file_name: 'newer.jsonl',
      chat_items: 1,
      chat_metadata: { integrity: 'integrity-a' },
    });

    const recent = await service.recentChats(1, [
      { avatar: 'Alice.png', file_name: 'older.jsonl' },
    ]);
    expect(recent.map((item) => item.file_name)).toEqual(['older.jsonl', 'newer.jsonl']);
    expect(recent[0]).toMatchObject({
      avatar: 'Alice.png',
      file_id: 'older',
      chat_items: 1,
      mes: 'alpha text',
    });
  });

  it('uses stable Character identity across avatar rename and supports owner lifecycle deletion', async () => {
    let currentAvatar = 'Alice.png';
    const identity: CharacterIdentityCapability = {
      async resolveAvatarUrl(avatarUrl) {
        return ['Alice.png', 'Renamed.png'].includes(avatarUrl)
          ? { ownerId: 'character-stable-id', avatarUrl }
          : null;
      },
      async getAvatarUrl(ownerId) {
        return ownerId === 'character-stable-id' ? currentAvatar : null;
      },
    };
    const { service, chats } = await createHarness(identity);
    const saved = await service.saveChat({
      avatarUrl: 'Alice.png',
      characterName: 'Alice',
      fileName: 'main',
      chat: chatDocument('survives rename'),
    });
    currentAvatar = 'Renamed.png';

    expect(await service.getChat('Renamed.png', 'main')).toHaveLength(2);
    expect(await service.recentChats(10, [])).toMatchObject([
      { avatar: 'Renamed.png', file_name: 'main.jsonl' },
    ]);
    expect((await chats.get(saved.id))?.ownerId).toBe('character-stable-id');

    await service.deleteChatsForOwner('character-stable-id');
    expect(await chats.list()).toEqual([]);
  });

  it('keeps a stable fallback alias and degrades repositories to memory when IndexedDB fails', async () => {
    const unavailableChats: ChatRepository = {
      async list() {
        throw new Error('IndexedDB unavailable');
      },
      async get() {
        throw new Error('IndexedDB unavailable');
      },
      async findByOwnerAndFile() {
        throw new Error('IndexedDB unavailable');
      },
      async save() {
        throw new Error('IndexedDB unavailable');
      },
      async delete() {
        throw new Error('IndexedDB unavailable');
      },
    };
    const unavailableMessages: MessageRepository = {
      async get() {
        throw new Error('IndexedDB unavailable');
      },
      async save() {
        throw new Error('IndexedDB unavailable');
      },
      async delete() {
        throw new Error('IndexedDB unavailable');
      },
    };
    const chats = new ResilientChatRepository(unavailableChats);
    const messages = new ResilientMessageRepository(unavailableMessages);
    const aliases = new MemoryOwnerAliasRepository();
    const owners = new OwnerIdentityResolver(aliases);
    const firstIdentity = await owners.resolve('Memory.png');
    const secondIdentity = await owners.resolve('Memory.png');
    expect(secondIdentity.ownerId).toBe(firstIdentity.ownerId);

    const service = new ChatService(chats, messages, owners, new BrowserChatImportExportAdapter());
    await service.saveChat({
      avatarUrl: 'Memory.png',
      characterName: 'Memory',
      fileName: 'main',
      chat: chatDocument('memory only'),
    });
    expect(await service.getChat('Memory.png', 'main')).toHaveLength(2);
    expect(chats.diagnostics).toMatchObject({
      status: 'degraded',
      backend: 'memory',
      message: 'IndexedDB unavailable',
    });
    expect(messages.diagnostics.backend).toBe('memory');
  });
});
