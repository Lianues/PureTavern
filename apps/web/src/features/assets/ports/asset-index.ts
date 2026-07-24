import type {
  AssetIndexQuery,
  AssetRecord,
  BackgroundFolder,
  ImageMetadata,
} from '../domain/asset';

export interface AssetIndex {
  get(id: string): Promise<AssetRecord | null>;
  getByLegacyPath(path: string): Promise<AssetRecord | null>;
  put(record: AssetRecord): Promise<void>;
  delete(id: string): Promise<void>;
  list(query?: AssetIndexQuery): Promise<AssetRecord[]>;

  setAlias(path: string, assetId: string): Promise<void>;
  deleteAlias(path: string): Promise<void>;
  moveAlias(fromPath: string, toPath: string, assetId: string): Promise<void>;

  listFolders(): Promise<BackgroundFolder[]>;
  getFolder(id: string): Promise<BackgroundFolder | null>;
  putFolder(folder: BackgroundFolder): Promise<void>;
  deleteFolder(id: string): Promise<void>;

  getImageMetadata(path: string): Promise<ImageMetadata | null>;
  putImageMetadata(path: string, metadata: ImageMetadata): Promise<void>;
  deleteImageMetadata(path: string): Promise<void>;
}
