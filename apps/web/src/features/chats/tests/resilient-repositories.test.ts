import { describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '@/platform/storage/app-database';
import { AppStorage, ModuleRecordStore } from '@/platform/storage/app-storage';
import { initializeStorage } from '@/platform/storage/initialize-storage';
import { CapabilityRegistry } from '@/platform/features/capability-registry';
import { archiveParticipantRegistryCapability } from '@/platform/features/standard-capabilities';
import { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { ArchiveParticipantRegistry } from '@/features/import-export/application/archive-participant-registry';
import { chatsFeature } from '../module';

import type { StoredChatSession } from '../domain/chat';
import {
  MemoryChatRepository,
  MemoryMessageRepository,
  MemoryOwnerAliasRepository,
  ResilientChatRepository,
  ResilientMessageRepository,
  ResilientOwnerAliasRepository,
} from '../infrastructure/resilient-repositories';

function session(id: string, fileName = 'main.jsonl'): StoredChatSession {
  return {
    id,
    ownerId: 'owner',
    ownerAlias: 'Alice.png',
    characterName: 'Alice',
    legacyFileName: fileName,
    header: {},
    chatMetadata: {},
    messageCount: 1,
    byteSize: 1,
    lastMessage: id,
    lastMessageAt: 0,
    createdAt: '2026-10-12T00:00:00Z',
    updatedAt: '2026-10-12T00:00:00Z',
  };
}

const failure = new DOMException('Storage is full', 'QuotaExceededError');

describe('resilient chat repositories with readable stale storage', () => {
  it('keeps individual chat export available but rejects a stale full backup until persistence is retried', async () => {
    const database = new AppDatabase(`pending-chat-backup-${crypto.randomUUID()}`);
    const storage = new AppStorage(database);
    await initializeStorage(storage);
    const router = new CompatibilityRouter();
    const capabilities = new CapabilityRegistry();
    const participants = new ArchiveParticipantRegistry();
    capabilities.register(archiveParticipantRegistryCapability, participants);
    chatsFeature.install({
      router,
      capabilities,
      records: storage.records.forModule('chats'),
      blobs: storage.blobs.forModule('chats'),
      nativeFetch: fetch,
    });
    const original = ModuleRecordStore.prototype.put;
    const writing = vi.spyOn(ModuleRecordStore.prototype, 'put').mockImplementation(async function (
      this: ModuleRecordStore,
      collection,
      id,
      value,
    ) {
      if (collection === 'messages') throw failure;
      return original.call(this, collection, id, value);
    });
    const post = async (path: string, body: Record<string, unknown>) => {
      const url = new URL(`https://example.test${path}`);
      const response = await router.dispatch(
        new Request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        url,
      );
      return response!;
    };
    const body = {
      avatar_url: 'Alice.png',
      ch_name: 'Alice',
      file_name: 'main',
      chat: [{ chat_metadata: {} }, { name: 'Alice', mes: 'memory only' }],
    };
    try {
      expect((await post('/api/chats/save', body)).ok).toBe(true);
      const exported = await post('/api/chats/export', {
        avatar_url: 'Alice.png',
        file: 'main.jsonl',
        format: 'jsonl',
      });
      expect((await exported.json()).result).toContain('memory only');
      await expect(participants.get('chats')!.exportEntries()).rejects.toThrow(
        'only held in this page',
      );
      writing.mockRestore();
      expect((await post('/api/chats/save', body)).ok).toBe(true);
      expect(await participants.get('chats')!.exportEntries()).not.toHaveLength(0);
    } finally {
      writing.mockRestore();
      database.close();
      await database.delete();
    }
  });

  it('retains new messages after a failed write and clears pending state after a successful retry', async () => {
    const primary = new MemoryMessageRepository();
    await primary.save('chat', [{ mes: 'old' }]);
    const save = vi.spyOn(primary, 'save').mockRejectedValueOnce(failure);
    const repository = new ResilientMessageRepository(primary);
    await repository.save('chat', [{ mes: 'new' }]);
    expect(await repository.get('chat')).toEqual([{ mes: 'new' }]);
    expect(repository.hasPendingWrites()).toBe(true);
    await repository.save('chat', [{ mes: 'retried' }]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(repository.hasPendingWrites()).toBe(false);
    expect(repository.diagnostics).toMatchObject({
      status: 'ready',
      backend: 'indexeddb',
      pendingWrites: 0,
    });
    expect(await primary.get('chat')).toEqual([{ mes: 'retried' }]);
  });

  it('does not resurrect messages after a failed delete', async () => {
    const primary = new MemoryMessageRepository();
    await primary.save('chat', [{ mes: 'old' }]);
    vi.spyOn(primary, 'delete').mockRejectedValue(failure);
    const repository = new ResilientMessageRepository(primary);
    await repository.delete('chat');
    expect(await repository.get('chat')).toEqual([]);
  });

  it('merges pending new and renamed sessions with persisted sessions without resurrecting deletions', async () => {
    const primary = new MemoryChatRepository();
    await primary.save(session('renamed'));
    await primary.save(session('deleted', 'deleted.jsonl'));
    await primary.save(session('unchanged', 'unchanged.jsonl'));
    vi.spyOn(primary, 'save').mockRejectedValue(failure);
    vi.spyOn(primary, 'delete').mockRejectedValue(failure);
    const repository = new ResilientChatRepository(primary);
    await repository.save(session('renamed', 'renamed.jsonl'));
    await repository.save(session('new', 'new.jsonl'));
    await repository.delete('deleted');
    expect((await repository.list()).map((value) => value.id).sort()).toEqual([
      'new',
      'renamed',
      'unchanged',
    ]);
    expect(await repository.get('renamed')).toMatchObject({ legacyFileName: 'renamed.jsonl' });
    expect(await repository.findByOwnerAndFile('owner', 'main.jsonl')).toBeNull();
    expect(await repository.findByOwnerAndFile('owner', 'renamed.jsonl')).toMatchObject({
      id: 'renamed',
    });
    expect(await repository.get('deleted')).toBeNull();
  });

  it('retains a pending owner alias instead of replacing it with an old readable alias', async () => {
    const primary = new MemoryOwnerAliasRepository();
    await primary.save({ avatarUrl: 'Alice.png', ownerId: 'old', updatedAt: 'old' });
    vi.spyOn(primary, 'save').mockRejectedValue(failure);
    const repository = new ResilientOwnerAliasRepository(primary);
    await repository.save({ avatarUrl: 'Alice.png', ownerId: 'new', updatedAt: 'new' });
    expect(await repository.get('Alice.png')).toMatchObject({ ownerId: 'new' });
  });

  it('does not overwrite a pending value when an earlier primary read finishes late', async () => {
    let finish!: (value: { mes: string }[]) => void;
    const primary = new MemoryMessageRepository();
    vi.spyOn(primary, 'get').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.spyOn(primary, 'save').mockRejectedValue(failure);
    const repository = new ResilientMessageRepository(primary);
    const reading = repository.get('chat');
    await repository.save('chat', [{ mes: 'new' }]);
    finish([{ mes: 'old' }]);
    expect(await reading).toEqual([{ mes: 'new' }]);
    expect(await repository.get('chat')).toEqual([{ mes: 'new' }]);
  });
});
