import { afterEach, describe, expect, it } from 'vitest';

import { AppDatabase } from '@/platform/storage/app-database';
import {
  AppStorage,
  type ModuleBlobRecord,
  type ModuleBlobStore,
} from '@/platform/storage/app-storage';
import { initializeStorage } from '@/platform/storage/initialize-storage';

import { ArchiveParticipantRegistry } from '../application/archive-participant-registry';
import { ArchiveService } from '../application/archive-service';
import { LocalBackupTransport } from '../infrastructure/local-backup-transport';
import { MemoryBackupRepository } from '../infrastructure/resilient-backup-repository';
import { unpackTauriTavernArchive } from '../tauri-tavern/application/tauri-tavern-archive';
import { TauriTavernMigrationService } from '../tauri-tavern/application/tauri-tavern-service';

const databases: AppDatabase[] = [];

const CARD = { name: 'Seraphina', spec: 'chara_card_v2', data: { name: 'Seraphina' } };

const MODULES = [
  { moduleId: 'characters', displayName: 'Characters', sensitive: false, defaultSelected: true },
  { moduleId: 'chats', displayName: 'Chats & Messages', sensitive: false, defaultSelected: true },
  { moduleId: 'world-books', displayName: 'World Books', sensitive: false, defaultSelected: true },
  { moduleId: 'settings', displayName: 'Settings', sensitive: false, defaultSelected: true },
  { moduleId: 'secrets', displayName: 'Secrets', sensitive: true, defaultSelected: false },
];

/**
 * jsdom + fake-indexeddb 无法结构化克隆 Blob（取回来是个空对象），
 * 所以二进制部分在测试里走内存实现，记录部分仍然走真实的 IndexedDB。
 */
class MemoryBlobStore {
  readonly #records = new Map<string, ModuleBlobRecord & { collection: string }>();

  async get(collection: string, id: string): Promise<ModuleBlobRecord | null> {
    return this.#records.get(`${collection}/${id}`) ?? null;
  }

  async put(
    collection: string,
    id: string,
    data: Blob,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    this.#records.set(`${collection}/${id}`, {
      collection,
      id,
      data,
      metadata,
      updatedAt: new Date().toISOString(),
    });
  }

  async delete(collection: string, id: string): Promise<void> {
    this.#records.delete(`${collection}/${id}`);
  }

  async listAll() {
    return [...this.#records.values()];
  }

  async clearAll(): Promise<void> {
    this.#records.clear();
  }
}

function asBlobStore(store: MemoryBlobStore): ModuleBlobStore {
  return store as unknown as ModuleBlobStore;
}

