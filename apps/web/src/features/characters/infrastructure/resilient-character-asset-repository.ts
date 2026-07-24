import type { CharacterAsset, CharacterAssetRepository } from '../ports/character-asset-repository';

export interface CharacterAssetStorageDiagnostics {
  status: 'ready' | 'degraded';
  backend: 'indexeddb' | 'memory';
  message: string | null;
  lastSavedAt: string | null;
}

export class MemoryCharacterAssetRepository implements CharacterAssetRepository {
  readonly #avatars = new Map<string, CharacterAsset>();
  readonly #rawCards = new Map<string, CharacterAsset>();

  async getAvatar(avatarFile: string): Promise<CharacterAsset | null> {
    return cloneAsset(this.#avatars.get(avatarFile) ?? null);
  }

  async putAvatar(
    avatarFile: string,
    data: Blob,
    metadata: Partial<CharacterAsset['metadata']> = {},
  ): Promise<void> {
    this.#avatars.set(avatarFile, makeAsset(avatarFile, data, metadata));
  }

  async deleteAvatar(avatarFile: string): Promise<void> {
    this.#avatars.delete(avatarFile);
  }

  async getRawCard(id: string): Promise<CharacterAsset | null> {
    return cloneAsset(this.#rawCards.get(id) ?? null);
  }

  async putRawCard(
    id: string,
    data: Blob,
    metadata: Partial<CharacterAsset['metadata']> = {},
  ): Promise<void> {
    this.#rawCards.set(id, makeAsset(id, data, metadata));
  }
}

export class ResilientCharacterAssetRepository implements CharacterAssetRepository {
  readonly diagnostics: CharacterAssetStorageDiagnostics = {
    status: 'ready',
    backend: 'indexeddb',
    message: null,
    lastSavedAt: null,
  };

  readonly #primary: CharacterAssetRepository;
  readonly #fallback: CharacterAssetRepository;

  constructor(
    primary: CharacterAssetRepository,
    fallback: CharacterAssetRepository = new MemoryCharacterAssetRepository(),
  ) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async getAvatar(avatarFile: string): Promise<CharacterAsset | null> {
    try {
      const asset = await this.#primary.getAvatar(avatarFile);
      if (asset) await this.#fallback.putAvatar(avatarFile, asset.data, asset.metadata);
      return asset;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.getAvatar(avatarFile);
    }
  }

  async putAvatar(
    avatarFile: string,
    data: Blob,
    metadata: Partial<CharacterAsset['metadata']> = {},
  ): Promise<void> {
    await this.#fallback.putAvatar(avatarFile, data, metadata);
    try {
      await this.#primary.putAvatar(avatarFile, data, metadata);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    } catch (error) {
      this.#degrade(error);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    }
  }

  async deleteAvatar(avatarFile: string): Promise<void> {
    await this.#fallback.deleteAvatar(avatarFile);
    try {
      await this.#primary.deleteAvatar(avatarFile);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    } catch (error) {
      this.#degrade(error);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    }
  }

  async getRawCard(id: string): Promise<CharacterAsset | null> {
    try {
      const asset = await this.#primary.getRawCard(id);
      if (asset) await this.#fallback.putRawCard(id, asset.data, asset.metadata);
      return asset;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.getRawCard(id);
    }
  }

  async putRawCard(
    id: string,
    data: Blob,
    metadata: Partial<CharacterAsset['metadata']> = {},
  ): Promise<void> {
    await this.#fallback.putRawCard(id, data, metadata);
    try {
      await this.#primary.putRawCard(id, data, metadata);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    } catch (error) {
      this.#degrade(error);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    }
  }

  #degrade(error: unknown) {
    this.diagnostics.status = 'degraded';
    this.diagnostics.backend = 'memory';
    this.diagnostics.message = error instanceof Error ? error.message : String(error);
  }
}

function makeAsset(
  id: string,
  data: Blob,
  metadata: Partial<CharacterAsset['metadata']>,
): CharacterAsset {
  return {
    data,
    metadata: {
      ...metadata,
      fileName: metadata.fileName ?? id,
      contentType: metadata.contentType ?? (data.type || 'application/octet-stream'),
      size: data.size,
    },
    updatedAt: new Date().toISOString(),
  };
}

function cloneAsset(asset: CharacterAsset | null): CharacterAsset | null {
  if (!asset) return null;
  return {
    data: asset.data,
    metadata: { ...asset.metadata },
    updatedAt: asset.updatedAt,
  };
}
