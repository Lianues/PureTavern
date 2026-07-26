import type { ModuleBlobStore } from '@/platform/storage/app-storage';

import type { CharacterAsset, CharacterAssetRepository } from '../ports/character-asset-repository';

const AVATARS_COLLECTION = 'avatars';
const RAW_CARDS_COLLECTION = 'raw-cards';

export class IndexedDbCharacterAssetRepository implements CharacterAssetRepository {
  readonly #blobs: ModuleBlobStore;

  constructor(blobs: ModuleBlobStore) {
    this.#blobs = blobs;
  }

  async getAvatar(avatarFile: string): Promise<CharacterAsset | null> {
    return this.#get(AVATARS_COLLECTION, avatarFile);
  }

  async putAvatar(
    avatarFile: string,
    data: Blob,
    metadata: Partial<CharacterAsset['metadata']> = {},
  ): Promise<void> {
    await this.#put(AVATARS_COLLECTION, avatarFile, data, metadata);
  }

  async deleteAvatar(avatarFile: string): Promise<void> {
    await this.#blobs.delete(AVATARS_COLLECTION, avatarFile);
  }

  async getRawCard(id: string): Promise<CharacterAsset | null> {
    return this.#get(RAW_CARDS_COLLECTION, id);
  }

  async putRawCard(
    id: string,
    data: Blob,
    metadata: Partial<CharacterAsset['metadata']> = {},
  ): Promise<void> {
    await this.#put(RAW_CARDS_COLLECTION, id, data, metadata);
  }

  async #get(collection: string, id: string): Promise<CharacterAsset | null> {
    const record = await this.#blobs.get(collection, id);
    if (!record) return null;
    return {
      data: record.data,
      metadata: normalizeMetadata(id, record.data, record.metadata),
      updatedAt: record.updatedAt,
    };
  }

  async #put(
    collection: string,
    id: string,
    data: Blob,
    metadata: Partial<CharacterAsset['metadata']>,
  ): Promise<void> {
    await this.#blobs.put(collection, id, data, normalizeMetadata(id, data, metadata));
  }
}

function normalizeMetadata(
  id: string,
  data: Blob,
  metadata: Record<string, unknown> | Partial<CharacterAsset['metadata']>,
): CharacterAsset['metadata'] {
  const fileName = typeof metadata.fileName === 'string' ? metadata.fileName : id;
  const contentType =
    typeof metadata.contentType === 'string'
      ? metadata.contentType
      : data.type || 'application/octet-stream';
  const source = typeof metadata.source === 'string' ? metadata.source : undefined;
  return {
    ...metadata,
    fileName,
    contentType,
    size: data.size,
    ...(source !== undefined ? { source } : {}),
  };
}
