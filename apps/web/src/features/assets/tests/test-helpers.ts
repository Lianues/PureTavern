import { AssetService } from '../application/asset-service';
import { MemoryBlobRepository } from '../infrastructure/asset-blob-repositories';
import { MemoryAssetIndex } from '../infrastructure/asset-index-repositories';
import { BrowserImageProcessor } from '../infrastructure/browser-image-processor';
import type { DecodedAssetData, ImageProcessor, ProcessedImage } from '../ports/image-processor';

export const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

export function bytesFromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export function blobFromBytes(bytes: Uint8Array, type = 'application/octet-stream'): Blob {
  const data = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([data], { type });
}

export function pngBlob(): Blob {
  return blobFromBytes(bytesFromBase64(ONE_BY_ONE_PNG_BASE64), 'image/png');
}

export function pngDataUrl(): string {
  return `data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}`;
}

export async function blobBytes(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

export function createMemoryHarness(
  nativeFetch: typeof fetch = fetch,
  images: ImageProcessor = new BrowserImageProcessor(),
) {
  const blobs = new MemoryBlobRepository();
  const index = new MemoryAssetIndex();
  const service = new AssetService(blobs, index, images, nativeFetch);
  return { service, blobs, index, images };
}

export class PassthroughImageProcessor implements ImageProcessor {
  readonly #delegate = new BrowserImageProcessor();
  readonly diagnostics = this.#delegate.diagnostics;

  decodeBase64(value: string, fallbackMimeType?: string): DecodedAssetData {
    return this.#delegate.decodeBase64(value, fallbackMimeType);
  }

  inspect(blob: Blob) {
    return this.#delegate.inspect(blob);
  }

  async processAvatar(blob: Blob): Promise<ProcessedImage> {
    return { blob, info: await this.inspect(blob), processed: true };
  }
}
