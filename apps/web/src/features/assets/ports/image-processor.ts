import type { AvatarCropData } from '@/platform/features/standard-capabilities';

import type { ImageInfo } from '../domain/asset';

export type AvatarCrop = AvatarCropData;

export interface DecodedAssetData {
  blob: Blob;
  declaredMimeType: string | null;
}

export interface ProcessedImage {
  blob: Blob;
  info: ImageInfo;
  processed: boolean;
}

export interface ImageProcessorDiagnostics {
  status: 'ready' | 'degraded';
  message: string | null;
  lastUnsupportedAt: string | null;
}

export interface ImageProcessor {
  readonly diagnostics: ImageProcessorDiagnostics;
  decodeBase64(value: string, fallbackMimeType?: string): DecodedAssetData;
  inspect(blob: Blob): Promise<ImageInfo>;
  processAvatar(blob: Blob, crop?: AvatarCrop): Promise<ProcessedImage>;
}
