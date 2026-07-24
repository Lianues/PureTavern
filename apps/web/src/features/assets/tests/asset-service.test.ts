import { describe, expect, it } from 'vitest';

import { AssetService } from '../application/asset-service';
import type { ImageInfo } from '../domain/asset';
import { MemoryBlobRepository } from '../infrastructure/asset-blob-repositories';
import { MemoryAssetIndex } from '../infrastructure/asset-index-repositories';
import { BrowserImageProcessor } from '../infrastructure/browser-image-processor';
import type {
  AvatarCrop,
  DecodedAssetData,
  ImageProcessor,
  ImageProcessorDiagnostics,
  ProcessedImage,
} from '../ports/image-processor';
import { createMemoryHarness, pngBlob, pngDataUrl } from './test-helpers';

describe('AssetService files and user images', () => {
  it('uploads, verifies, resolves and deletes chat attachments', async () => {
    const { service } = createMemoryHarness();
    const path = await service.uploadFile('notes.txt', btoa('hello attachment'));
    expect(path).toBe('/user/files/notes.txt');
    await expect(service.verifyFiles([path, '/user/files/missing.txt'])).resolves.toEqual({
      [path]: true,
      '/user/files/missing.txt': false,
    });
    const stored = await service.getAssetByPath(path);
    await expect(stored?.blob.data.text()).resolves.toBe('hello attachment');

    await service.deleteFile(path);
    await expect(service.getAssetByPath(path)).resolves.toBeNull();
  });

  it('supports user image folders, unique names, sort/filter and deletion', async () => {
    const { service } = createMemoryHarness();
    const first = await service.uploadUserImage({
      image: pngDataUrl(),
      format: 'png',
      filename: 'gallery',
      ch_name: 'Alice',
    });
    const second = await service.uploadUserImage({
      image: pngDataUrl(),
      format: '.png',
      filename: 'gallery.png',
      ch_name: 'Alice',
    });
    expect(first).toBe('/user/images/Alice/gallery.png');
    expect(second).toBe('/user/images/Alice/gallery_1.png');
    await expect(service.listUserImageFolders()).resolves.toEqual(['Alice']);
    await expect(
      service.listUserImages({ folder: 'Alice', sortField: 'name', sortOrder: 'desc', type: 1 }),
    ).resolves.toEqual(['gallery.png', 'gallery_1.png']);

    await service.deleteUserImage(first);
    await expect(service.listUserImages({ folder: 'Alice', type: 1 })).resolves.toEqual([
      'gallery_1.png',
    ]);
  });
});

describe('AssetService backgrounds and image metadata', () => {
  it('renames aliases without copying the Blob and manages metadata folders', async () => {
    const { service, blobs, index } = createMemoryHarness();
    await expect(service.uploadBackground(pngBlob(), 'scene.png')).resolves.toBe('scene.png');
    await expect(service.listBackgrounds()).resolves.toEqual({
      images: [{ filename: 'scene.png', isAnimated: false }],
      config: { width: 160, height: 90 },
    });

    const before = await index.getByLegacyPath('/backgrounds/scene.png');
    const beforeBlob = before ? await blobs.get('backgrounds', before.id) : null;
    await expect(service.getImageMetadata('/backgrounds/scene.png')).resolves.toMatchObject({
      path: '/backgrounds/scene.png',
      width: 1,
      height: 1,
      aspectRatio: 1,
    });
    await service.setImageMetadata('/backgrounds/scene.png', { dominantColor: '#010203' });

    const folder = await service.createBackgroundFolder('Scenes');
    await service.assignBackgroundFolder(folder.id, ['backgrounds/scene.png']);
    await expect(service.getBackgroundFolders()).resolves.toEqual({
      folders: [{ ...folder, thumbnailFile: '' }],
      imageFolderMap: { 'scene.png': [folder.id] },
    });
    await expect(
      service.updateBackgroundFolder({
        id: folder.id,
        name: 'Favorites',
        thumbnailFile: 'scene.png',
      }),
    ).resolves.toMatchObject({ name: 'Favorites', thumbnailFile: 'scene.png' });

    await service.renameBackground('scene.png', 'renamed.png');
    await expect(index.getByLegacyPath('/backgrounds/scene.png')).resolves.toBeNull();
    const after = await index.getByLegacyPath('/backgrounds/renamed.png');
    expect(after?.id).toBe(before?.id);
    expect(after?.imageMetadata).toMatchObject({
      path: '/backgrounds/renamed.png',
      dominantColor: '#010203',
    });
    const afterBlob = after ? await blobs.get('backgrounds', after.id) : null;
    expect(afterBlob?.data).toBe(beforeBlob?.data);
    await expect(service.getBackgroundFolders()).resolves.toMatchObject({
      folders: [{ id: folder.id, thumbnailFile: 'renamed.png' }],
    });

    await service.deleteBackground('renamed.png');
    await expect(service.getBackgroundFolders()).resolves.toEqual({
      folders: [{ id: folder.id, name: 'Favorites', thumbnailFile: '' }],
      imageFolderMap: {},
    });
    await service.deleteBackgroundFolder(folder.id);
    await expect(service.getBackgroundFolders()).resolves.toEqual({
      folders: [],
      imageFolderMap: {},
    });
    await expect(service.listBackgrounds()).resolves.toMatchObject({ images: [] });
  });
});

describe('AssetService user avatars', () => {
  it('uploads, crop-processes, overwrites and deletes persona avatars', async () => {
    const blobs = new MemoryBlobRepository();
    const index = new MemoryAssetIndex();
    const processor = new RecordingImageProcessor();
    const service = new AssetService(blobs, index, processor);

    const initial = await service.uploadAvatar(pngBlob(), 'persona.png');
    expect(initial).toBe('persona.png');
    await expect(service.listAvatars()).resolves.toEqual(['user-default.png', 'persona.png']);
    const before = await index.getByLegacyPath('/User Avatars/persona.png');

    const crop: AvatarCrop = { x: 0, y: 0, width: 1, height: 1, want_resize: true };
    await expect(
      service.uploadAvatar(pngBlob(), 'replacement.png', 'persona.png', crop),
    ).resolves.toBe('persona.png');
    expect(processor.lastCrop).toEqual(crop);
    const after = await index.getByLegacyPath('/User Avatars/persona.png');
    expect(after?.id).toBe(before?.id);

    await service.deleteAvatar('persona.png');
    await expect(service.listAvatars()).resolves.toEqual(['user-default.png']);
  });
});

class RecordingImageProcessor implements ImageProcessor {
  readonly #delegate = new BrowserImageProcessor();
  readonly diagnostics: ImageProcessorDiagnostics = this.#delegate.diagnostics;
  lastCrop: AvatarCrop | undefined;

  decodeBase64(value: string, fallbackMimeType?: string): DecodedAssetData {
    return this.#delegate.decodeBase64(value, fallbackMimeType);
  }

  inspect(blob: Blob): Promise<ImageInfo> {
    return this.#delegate.inspect(blob);
  }

  async processAvatar(blob: Blob, crop?: AvatarCrop): Promise<ProcessedImage> {
    this.lastCrop = crop;
    const info = await this.inspect(blob);
    return { blob, info, processed: Boolean(crop) };
  }
}
