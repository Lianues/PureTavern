import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import { CompatibilityRouter } from '@/platform/legacy/compatibility-router';

import { AssetService } from '../application/asset-service';
import { MemoryBlobRepository } from '../infrastructure/asset-blob-repositories';
import { MemoryAssetIndex } from '../infrastructure/asset-index-repositories';
import { BrowserImageProcessor } from '../infrastructure/browser-image-processor';
import { registerAssetsLegacyRoutes } from '../legacy/register-routes';
import { bytesFromBase64, ONE_BY_ONE_PNG_BASE64, pngBlob, pngDataUrl } from './test-helpers';

describe('M13 Legacy route DTOs', () => {
  it('covers files, user images, backgrounds, metadata and avatar DTOs', async () => {
    const { router } = createRouteHarness();

    const sanitized = await postJson(router, '/api/files/sanitize-filename', {
      fileName: '../bad:name.txt',
    });
    await expect(sanitized.json()).resolves.toEqual({ fileName: '_bad_name.txt' });

    const uploadFile = await postJson(router, '/api/files/upload', {
      name: 'notes.txt',
      data: btoa('route text'),
    });
    await expect(uploadFile.json()).resolves.toEqual({ path: '/user/files/notes.txt' });
    const verify = await postJson(router, '/api/files/verify', {
      urls: ['/user/files/notes.txt', '/user/files/nope.txt'],
    });
    await expect(verify.json()).resolves.toEqual({
      '/user/files/notes.txt': true,
      '/user/files/nope.txt': false,
    });
    expect(
      (await postJson(router, '/api/files/delete', { path: '/user/files/notes.txt' })).status,
    ).toBe(200);

    const imageUpload = await postJson(router, '/api/images/upload', {
      image: pngDataUrl(),
      format: 'png',
      filename: 'gallery',
      ch_name: 'Alice',
    });
    await expect(imageUpload.json()).resolves.toEqual({
      path: '/user/images/Alice/gallery.png',
    });
    await expect((await postJson(router, '/api/images/folders', {})).json()).resolves.toEqual([
      'Alice',
    ]);
    await expect(
      (
        await postJson(router, '/api/images/list', {
          folder: 'Alice',
          sortField: 'name',
          sortOrder: 'asc',
          type: 3,
        })
      ).json(),
    ).resolves.toEqual(['gallery.png']);
    expect(
      (
        await postJson(router, '/api/images/delete', {
          path: '/user/images/Alice/gallery.png',
        })
      ).status,
    ).toBe(200);

    const backgroundForm = new FormData();
    backgroundForm.set('avatar', imageFile('scene.png'));
    const backgroundUpload = await dispatch(
      router,
      'POST',
      '/api/backgrounds/upload',
      backgroundForm,
    );
    await expect(backgroundUpload.text()).resolves.toBe('scene.png');
    await expect((await postJson(router, '/api/backgrounds/all', {})).json()).resolves.toEqual({
      images: [{ filename: 'scene.png', isAnimated: false }],
      config: { width: 160, height: 90 },
    });

    const metadata = await postJson(router, '/api/image-metadata/', {
      path: '/backgrounds/scene.png',
    });
    await expect(metadata.json()).resolves.toMatchObject({ width: 1, height: 1 });
    await expect(
      (
        await postJson(router, '/api/image-metadata/all', {
          prefix: 'backgrounds/',
        })
      ).json(),
    ).resolves.toMatchObject({ images: { 'backgrounds/scene.png': { width: 1 } } });
    await expect(
      (await postJson(router, '/api/image-metadata/cleanup', {})).json(),
    ).resolves.toEqual({
      removed: 0,
    });

    const folderResponse = await postJson(router, '/api/image-metadata/folders/create', {
      name: 'Scenes',
    });
    const folder = (await folderResponse.json()) as {
      id: string;
      name: string;
      thumbnailFile: string;
    };
    expect(folder).toMatchObject({ name: 'Scenes', thumbnailFile: '' });
    expect(
      (
        await postJson(router, '/api/image-metadata/folders/assign', {
          id: folder.id,
          paths: ['backgrounds/scene.png'],
        })
      ).status,
    ).toBe(200);
    await expect(
      (await postJson(router, '/api/backgrounds/folders', {})).json(),
    ).resolves.toMatchObject({
      imageFolderMap: { 'scene.png': [folder.id] },
    });
    await expect(
      (
        await postJson(router, '/api/image-metadata/folders/set-thumbnail', {
          id: folder.id,
          thumbnailFile: 'scene.png',
        })
      ).json(),
    ).resolves.toMatchObject({ thumbnailFile: 'scene.png' });
    await expect(
      (
        await postJson(router, '/api/image-metadata/folders/set-thumbnails', {
          updates: [{ id: folder.id, thumbnailFile: 'scene.png' }],
        })
      ).json(),
    ).resolves.toEqual({ updated: 1 });
    await expect(
      (
        await postJson(router, '/api/image-metadata/folders/update', {
          id: folder.id,
          name: 'Favorites',
        })
      ).json(),
    ).resolves.toMatchObject({ name: 'Favorites' });
    await expect(
      (await postJson(router, '/api/image-metadata/folders/get', {})).json(),
    ).resolves.toMatchObject({
      folders: [{ id: folder.id, name: 'Favorites' }],
    });
    expect(
      (
        await postJson(router, '/api/image-metadata/folders/unassign', {
          id: folder.id,
          paths: ['backgrounds/scene.png'],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(router, '/api/image-metadata/folders/delete', {
          id: folder.id,
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await postJson(router, '/api/backgrounds/rename', {
          old_bg: 'scene.png',
          new_bg: 'renamed.png',
        })
      ).status,
    ).toBe(200);
    expect((await postJson(router, '/api/backgrounds/delete', { bg: 'renamed.png' })).status).toBe(
      200,
    );

    await expect((await postJson(router, '/api/avatars/get', {})).json()).resolves.toEqual([
      'user-default.png',
    ]);
    const avatarForm = new FormData();
    avatarForm.set('avatar', imageFile('persona.png'));
    await expect(
      (await dispatch(router, 'POST', '/api/avatars/upload', avatarForm)).json(),
    ).resolves.toEqual({ path: 'persona.png' });
    expect((await postJson(router, '/api/avatars/delete', { avatar: 'persona.png' })).status).toBe(
      200,
    );

    const unsafe = await postJson(router, '/api/files/upload', {
      name: '../bad.txt',
      data: btoa('bad'),
    });
    expect(unsafe.status).toBe(400);
    await expect(unsafe.json()).resolves.toMatchObject({
      code: 'ASSET_VALIDATION_ERROR',
      pureTavern: true,
    });
  });

  it('covers sprites and extension asset DTOs including native-fetch character blobs', async () => {
    const { router, nativeFetch } = createRouteHarness();

    const spriteForm = new FormData();
    spriteForm.set('name', 'Alice');
    spriteForm.set('label', 'joy');
    spriteForm.set('spriteName', 'joy-alt');
    spriteForm.set('avatar', imageFile('upload.png'));
    await expect(
      (await dispatch(router, 'POST', '/api/sprites/upload', spriteForm)).json(),
    ).resolves.toEqual({ label: 'joy', path: '/characters/Alice/joy-alt.png' });

    const zipForm = new FormData();
    zipForm.set('name', 'Alice');
    zipForm.set(
      'avatar',
      new File([Uint8Array.from([1, 2, 3])], 'sprites.zip', { type: 'application/zip' }),
    );
    const invalidZip = await dispatch(router, 'POST', '/api/sprites/upload-zip', zipForm);
    expect(invalidZip.status).toBe(400);

    const validZip = zipSync({ 'neutral.png': bytesFromBase64(ONE_BY_ONE_PNG_BASE64) });
    const validZipForm = new FormData();
    validZipForm.set('name', 'Alice');
    validZipForm.set('avatar', new File([validZip], 'sprites.zip', { type: 'application/zip' }));
    await expect(
      (await dispatch(router, 'POST', '/api/sprites/upload-zip', validZipForm)).json(),
    ).resolves.toEqual({ count: 1 });
    await expect(
      (await dispatch(router, 'GET', '/api/sprites/get?name=Alice')).json(),
    ).resolves.toEqual([
      { label: 'joy', path: '/characters/Alice/joy-alt.png' },
      { label: 'neutral', path: '/characters/Alice/neutral.png' },
    ]);
    expect(
      (
        await postJson(router, '/api/sprites/delete', {
          name: 'Alice',
          label: 'joy',
          spriteName: 'joy-alt',
        })
      ).status,
    ).toBe(200);

    await expect((await postJson(router, '/api/assets/get', {})).json()).resolves.toMatchObject({
      bgm: [],
      character: [],
      live2d: [],
    });
    await expect(
      (
        await postJson(router, '/api/assets/download', {
          url: 'https://cdn.example/theme.mp3',
          category: 'bgm',
          filename: 'theme.mp3',
        })
      ).json(),
    ).resolves.toEqual({ path: '/assets/bgm/theme.mp3' });
    await expect((await postJson(router, '/api/assets/get', {})).json()).resolves.toMatchObject({
      bgm: ['/assets/bgm/theme.mp3'],
    });
    expect(
      (
        await postJson(router, '/api/assets/delete', {
          category: 'bgm',
          filename: 'theme.mp3',
        })
      ).status,
    ).toBe(200);

    const character = await postJson(router, '/api/assets/character', {
      url: 'https://cdn.example/Alice.png',
      filename: 'Alice.png',
    });
    expect(character.status).toBe(200);
    expect(character.headers.get('content-type')).toBe('image/png');
    expect((await character.blob()).size).toBeGreaterThan(0);
    expect(nativeFetch).toHaveBeenCalled();
  });
});

function createRouteHarness() {
  const nativeFetch = vi.fn<typeof fetch>(async (input) => {
    return String(input).endsWith('.png')
      ? new Response(arrayBufferFromBytes(bytesFromBase64(ONE_BY_ONE_PNG_BASE64)), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      : new Response(new TextEncoder().encode('audio'), {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        });
  });
  const service = new AssetService(
    new MemoryBlobRepository(),
    new MemoryAssetIndex(),
    new BrowserImageProcessor(),
    nativeFetch,
  );
  const router = new CompatibilityRouter();
  registerAssetsLegacyRoutes(router, service);
  return { router, service, nativeFetch };
}

async function postJson(
  router: CompatibilityRouter,
  pathname: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return dispatch(router, 'POST', pathname, JSON.stringify(body), {
    'Content-Type': 'application/json',
  });
}

async function dispatch(
  router: CompatibilityRouter,
  method: string,
  pathname: string,
  body?: BodyInit,
  headers?: HeadersInit,
): Promise<Response> {
  const url = new URL(pathname, 'https://pure-tavern.local');
  const request =
    body instanceof FormData
      ? ({ method, formData: async () => body } as Request)
      : new Request(url, {
          method,
          ...(body === undefined ? {} : { body }),
          ...(headers === undefined ? {} : { headers }),
        });
  const response = await router.dispatch(request, url);
  if (!response) throw new Error(`Route was not handled: ${method} ${pathname}`);
  return response;
}

function imageFile(name: string): File {
  return new File([pngBlob()], name, { type: 'image/png' });
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
