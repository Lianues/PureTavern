import type { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { jsonResponse, textResponse } from '@/platform/legacy/compatibility-router';
import { parseAvatarCrop } from '@/platform/legacy/parse-avatar-crop';

import { AssetError, AssetValidationError } from '../application/asset-errors';
import type { AssetService, LibraryDownloadResult } from '../application/asset-service';

export function registerAssetsLegacyRoutes(
  router: CompatibilityRouter,
  assets: AssetService,
  options: { backgroundsReady?: Promise<unknown> } = {},
): void {
  const backgroundsReady = options.backgroundsReady ?? Promise.resolve();
  registerJson(router, 'POST', '/api/files/sanitize-filename', async (request) => {
    const body = await readJsonObject(request);
    return { fileName: assets.sanitizeFilename(body.fileName) };
  });
  registerJson(router, 'POST', '/api/files/upload', async (request) => {
    const body = await readJsonObject(request);
    return { path: await assets.uploadFile(body.name, body.data) };
  });
  registerEmpty(router, 'POST', '/api/files/delete', async (request) => {
    const body = await readJsonObject(request);
    await assets.deleteFile(body.path);
  });
  registerJson(router, 'POST', '/api/files/verify', async (request) => {
    const body = await readJsonObject(request);
    return assets.verifyFiles(body.urls);
  });

  registerJson(router, 'POST', '/api/images/upload', async (request) => {
    const body = await readJsonObject(request);
    return {
      path: await assets.uploadUserImage({
        image: body.image,
        format: body.format,
        filename: body.filename,
        ch_name: body.ch_name,
      }),
    };
  });
  registerJson(router, 'POST', '/api/images/list', async (request) => {
    const body = await readJsonObject(request);
    return assets.listUserImages({
      folder: body.folder,
      sortField: body.sortField,
      sortOrder: body.sortOrder,
      type: body.type,
    });
  });
  registerJson(router, 'POST', '/api/images/folders', () => assets.listUserImageFolders());
  registerEmpty(router, 'POST', '/api/images/delete', async (request) => {
    const body = await readJsonObject(request);
    await assets.deleteUserImage(body.path);
  });

  registerJson(router, 'POST', '/api/backgrounds/all', async () => {
    await backgroundsReady;
    return assets.listBackgrounds();
  });
  registerJson(router, 'POST', '/api/backgrounds/folders', async () => {
    await backgroundsReady;
    return assets.getBackgroundFolders();
  });
  router.register('POST', '/api/backgrounds/upload', async (request) => {
    try {
      await backgroundsReady;
      const form = await request.formData();
      const file = requireFormFile(form, 'avatar');
      const filename = fileNameOf(file, 'background.png');
      return textResponse(await assets.uploadBackground(file, filename));
    } catch (error) {
      return assetErrorResponse(error);
    }
  });
  registerEmpty(router, 'POST', '/api/backgrounds/rename', async (request) => {
    await backgroundsReady;
    const body = await readJsonObject(request);
    await assets.renameBackground(body.old_bg, body.new_bg);
  });
  registerEmpty(router, 'POST', '/api/backgrounds/delete', async (request) => {
    await backgroundsReady;
    const body = await readJsonObject(request);
    await assets.deleteBackground(body.bg);
  });

  registerJson(router, 'POST', '/api/image-metadata/', async (request) => {
    await backgroundsReady;
    const body = await readJsonObject(request);
    const path = body.path ?? body.imagePath;
    const metadata = body.metadata;
    return metadata === undefined
      ? assets.getImageMetadata(path)
      : assets.setImageMetadata(path, metadata);
  });
  registerJson(router, 'POST', '/api/image-metadata/all', async (request) => {
    await backgroundsReady;
    const body = await readJsonObject(request, true);
    return { images: await assets.listImageMetadata(body.prefix) };
  });
  registerJson(router, 'POST', '/api/image-metadata/cleanup', async () => {
    await backgroundsReady;
    return assets.cleanupImageMetadata();
  });
  registerJson(router, 'POST', '/api/image-metadata/folders/get', async () => {
    await backgroundsReady;
    return assets.getBackgroundFolders();
  });
  registerJson(router, 'POST', '/api/image-metadata/folders/create', async (request) => {
    await backgroundsReady;
    const body = await readJsonObject(request);
    return assets.createBackgroundFolder(body.name);
  });
  registerJson(router, 'POST', '/api/image-metadata/folders/set-thumbnail', async (request) => {
    await backgroundsReady;
    const body = await readJsonObject(request);
    return assets.updateBackgroundFolder({
      id: body.id,
      thumbnailFile: body.thumbnailFile,
    });
  });
  registerJson(router, 'POST', '/api/image-metadata/folders/set-thumbnails', async (request) => {
    await backgroundsReady;
    const body = await readJsonObject(request);
    return assets.setBackgroundFolderThumbnails(body.updates);
  });
  registerJson(router, 'POST', '/api/image-metadata/folders/update', async (request) => {
    await backgroundsReady;
    const body = await readJsonObject(request);
    return assets.updateBackgroundFolder({
      id: body.id,
      name: body.name,
      thumbnailFile: body.thumbnailFile,
    });
  });
  registerEmpty(router, 'POST', '/api/image-metadata/folders/delete', async (request) => {
    await backgroundsReady;
    const body = await readJsonObject(request);
    await assets.deleteBackgroundFolder(body.id);
  });
  registerEmpty(router, 'POST', '/api/image-metadata/folders/assign', async (request) => {
    await backgroundsReady;
    const body = await readJsonObject(request);
    await assets.assignBackgroundFolder(body.id, body.paths, false);
  });
  registerEmpty(router, 'POST', '/api/image-metadata/folders/unassign', async (request) => {
    await backgroundsReady;
    const body = await readJsonObject(request);
    await assets.assignBackgroundFolder(body.id, body.paths, true);
  });

  registerJson(router, 'POST', '/api/avatars/get', () => assets.listAvatars());
  router.register('POST', '/api/avatars/upload', async (request, url) => {
    try {
      const form = await request.formData();
      const file = requireFormFile(form, 'avatar');
      const overwriteName = form.get('overwrite_name');
      const crop = parseAvatarCrop(url.searchParams.get('crop'));
      const path = await assets.uploadAvatar(
        file,
        fileNameOf(file, 'avatar.png'),
        typeof overwriteName === 'string' ? overwriteName : undefined,
        crop,
        `${Date.now()}.png`,
      );
      return jsonResponse({ path });
    } catch (error) {
      return assetErrorResponse(error);
    }
  });
  registerEmpty(router, 'POST', '/api/avatars/delete', async (request) => {
    const body = await readJsonObject(request);
    await assets.deleteAvatar(body.avatar);
  });

  registerJson(router, 'GET', '/api/sprites/get', (_request, url) =>
    assets.listSprites(url.searchParams.get('name')),
  );
  router.register('POST', '/api/sprites/upload', async (request) => {
    try {
      const form = await request.formData();
      const file = requireFormFile(form, 'avatar');
      return jsonResponse(
        await assets.uploadSprite({
          name: form.get('name'),
          label: form.get('label'),
          spriteName: form.get('spriteName'),
          file,
          filename: fileNameOf(file, 'sprite.png'),
        }),
      );
    } catch (error) {
      return assetErrorResponse(error);
    }
  });
  router.register('POST', '/api/sprites/upload-zip', async (request) => {
    try {
      const form = await request.formData();
      const file = requireFormFile(form, 'avatar');
      return jsonResponse(await assets.uploadSpriteZip(form.get('name'), file));
    } catch (error) {
      return assetErrorResponse(error);
    }
  });
  registerEmpty(router, 'POST', '/api/sprites/delete', async (request) => {
    const body = await readJsonObject(request);
    await assets.deleteSprite({
      name: body.name,
      label: body.label,
      spriteName: body.spriteName,
    });
  });

  registerJson(router, 'POST', '/api/assets/get', () => assets.getInstalledLibraryAssets());
  router.register('POST', '/api/assets/download', async (request) => {
    try {
      const body = await readJsonObject(request);
      const result = await assets.downloadLibraryAsset({
        url: body.url,
        category: body.category,
        filename: body.filename,
      });
      return libraryDownloadResponse(result);
    } catch (error) {
      return assetErrorResponse(error);
    }
  });
  registerEmpty(router, 'POST', '/api/assets/delete', async (request) => {
    const body = await readJsonObject(request);
    await assets.deleteLibraryAsset(body.category, body.filename);
  });
  router.register('POST', '/api/assets/character', async (request) => {
    try {
      const body = await readJsonObject(request);
      const result = await assets.fetchCharacterAsset({
        url: body.url,
        filename: body.filename,
      });
      return blobResponse(result.blob, result.filename);
    } catch (error) {
      return assetErrorResponse(error);
    }
  });
  router.register('POST', '/api/content/importURL', async (request) => {
    try {
      const body = await readJsonObject(request);
      const result = await assets.fetchExternalCharacterCard({ url: body.url });
      return blobResponse(result.blob, result.filename, {
        'X-Custom-Content-Type': 'character',
      });
    } catch (error) {
      return assetErrorResponse(error);
    }
  });
}

function registerJson(
  router: CompatibilityRouter,
  method: string,
  pathname: string,
  handler: (request: Request, url: URL) => unknown | Promise<unknown>,
): void {
  router.register(method, pathname, async (request, url) => {
    try {
      return jsonResponse(await handler(request, url));
    } catch (error) {
      return assetErrorResponse(error);
    }
  });
}

function registerEmpty(
  router: CompatibilityRouter,
  method: string,
  pathname: string,
  handler: (request: Request, url: URL) => void | Promise<void>,
): void {
  router.register(method, pathname, async (request, url) => {
    try {
      await handler(request, url);
      return textResponse('OK', 200);
    } catch (error) {
      return assetErrorResponse(error);
    }
  });
}

async function readJsonObject(
  request: Request,
  allowEmpty = false,
): Promise<Record<string, unknown>> {
  if (allowEmpty && !request.body) return {};
  let value: unknown;
  try {
    const text = await request.text();
    if (allowEmpty && !text.trim()) return {};
    value = JSON.parse(text) as unknown;
  } catch {
    throw new AssetValidationError('Request body must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssetValidationError('Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function requireFormFile(form: FormData, field: string): Blob {
  const value = form.get(field);
  if (!value || typeof value === 'string' || value.size <= 0) {
    throw new AssetValidationError(`Multipart field ${field} must contain a non-empty file.`);
  }
  return value;
}

function fileNameOf(file: Blob, fallback: string): string {
  const candidate = (file as Blob & { name?: unknown }).name;
  return typeof candidate === 'string' && candidate.trim() ? candidate : fallback;
}

function libraryDownloadResponse(result: LibraryDownloadResult): Response {
  return result.kind === 'blob'
    ? blobResponse(result.blob, result.filename)
    : jsonResponse({ path: result.path });
}

function blobResponse(
  blob: Blob,
  filename: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(blob, {
    status: 200,
    headers: {
      'Content-Type': blob.type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'X-Pure-Tavern-Hook': '1',
      ...extraHeaders,
    },
  });
}

function assetErrorResponse(error: unknown): Response {
  const status = error instanceof AssetError ? error.status : 500;
  return jsonResponse(
    {
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof AssetError ? error.code : 'ASSET_INTERNAL_ERROR',
      pureTavern: true,
    },
    status,
  );
}
