export interface CharacterAsset {
  data: Blob;
  metadata: {
    fileName: string;
    contentType: string;
    size: number;
    cardJson?: string;
    source?: string;
    [key: string]: unknown;
  };
  updatedAt: string;
}

export interface CharacterAssetRepository {
  getAvatar(avatarFile: string): Promise<CharacterAsset | null>;
  putAvatar(
    avatarFile: string,
    data: Blob,
    metadata?: Partial<CharacterAsset['metadata']>,
  ): Promise<void>;
  deleteAvatar(avatarFile: string): Promise<void>;
  getRawCard(id: string): Promise<CharacterAsset | null>;
  putRawCard(id: string, data: Blob, metadata?: Partial<CharacterAsset['metadata']>): Promise<void>;
}
