export const ASSET_COLLECTIONS = [
  'backgrounds',
  'attachments',
  'user-images',
  'user-avatars',
  'sprites',
  'library',
] as const;

export type AssetCollection = (typeof ASSET_COLLECTIONS)[number];

export const ASSET_LIBRARY_CATEGORIES = [
  'bgm',
  'ambient',
  'blip',
  'live2d',
  'vrm',
  'character',
  'temp',
] as const;

export type AssetLibraryCategory = (typeof ASSET_LIBRARY_CATEGORIES)[number];

export interface ImageInfo {
  format: 'png' | 'jpeg' | 'gif' | 'webp';
  mimeType: string;
  width: number;
  height: number;
  isAnimated: boolean;
}

export interface ImageMetadata {
  path: string;
  addedTimestamp: number;
  width?: number;
  height?: number;
  aspectRatio?: number;
  dominantColor?: string;
  isAnimated?: boolean;
  [key: string]: unknown;
}

export interface AssetRecord {
  id: string;
  collection: AssetCollection;
  legacyPath: string;
  filename: string;
  mimeType: string;
  size: number;
  owner?: string;
  folder?: string;
  category?: AssetLibraryCategory;
  label?: string;
  spriteName?: string;
  folderIds?: string[];
  image?: ImageInfo;
  imageMetadata?: ImageMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface BackgroundFolder {
  id: string;
  name: string;
  thumbnailFile: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetIndexQuery {
  collection?: AssetCollection;
  owner?: string;
  folder?: string;
  category?: AssetLibraryCategory;
  mimePrefix?: string;
  sortBy?: 'filename' | 'createdAt' | 'updatedAt';
  direction?: 'asc' | 'desc';
}

export function cloneAssetRecord(record: AssetRecord): AssetRecord {
  return structuredClone(record);
}

export function cloneBackgroundFolder(folder: BackgroundFolder): BackgroundFolder {
  return structuredClone(folder);
}
