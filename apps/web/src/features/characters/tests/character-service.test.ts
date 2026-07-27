import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppDatabase } from '@/platform/storage/app-database';
import { AppStorage } from '@/platform/storage/app-storage';
import { initializeStorage } from '@/platform/storage/initialize-storage';

import { CharacterService, type ProcessAvatarImage } from '../application/character-service';
import { CharacterCardCodec } from '../application/character-card-codec';
import { CharacterValidationError } from '../application/character-validation';
import { formatCharacterData } from '../domain/character-card';
import { IndexedDbCharacterAssetRepository } from '../infrastructure/indexeddb-character-asset-repository';
import { IndexedDbCharacterRepository } from '../infrastructure/indexeddb-character-repository';
import {
  MemoryCharacterRepository,
  ResilientCharacterRepository,
} from '../infrastructure/resilient-character-repository';
import type { CharacterRepository } from '../ports/character-repository';

const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

const databases: AppDatabase[] = [];

function bytesFromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function blobFromBytes(bytes: Uint8Array, type = 'image/png'): Blob {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([buffer], { type });
}

async function createHarness(
  deleteOwnerChats: ((ownerId: string) => Promise<void>) | null = null,
  processAvatar?: ProcessAvatarImage,
) {
  const database = new AppDatabase(`pure-tavern-character-test-${crypto.randomUUID()}`);
  databases.push(database);
  const storage = new AppStorage(database);
  await initializeStorage(storage);

  const records = storage.records.forModule('characters');
  const blobs = storage.blobs.forModule('characters');
  const repository = new IndexedDbCharacterRepository(records);
  const assets = new IndexedDbCharacterAssetRepository(blobs);
  const defaultAvatar = blobFromBytes(bytesFromBase64(ONE_BY_ONE_PNG_BASE64));
  const service = new CharacterService(
    repository,
    assets,
    async () => defaultAvatar,
    Promise.resolve('skipped'),
    undefined,
    deleteOwnerChats,
    processAvatar,
  );
  return { service, assets, repository, defaultAvatar };
}

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('CharacterService', () => {
  it('persists create/list/get/edit/delete through generic records and blobs', async () => {
    const { service, assets } = await createHarness();

    const avatar = await service.createCharacter({
      ch_name: 'Alice',
      description: 'Initial description',
      first_mes: 'Hello',
    });
    expect(avatar).toBe('Alice.png');
    await expect(assets.getAvatar('Alice.png')).resolves.toMatchObject({
      metadata: { fileName: 'Alice.png', contentType: 'image/png' },
    });

    await expect(service.listCharacters()).resolves.toMatchObject([
      { name: 'Alice', avatar: 'Alice.png', chat_size: 0 },
    ]);
    await expect(service.getCharacter('Alice.png')).resolves.toMatchObject({
      name: 'Alice',
      data: { first_mes: 'Hello' },
    });

    await service.editCharacter({
      avatar_url: 'Alice.png',
      ch_name: 'Alice',
      description: 'Edited description',
      first_mes: 'Hi again',
      chat: 'Alice - chat',
      create_date: '2026-01-01T00:00:00.000Z',
    });
    await expect(service.getCharacter('Alice.png')).resolves.toMatchObject({
      description: 'Edited description',
      chat: 'Alice - chat',
      create_date: '2026-01-01T00:00:00.000Z',
    });

    await service.deleteCharacter('Alice.png');
    await expect(service.listCharacters()).resolves.toEqual([]);
    await expect(assets.getAvatar('Alice.png')).resolves.toBeNull();
  });

  it('keeps the character card out of asset metadata', async () => {
    const { service, assets } = await createHarness();
    await service.createCharacter({ ch_name: 'Alice', description: 'Initial description' });

    const avatar = await assets.getAvatar('Alice.png');
    expect(avatar?.metadata).toMatchObject({ fileName: 'Alice.png' });
    expect(avatar?.metadata).not.toHaveProperty('cardJson');
  });

  it('keeps display name and avatar file decoupled for duplicate and rename', async () => {
    const { service, assets } = await createHarness();
    await service.createCharacter({ ch_name: 'Alice' });
    await service.createCharacter({ ch_name: 'Alice' });

    await expect(service.listCharacters()).resolves.toMatchObject([
      { name: 'Alice', avatar: 'Alice.png' },
      { name: 'Alice', avatar: 'Alice1.png' },
    ]);

    const duplicate = await service.duplicateCharacter('Alice.png');
    expect(duplicate).toBe('Alice_1.png');
    await service.renameCharacter('Alice_1.png', 'Bob');

    await expect(service.listCharacters()).resolves.toMatchObject([
      { name: 'Alice', avatar: 'Alice.png' },
      { name: 'Alice', avatar: 'Alice1.png' },
      { name: 'Bob', avatar: 'Bob.png' },
    ]);
    await expect(assets.getAvatar('Bob.png')).resolves.not.toBeNull();
    await expect(assets.getAvatar('Alice_1.png')).resolves.toBeNull();
  });

  it('forwards upstream crop data and copies duplicate avatar bytes without reprocessing', async () => {
    const crops: Parameters<ProcessAvatarImage>[1][] = [];
    const processAvatar: ProcessAvatarImage = async (image, crop) => {
      crops.push(crop);
      return image;
    };
    const { service, assets, defaultAvatar } = await createHarness(null, processAvatar);
    const createCrop = { x: 0, y: 0, width: 1, height: 1, want_resize: true };
    await service.createCharacter({ ch_name: 'Alice' }, defaultAvatar, createCrop);
    expect(crops).toEqual([createCrop]);

    const getAvatar = vi.spyOn(assets, 'getAvatar');
    const putAvatar = vi.spyOn(assets, 'putAvatar');
    const duplicate = await service.duplicateCharacter('Alice.png');
    const getResult = getAvatar.mock.results[0];
    const putCall = putAvatar.mock.calls[0];
    expect(getResult).toBeDefined();
    expect(putCall).toBeDefined();
    if (!getResult || !putCall) throw new Error('Duplicate did not copy its source avatar.');
    const copiedSource = await getResult.value;
    expect(crops).toEqual([createCrop]);
    expect(putAvatar).toHaveBeenCalledOnce();
    expect(putCall[0]).toBe(duplicate);
    expect(putCall[1]).toBe(copiedSource?.data);

    const editCrop = { x: 0, y: 0, width: 1, height: 1, want_resize: false };
    await service.editAvatar('Alice.png', defaultAvatar, editCrop);
    expect(crops.at(-1)).toEqual(editCrop);
    await service.editCharacter(
      { avatar_url: 'Alice.png', ch_name: 'Alice', first_mes: 'Updated' },
      defaultAvatar,
      createCrop,
    );
    expect(crops.at(-1)).toEqual(createCrop);
  });

  it('accepts avatars and imports whose reported sizes exceed former frontend quotas', async () => {
    const { service, defaultAvatar } = await createHarness();
    const largeAvatar = defaultAvatar.slice(0, defaultAvatar.size, 'image/png');
    Object.defineProperty(largeAvatar, 'size', { value: 25 * 1024 * 1024 + 1 });
    await expect(
      service.createCharacter({ ch_name: 'Large Avatar' }, largeAvatar),
    ).resolves.toBe('Large Avatar.png');

    const card = formatCharacterData({ ch_name: 'Large Import', first_mes: 'Hello' }, 1);
    const largeImport = new Blob([JSON.stringify(card)], { type: 'application/json' });
    Object.defineProperty(largeImport, 'size', { value: 50 * 1024 * 1024 + 1 });
    await expect(service.importCharacter(largeImport, 'json')).resolves.toBe('Large Import');
  });

  it('imports and exports JSON and PNG character cards', async () => {
    const { service } = await createHarness();
    const codec = new CharacterCardCodec();
    const card = formatCharacterData({ ch_name: 'Imported', first_mes: 'Hello from JSON' }, 1);
    const jsonFile = new Blob([JSON.stringify(card)], { type: 'application/json' });

    await expect(service.importCharacter(jsonFile, 'json')).resolves.toBe('Imported');
    const exportedJson = await service.exportCharacter('Imported.png', 'json');
    await expect(exportedJson.data.text()).resolves.toContain('Hello from JSON');

    const exportedPng = await service.exportCharacter('Imported.png', 'png');
    const exportedPngBytes = new Uint8Array(await exportedPng.data.arrayBuffer());
    expect(codec.readPngCard(exportedPngBytes).name).toBe('Imported');

    const pngName = await service.importCharacter(exportedPng.data, 'png');
    expect(pngName).toBe('Imported1');
  });

  it('supports attribute merge, bulk merge and M05-compatible empty chat list', async () => {
    const { service } = await createHarness();
    await service.createCharacter({ ch_name: 'Alice', first_mes: 'Hello' });
    await service.mergeAttributes({ avatar: 'Alice.png', chat: 'Alice - changed' });
    await expect(service.getCharacter('Alice.png')).resolves.toMatchObject({
      chat: 'Alice - changed',
    });

    const bulk = await service.mergeAttributesBulk({
      avatars: [],
      data: { data: { character_version: 'bulk' } },
      filter: { path: 'data.name' },
    });
    expect(bulk).toEqual({ updated: ['Alice.png'], skipped: [], failed: [] });
    await expect(service.getCharacter('Alice.png')).resolves.toMatchObject({
      data: { character_version: 'bulk' },
    });
    await expect(service.listChats()).resolves.toEqual([]);
  });

  it('exposes stable identity across rename and only invokes chat lifecycle deletion when requested', async () => {
    const deletedOwnerIds: string[] = [];
    const { service } = await createHarness(async (ownerId) => {
      deletedOwnerIds.push(ownerId);
    });
    await service.createCharacter({ ch_name: 'Keep Chats' });
    const keepIdentity = await service.resolveStableIdentity('Keep Chats.png');
    const renamedAvatar = await service.renameCharacter('Keep Chats.png', 'Keep Renamed');
    expect(renamedAvatar).toBe('Keep Renamed.png');
    expect(await service.resolveStableIdentity(renamedAvatar)).toEqual({
      ownerId: keepIdentity?.ownerId,
      avatarUrl: renamedAvatar,
    });
    expect(await service.getAvatarForStableIdentity(keepIdentity!.ownerId)).toBe(renamedAvatar);
    await service.deleteCharacter(renamedAvatar, false);
    expect(deletedOwnerIds).toEqual([]);

    await service.createCharacter({ ch_name: 'Delete Chats' });
    const deleteIdentity = await service.resolveStableIdentity('Delete Chats.png');
    await service.deleteCharacter('Delete Chats.png', true);
    expect(deletedOwnerIds).toEqual([deleteIdentity?.ownerId]);
  });

  it('reports memory degradation when IndexedDB fails', async () => {
    const unavailable: CharacterRepository = {
      async list() {
        throw new Error('IndexedDB unavailable');
      },
      async get() {
        throw new Error('IndexedDB unavailable');
      },
      async findByAvatar() {
        throw new Error('IndexedDB unavailable');
      },
      async save() {
        throw new Error('IndexedDB unavailable');
      },
      async delete() {
        throw new Error('IndexedDB unavailable');
      },
    };
    const repository = new ResilientCharacterRepository(
      unavailable,
      new MemoryCharacterRepository(),
    );

    await repository.save({
      id: 'id',
      avatarFile: 'Memory.png',
      card: formatCharacterData({ ch_name: 'Memory' }, 1),
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(1).toISOString(),
    });

    await expect(repository.list()).resolves.toHaveLength(1);
    expect(repository.diagnostics).toMatchObject({
      status: 'degraded',
      backend: 'memory',
      message: 'IndexedDB unavailable',
    });
  });

  it('rejects unsupported imports and unsafe avatar paths', async () => {
    const { service } = await createHarness();
    await expect(service.importCharacter(new Blob(['x']), 'yaml')).rejects.toThrow(
      CharacterValidationError,
    );
    await expect(service.getCharacter('../Alice.png')).rejects.toThrow(CharacterValidationError);
  });
});
