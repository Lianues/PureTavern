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

  /**
   * 0.1.1 之前的导入会把整张角色卡 JSON 写进 avatar / raw-card 的 metadata，
   * 归档时这份冗余会被原样复制进 manifest.json。清掉存量数据，返回清理条数。
   */
  async purgeLegacyCardMetadata(): Promise<number> {
    const snapshots = await this.#blobs.listAll();
    let purged = 0;
    for (const snapshot of snapshots) {
      if (!hasLegacyCardJson(snapshot.metadata)) continue;
      await this.#blobs.put(
        snapshot.collection,
        snapshot.id,
        snapshot.data,
        withoutLegacyCardJson(snapshot.metadata),
      );
      purged += 1;
    }
    return purged;
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

function hasLegacyCardJson(metadata: Record<string, unknown>): boolean {
  return typeof metadata.cardJson === 'string';
}

function withoutLegacyCardJson(metadata: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...metadata };
  delete copy.cardJson;
  return copy;
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
    // cardJson 是历史冗余字段，读到就丢掉，避免再被写回去。
    ...withoutLegacyCardJson(metadata),
    fileName,
    contentType,
    size: data.size,
    ...(source !== undefined ? { source } : {}),
  };
}
