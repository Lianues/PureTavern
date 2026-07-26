export interface CharacterAsset {
  data: Blob;
  // 只放定位资产必需的信息：角色卡本体已经在 characters 记录和 PNG 内嵌数据里各存了一份，
  // 再往 metadata 里塞一份会被原样复制进归档 manifest。
  metadata: {
    fileName: string;
    contentType: string;
    size: number;
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
