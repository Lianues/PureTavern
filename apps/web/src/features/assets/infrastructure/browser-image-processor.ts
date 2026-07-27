import {
  AssetValidationError,
  ImageProcessingUnsupportedError,
} from '../application/asset-errors';
import type { ImageInfo } from '../domain/asset';
import type {
  AvatarCrop,
  DecodedAssetData,
  ImageProcessor,
  ImageProcessorDiagnostics,
  ProcessedImage,
} from '../ports/image-processor';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
export const AVATAR_WIDTH = 512;
export const AVATAR_HEIGHT = 768;
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export class BrowserImageProcessor implements ImageProcessor {
  readonly diagnostics: ImageProcessorDiagnostics = {
    status: 'ready',
    message: null,
    lastUnsupportedAt: null,
  };

  decodeBase64(value: string, fallbackMimeType = 'application/octet-stream'): DecodedAssetData {
    if (typeof value !== 'string' || !value.trim()) {
      throw new AssetValidationError('Base64 data must be a non-empty string.');
    }

    let encoded = value.trim();
    let declaredMimeType: string | null = null;
    if (encoded.startsWith('data:')) {
      const match = /^data:([^;,]+)?;base64,([\s\S]*)$/i.exec(encoded);
      if (!match) throw new AssetValidationError('Only base64 Data URLs are supported.');
      declaredMimeType = match[1]?.toLowerCase() ?? fallbackMimeType;
      encoded = match[2] ?? '';
    }
    encoded = encoded.replace(/\s/g, '');
    if (!encoded || encoded.length % 4 === 1 || !/^[a-z\d+/]*={0,2}$/i.test(encoded)) {
      throw new AssetValidationError('Asset data is not valid base64.');
    }

    let binary: string;
    try {
      binary = atob(encoded);
    } catch {
      throw new AssetValidationError('Asset data is not valid base64.');
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const mimeType = declaredMimeType ?? fallbackMimeType;
    return {
      blob: blobFromBytes(bytes, mimeType),
      declaredMimeType,
    };
  }

  async inspect(blob: Blob): Promise<ImageInfo> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (hasPrefix(bytes, PNG_SIGNATURE)) return inspectPng(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return inspectJpeg(bytes);
    if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') {
      return inspectGif(bytes);
    }
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
      return inspectWebp(bytes);
    }
    throw new AssetValidationError(
      'Unsupported image signature. Expected PNG, JPEG, GIF, or WebP.',
    );
  }

  async processAvatar(blob: Blob, crop?: AvatarCrop): Promise<ProcessedImage> {
    const originalInfo = await this.inspect(blob);
    if (crop) validateCrop(crop, originalInfo);

    const createBitmap = globalThis.createImageBitmap;
    if (typeof createBitmap !== 'function') {
      throw this.#unsupported(
        'createImageBitmap is unavailable; the avatar could not be processed as an upstream PNG.',
      );
    }

    const source = crop
      ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height }
      : { x: 0, y: 0, width: originalInfo.width, height: originalInfo.height };
    const outputWidth = crop?.want_resize ? AVATAR_WIDTH : Math.max(1, Math.round(source.width));
    const outputHeight = crop?.want_resize ? AVATAR_HEIGHT : Math.max(1, Math.round(source.height));
    let bitmap: ImageBitmap;
    try {
      bitmap = await createBitmap(blob);
    } catch (error) {
      throw this.#unsupported(
        `The browser could not decode the avatar: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const canvas = createCanvas(outputWidth, outputHeight);
      const context = canvas.context;
      const coveredSource = coverSourceRect(source, outputWidth, outputHeight);
      context.drawImage(
        bitmap,
        coveredSource.x,
        coveredSource.y,
        coveredSource.width,
        coveredSource.height,
        0,
        0,
        outputWidth,
        outputHeight,
      );
      const output = await canvas.toBlob('image/png');
      const info = await this.inspect(output);
      return { blob: output, info, processed: true };
    } catch (error) {
      if (error instanceof ImageProcessingUnsupportedError) {
        throw this.#unsupported(error.message);
      }
      throw error;
    } finally {
      (bitmap as ImageBitmap & { close?: () => void }).close?.();
    }
  }

  #unsupported(message: string): ImageProcessingUnsupportedError {
    this.diagnostics.status = 'degraded';
    this.diagnostics.message = message;
    this.diagnostics.lastUnsupportedAt = new Date().toISOString();
    return new ImageProcessingUnsupportedError(message);
  }
}

function inspectPng(bytes: Uint8Array): ImageInfo {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') {
    throw new AssetValidationError('PNG image is truncated or missing IHDR.');
  }
  const view = dataView(bytes);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  validateDimensions(width, height);
  return {
    format: 'png',
    mimeType: 'image/png',
    width,
    height,
    isAnimated: containsAscii(bytes, 'acTL'),
  };
}

function inspectGif(bytes: Uint8Array): ImageInfo {
  if (bytes.length < 10) throw new AssetValidationError('GIF image is truncated.');
  const view = dataView(bytes);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  validateDimensions(width, height);
  let imageFrames = 0;
  for (let index = 10; index < bytes.length; index += 1) {
    if (bytes[index] === 0x2c) imageFrames += 1;
    if (imageFrames > 1) break;
  }
  return {
    format: 'gif',
    mimeType: 'image/gif',
    width,
    height,
    isAnimated: imageFrames > 1,
  };
}

function inspectJpeg(bytes: Uint8Array): ImageInfo {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === undefined) break;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (offset + 2 > bytes.length) break;
    const length = dataView(bytes).getUint16(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) break;
      const height = dataView(bytes).getUint16(offset + 3);
      const width = dataView(bytes).getUint16(offset + 5);
      validateDimensions(width, height);
      return {
        format: 'jpeg',
        mimeType: 'image/jpeg',
        width,
        height,
        isAnimated: false,
      };
    }
    offset += length;
  }
  throw new AssetValidationError('JPEG image is truncated or has no supported frame header.');
}

function inspectWebp(bytes: Uint8Array): ImageInfo {
  if (bytes.length < 30) throw new AssetValidationError('WebP image is truncated.');
  let width: number;
  let height: number;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X') {
    width = readUint24Le(bytes, 24) + 1;
    height = readUint24Le(bytes, 27) + 1;
  } else if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      throw new AssetValidationError('WebP VP8 frame header is invalid.');
    }
    width = readUint16Le(bytes, 26) & 0x3fff;
    height = readUint16Le(bytes, 28) & 0x3fff;
  } else if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) throw new AssetValidationError('WebP VP8L frame header is invalid.');
    const packed =
      (bytes[21] ?? 0) |
      ((bytes[22] ?? 0) << 8) |
      ((bytes[23] ?? 0) << 16) |
      ((bytes[24] ?? 0) << 24);
    width = (packed & 0x3fff) + 1;
    height = ((packed >>> 14) & 0x3fff) + 1;
  } else {
    throw new AssetValidationError('WebP image has an unsupported primary chunk.');
  }
  validateDimensions(width, height);
  const animationFlag = chunk === 'VP8X' && ((bytes[20] ?? 0) & 0x02) !== 0;
  return {
    format: 'webp',
    mimeType: 'image/webp',
    width,
    height,
    isAnimated: animationFlag || containsAscii(bytes, 'ANIM') || containsAscii(bytes, 'ANMF'),
  };
}

export function coverSourceRect(
  source: { x: number; y: number; width: number; height: number },
  targetWidth: number,
  targetHeight: number,
): { x: number; y: number; width: number; height: number } {
  const sourceAspectRatio = source.width / source.height;
  const targetAspectRatio = targetWidth / targetHeight;
  if (sourceAspectRatio > targetAspectRatio) {
    const width = source.height * targetAspectRatio;
    return {
      x: source.x + (source.width - width) / 2,
      y: source.y,
      width,
      height: source.height,
    };
  }
  if (sourceAspectRatio < targetAspectRatio) {
    const height = source.width / targetAspectRatio;
    return {
      x: source.x,
      y: source.y + (source.height - height) / 2,
      width: source.width,
      height,
    };
  }
  return { ...source };
}

function validateCrop(crop: AvatarCrop, image: ImageInfo): void {
  const values = [crop.x, crop.y, crop.width, crop.height];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new AssetValidationError('Avatar crop coordinates must be finite numbers.');
  }
  if (crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0) {
    throw new AssetValidationError('Avatar crop coordinates are outside the image.');
  }
  if (crop.x + crop.width > image.width + 1 || crop.y + crop.height > image.height + 1) {
    throw new AssetValidationError('Avatar crop rectangle exceeds the image dimensions.');
  }
}

function validateDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new AssetValidationError('Image dimensions are invalid.');
  }
  if (width > 65_535 || height > 65_535 || width * height > 268_435_456) {
    throw new AssetValidationError('Image dimensions exceed the supported safety limit.');
  }
}

function createCanvas(
  width: number,
  height: number,
): {
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  toBlob: (mimeType: string) => Promise<Blob>;
} {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new ImageProcessingUnsupportedError('OffscreenCanvas 2D is unavailable.');
    return {
      context,
      toBlob: (mimeType) => canvas.convertToBlob({ type: mimeType }),
    };
  }
  if (typeof document === 'undefined') {
    throw new ImageProcessingUnsupportedError('Canvas is unavailable in this browser.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new ImageProcessingUnsupportedError('Canvas 2D is unavailable.');
  return {
    context,
    toBlob: (mimeType) =>
      new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else
            reject(
              new ImageProcessingUnsupportedError('Canvas could not encode the avatar image.'),
            );
        }, mimeType);
      }),
  };
}

function blobFromBytes(bytes: Uint8Array, type: string): Blob {
  const data = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([data], { type });
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function containsAscii(bytes: Uint8Array, needle: string): boolean {
  const encoded = new TextEncoder().encode(needle);
  outer: for (let index = 0; index <= bytes.length - encoded.length; index += 1) {
    for (let needleIndex = 0; needleIndex < encoded.length; needleIndex += 1) {
      if (bytes[index + needleIndex] !== encoded[needleIndex]) continue outer;
    }
    return true;
  }
  return false;
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}
