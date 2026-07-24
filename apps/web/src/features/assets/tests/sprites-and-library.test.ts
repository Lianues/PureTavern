import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import {
  AssetFetchError,
  AssetLimitError,
  AssetValidationError,
} from '../application/asset-errors';
import { AssetService } from '../application/asset-service';
import { MemoryBlobRepository } from '../infrastructure/asset-blob-repositories';
import { MemoryAssetIndex } from '../infrastructure/asset-index-repositories';
import { BrowserImageProcessor } from '../infrastructure/browser-image-processor';
import type { AssetOwnerResolver } from '../ports/asset-owner-resolver';
import { blobFromBytes, bytesFromBase64, ONE_BY_ONE_PNG_BASE64, pngBlob } from './test-helpers';

describe('expression sprites', () => {
  it('keeps full filenames/suffixes, stable owners and supports single/ZIP/delete flows', async () => {
    const ownerResolver: AssetOwnerResolver = {
      resolveOwner: (alias) => (alias === 'Alice' ? 'character-stable-id' : null),
    };
    const service = new AssetService(
      new MemoryBlobRepository(),
      new MemoryAssetIndex(),
      new BrowserImageProcessor(),
      fetch,
      ownerResolver,
    );

    await expect(
      service.uploadSprite({
        name: 'Alice',
        label: 'joy',
        spriteName: 'joy-alt',
        file: pngBlob(),
        filename: 'source.png',
      }),
    ).resolves.toEqual({
      label: 'joy',
      path: '/characters/Alice/joy-alt.png',
    });

    const zip = zipSync({
      'neutral.png': bytesFromBase64(ONE_BY_ONE_PNG_BASE64),
      'pack/happy-alt.png': bytesFromBase64(ONE_BY_ONE_PNG_BASE64),
      'notes.txt': new TextEncoder().encode('ignored'),
    });
    await expect(
      service.uploadSpriteZip('Alice', blobFromBytes(zip, 'application/zip')),
    ).resolves.toEqual({ count: 2 });
    await expect(service.listSprites('Alice')).resolves.toEqual([
      { label: 'happy', path: '/characters/Alice/happy-alt.png' },
      { label: 'joy', path: '/characters/Alice/joy-alt.png' },
      { label: 'neutral', path: '/characters/Alice/neutral.png' },
    ]);

    await service.deleteSprite({ name: 'Alice', label: 'joy', spriteName: 'joy-alt' });
    await expect(service.listSprites('Alice')).resolves.not.toContainEqual({
      label: 'joy',
      path: '/characters/Alice/joy-alt.png',
    });
  });

  it('rejects zip-slip and excessive file counts before storing entries', async () => {
    const service = new AssetService(
      new MemoryBlobRepository(),
      new MemoryAssetIndex(),
      new BrowserImageProcessor(),
    );
    const zipSlip = zipSync({
      '../evil.png': bytesFromBase64(ONE_BY_ONE_PNG_BASE64),
    });
    await expect(
      service.uploadSpriteZip('Alice', blobFromBytes(zipSlip, 'application/zip')),
    ).rejects.toBeInstanceOf(AssetValidationError);

    const tooMany = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [
        `neutral-${index}.png`,
        bytesFromBase64(ONE_BY_ONE_PNG_BASE64),
      ]),
    );
    const fileBomb = zipSync(tooMany);
    await expect(
      service.uploadSpriteZip('Alice', blobFromBytes(fileBomb, 'application/zip')),
    ).rejects.toBeInstanceOf(AssetLimitError);
    await expect(service.listSprites('Alice')).resolves.toEqual([]);
  });
});

describe('extension assets', () => {
  it('downloads/stores/deletes local library assets and returns character blobs directly', async () => {
    const nativeFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('.png')) return new Response(pngBlob(), { status: 200 });
      return new Response(new TextEncoder().encode('audio'), {
        status: 200,
        headers: { 'Content-Length': '5', 'Content-Type': 'audio/mpeg' },
      });
    });
    const service = new AssetService(
      new MemoryBlobRepository(),
      new MemoryAssetIndex(),
      new BrowserImageProcessor(),
      nativeFetch,
    );

    await expect(
      service.downloadLibraryAsset({
        url: 'https://cdn.example/music/theme.mp3',
        category: 'bgm',
        filename: 'theme.mp3',
      }),
    ).resolves.toEqual({ kind: 'stored', path: '/assets/bgm/theme.mp3' });
    await expect(service.getInstalledLibraryAssets()).resolves.toMatchObject({
      bgm: ['/assets/bgm/theme.mp3'],
      ambient: [],
      character: [],
    });

    const character = await service.downloadLibraryAsset({
      url: 'https://cdn.example/characters/Alice.png',
      category: 'character',
      filename: 'Alice.png',
    });
    expect(character).toMatchObject({ kind: 'blob', filename: 'Alice.png' });
    await expect(service.getInstalledLibraryAssets()).resolves.toMatchObject({ character: [] });

    await service.deleteLibraryAsset('bgm', 'theme.mp3');
    await expect(service.getInstalledLibraryAssets()).resolves.toMatchObject({ bgm: [] });
  });

  it('reports browser CORS/network failures explicitly and validates categories', async () => {
    const nativeFetch = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    const service = new AssetService(
      new MemoryBlobRepository(),
      new MemoryAssetIndex(),
      new BrowserImageProcessor(),
      nativeFetch,
    );

    await expect(
      service.downloadLibraryAsset({
        url: 'https://blocked.example/file.mp3',
        category: 'ambient',
        filename: 'file.mp3',
      }),
    ).rejects.toBeInstanceOf(AssetFetchError);
    await expect(
      service.downloadLibraryAsset({
        url: 'https://cdn.example/payload.exe',
        category: 'temp',
        filename: 'payload.exe',
      }),
    ).rejects.toBeInstanceOf(AssetValidationError);
    expect(service.diagnostics.lastFetchError).toContain('may block CORS');
  });
});
