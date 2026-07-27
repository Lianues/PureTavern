import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import { AssetFetchError, AssetValidationError } from '../application/asset-errors';
import { AssetService } from '../application/asset-service';
import { MemoryBlobRepository } from '../infrastructure/asset-blob-repositories';
import { MemoryAssetIndex } from '../infrastructure/asset-index-repositories';
import { BrowserImageProcessor } from '../infrastructure/browser-image-processor';
import type { AssetOwnerResolver } from '../ports/asset-owner-resolver';
import {
  blobBytes,
  blobFromBytes,
  bytesFromBase64,
  ONE_BY_ONE_PNG_BASE64,
  pngBlob,
} from './test-helpers';

describe('expression sprites', () => {
  it('keeps full filenames/suffixes, stable owners and supports single/ZIP/delete flows', async () => {
    const ownerResolver: AssetOwnerResolver = {
      resolveOwner: (alias) => (alias === 'Alice' ? 'character-stable-id' : null),
    };
    const blobs = new MemoryBlobRepository();
    const index = new MemoryAssetIndex();
    const service = new AssetService(
      blobs,
      index,
      new BrowserImageProcessor(),
      fetch,
      ownerResolver,
    );
    const source = pngBlob();
    Object.defineProperty(source, 'size', { value: 51 * 1024 * 1024 });

    await expect(
      service.uploadSprite({
        name: 'Alice',
        label: 'joy',
        spriteName: 'joy-alt',
        file: source,
        filename: 'source.png',
      }),
    ).resolves.toEqual({
      label: 'joy',
      path: '/characters/Alice/joy-alt.png',
    });
    const sourceRecord = await index.getByLegacyPath('/characters/Alice/joy-alt.png');
    expect((await blobs.get('sprites', sourceRecord!.id))?.data).toBe(source);

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
    const zipRecord = await index.getByLegacyPath('/characters/Alice/neutral.png');
    const zipBlob = await blobs.get('sprites', zipRecord!.id);
    expect(await blobBytes(zipBlob!.data)).toEqual([...bytesFromBase64(ONE_BY_ONE_PNG_BASE64)]);

    await service.deleteSprite({ name: 'Alice', label: 'joy', spriteName: 'joy-alt' });
    await expect(service.listSprites('Alice')).resolves.not.toContainEqual({
      label: 'joy',
      path: '/characters/Alice/joy-alt.png',
    });
  });

  it('rejects zip-slip while accepting more than the former 256-file ZIP quota', async () => {
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

    const manyFiles = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [
        `neutral-${index}.png`,
        bytesFromBase64(ONE_BY_ONE_PNG_BASE64),
      ]),
    );
    const archive = zipSync(manyFiles);
    await expect(
      service.uploadSpriteZip('Alice', blobFromBytes(archive, 'application/zip')),
    ).resolves.toEqual({ count: 257 });
    await expect(service.listSprites('Alice')).resolves.toHaveLength(257);
  });
});

describe('extension assets', () => {
  it('downloads/stores/deletes local library assets and returns character blobs directly', async () => {
    const nativeFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('.png')) {
        const png = bytesFromBase64(ONE_BY_ONE_PNG_BASE64);
        const body = new ArrayBuffer(png.byteLength);
        new Uint8Array(body).set(png);
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      return new Response(new TextEncoder().encode('audio'), {
        status: 200,
        headers: {
          'Content-Length': String(60 * 1024 * 1024),
          'Content-Type': 'audio/mpeg',
        },
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
    await expect(
      service.getAssetByPath('/assets/bgm/theme.mp3').then((asset) => asset?.blob.data.text()),
    ).resolves.toBe('audio');

    const character = await service.downloadLibraryAsset({
      url: 'https://cdn.example/characters/Alice.png',
      category: 'character',
      filename: 'Alice.png',
    });
    expect(character).toMatchObject({ kind: 'blob', filename: 'Alice.png' });
    if (character.kind !== 'blob') throw new Error('Character download did not return a Blob.');
    expect(await blobBytes(character.blob)).toEqual([...bytesFromBase64(ONE_BY_ONE_PNG_BASE64)]);
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