async function createHarness() {
  const database = new AppDatabase(`pure-tavern-tauri-tavern-${crypto.randomUUID()}`);
  databases.push(database);
  const storage = new AppStorage(database);
  await initializeStorage(storage);

  const blobStores = new Map<string, MemoryBlobStore>();
  const participants = new ArchiveParticipantRegistry();
  for (const module of MODULES) {
    const blobs = new MemoryBlobStore();
    blobStores.set(module.moduleId, blobs);
    participants.registerModule({
      ...module,
      dataVersion: 1,
      records: storage.records.forModule(module.moduleId),
      blobs: asBlobStore(blobs),
    });
  }

  const archive = new ArchiveService(
    participants,
    new LocalBackupTransport(new MemoryBackupRepository()),
    storage.records.forModule('import-export'),
  );
  const migration = new TauriTavernMigrationService(participants, archive, {
    cardReader: () => ({ readCardFromPng: () => ({ ...CARD }) }),
    extensionMigration: () => null,
  });
  return { storage, archive, migration, blobStores };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function seed({ storage, blobStores }: Harness) {
  await storage.records.forModule('characters').put('cards', 'local-card-id', {
    id: 'local-card-id',
    avatarFile: 'Seraphina.png',
    card: CARD,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await blobStores
    .get('characters')
    ?.put('avatars', 'Seraphina.png', new Blob([new Uint8Array([1, 2, 3])]), {
      fileName: 'Seraphina.png',
    });
  await storage.records.forModule('chats').put('sessions', 'local-session-id', {
    id: 'local-session-id',
    ownerId: 'local-card-id',
    ownerAlias: 'Seraphina.png',
    characterName: 'Seraphina',
    legacyFileName: 'Session.jsonl',
    header: { user_name: 'User', chat_metadata: {} },
    chatMetadata: {},
    messageCount: 1,
    byteSize: 4,
    lastMessage: 'hello',
    lastMessageAt: '2026-02-02T00:00:00.000Z',
    createdAt: '2026-02-02T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
  });
  await storage.records
    .forModule('chats')
    .put('messages', 'local-session-id', [{ name: 'User', is_user: true, mes: 'hello' }]);
  await storage.records.forModule('world-books').put('books', 'book-id', {
    id: 'book-id',
    legacyFileId: 'Lore',
    name: 'Lore',
    document: { entries: {} },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await storage.records.forModule('world-books').put('aliases', 'Lore', { bookId: 'book-id' });
  await storage.records.forModule('settings').put('documents', 'current', { theme: 'dark' });
  await storage.records.forModule('secrets').put('store', 'current', {
    secrets: { api_key_openai: [{ id: 'a', value: 'sk-secret', label: 'main', active: true }] },
  });
}

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('TauriTavernMigrationService', () => {
  it('exports a data/default-user package and leaves secrets out by default', async () => {
    const harness = await createHarness();
    await seed(harness);
    const { migration } = harness;

    const exported = await migration.exportPackage();
    expect(exported.fileName).toMatch(/^tauritavern-data-\d{8}-\d{6}\.zip$/u);

    const files = await unpackTauriTavernArchive(exported.blob);
    expect(files.map((file) => file.path)).toEqual([
      'data/default-user/characters/Seraphina.png',
      'data/default-user/chats/Seraphina/Session.jsonl',
      'data/default-user/settings.json',
      'data/default-user/worlds/Lore.json',
    ]);
    expect(new TextDecoder().decode(await exported.blob.arrayBuffer())).not.toContain('sk-secret');

    const withSecrets = await migration.exportPackage({ includeSecrets: true });
    const secretFiles = await unpackTauriTavernArchive(withSecrets.blob);
    expect(secretFiles.map((file) => file.path)).toContain('data/default-user/secrets.json');
  });

  it('imports a package into a fresh browser through the shared archive pipeline', async () => {
    const source = await createHarness();
    await seed(source);
    const exported = await source.migration.exportPackage({ includeSecrets: true });

    const target = await createHarness();
    const preview = await target.migration.previewPackage(exported.blob, { includeSecrets: true });
    expect(preview.migration.files).toBe(5);
    expect(preview.modules.find((module) => module.moduleId === 'characters')).toMatchObject({
      available: true,
      selected: true,
      conflicts: 0,
    });

    const report = await target.migration.importPackage(exported.blob, { includeSecrets: true });
    expect(report.modules.every((module) => module.errors.length === 0)).toBe(true);
    // 导入前必须自动留下恢复点，这条路径和原生归档导入完全一致。
    expect(report.recoveryBackupId).toEqual(expect.any(String));

    const cards = await target.storage.records.forModule('characters').list('cards');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.value).toMatchObject({ avatarFile: 'Seraphina.png' });
    const avatar = await target.blobStores.get('characters')?.get('avatars', 'Seraphina.png');
    expect(avatar?.data.size).toBe(3);

    const sessions = await target.storage.records.forModule('chats').list('sessions');
    expect(sessions[0]?.value).toMatchObject({
      ownerId: cards[0]?.id,
      legacyFileName: 'Session.jsonl',
      characterName: 'Seraphina',
    });
    await expect(
      target.storage.records.forModule('settings').get('documents', 'current'),
    ).resolves.toMatchObject({ value: { theme: 'dark' } });
    await expect(
      target.storage.records.forModule('secrets').get('store', 'current'),
    ).resolves.toMatchObject({ value: { secrets: { api_key_openai: [{ value: 'sk-secret' }] } } });
  });

  it('importing the same package twice does not duplicate characters or chats', async () => {
    const source = await createHarness();
    await seed(source);
    const exported = await source.migration.exportPackage();

    const target = await createHarness();
    await target.migration.importPackage(exported.blob, { createRecoveryPoint: false });
    await target.migration.importPackage(exported.blob, { createRecoveryPoint: false });

    expect(await target.storage.records.forModule('characters').list('cards')).toHaveLength(1);
    expect(await target.storage.records.forModule('chats').list('sessions')).toHaveLength(1);
    expect(await target.storage.records.forModule('chats').list('messages')).toHaveLength(1);
  });

  it('reuses the id of a character that already exists locally', async () => {
    const source = await createHarness();
    await seed(source);
    const exported = await source.migration.exportPackage();

    // 目标端已经手动导过同一个角色，导入必须落到那条记录上而不是新建第二份。
    const target = await createHarness();
    await seed(target);
    await target.migration.importPackage(exported.blob, { createRecoveryPoint: false });

    const cards = await target.storage.records.forModule('characters').list('cards');
    expect(cards.map((card) => card.id)).toEqual(['local-card-id']);
    const sessions = await target.storage.records.forModule('chats').list('sessions');
    expect(sessions.map((session) => session.id)).toEqual(['local-session-id']);
  });

  it('converts a stored local recovery point into a TauriTavern package', async () => {
    const harness = await createHarness();
    await seed(harness);
    const { archive, migration } = harness;
    const backup = await archive.createBackup('Before migration');

    const converted = await migration.exportBackupPackage(backup.id);
    expect(converted).not.toBeNull();
    const files = await unpackTauriTavernArchive(converted!.blob);
    expect(files.map((file) => file.path)).toContain('data/default-user/characters/Seraphina.png');
    expect(await migration.exportBackupPackage('missing-id')).toBeNull();
  });
});
