import { unzipSync, type UnzipFileInfo } from 'fflate';

import {
  ASSET_LIBRARY_CATEGORIES,
  type AssetCollection,
  type AssetLibraryCategory,
  type AssetRecord,
  type BackgroundFolder,
  type ImageInfo,
  type ImageMetadata,
} from '../domain/asset';
import type { AssetIndex } from '../ports/asset-index';
import type { AssetOwnerResolver } from '../ports/asset-owner-resolver';
import type { AssetBlobRecord, BlobRepository } from '../ports/blob-repository';
import type { AvatarCrop, ImageProcessor } from '../ports/image-processor';
import {
  AssetConflictError,
  AssetFetchError,
  AssetLimitError,
  AssetNotFoundError,
  AssetValidationError,
} from './asset-errors';
import {
  ASSET_LIMITS,
  assertFileSize,
  assertMimeMatchesExtension,
  assertSafeExtension,
  assertSafeFilename,
  assertSafePathSegment,
  extensionForMimeType,
  getExtension,
  hasControlCharacters,
  makeLegacyPath,
  mimeTypeForFilename,
  normalizeLegacyPath,
  sanitizeFilename,
  withoutExtension,
} from './asset-security';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'apng']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'ogg', 'wav', 'flac']);
const SUPPORTED_PATH_PREFIXES = [
  '/backgrounds/',
  '/user/files/',
  '/user/images/',
  '/User Avatars/',
  '/characters/',
  '/assets/',
  '/scripts/extensions/third-party/',
] as const;

export interface AssetsServiceDiagnostics {
  lastCompensationError: string | null;
  lastFetchError: string | null;
  totalStored: number;
  totalDeleted: number;
}

export interface AssetWithBlob {
  record: AssetRecord;
  blob: AssetBlobRecord;
}

export type LibraryDownloadResult =
  { kind: 'stored'; path: string } | { kind: 'blob'; blob: Blob; filename: string };

export interface ExtensionPackageAssetInput {
  extensionId: string;
  legacyName: string;
  packageHash: string;
  files: readonly { path: string; data: Blob; sha256: string }[];
  installedAt: string;
}

export class AssetService {
  readonly diagnostics: AssetsServiceDiagnostics = {
    lastCompensationError: null,
    lastFetchError: null,
    totalStored: 0,
    totalDeleted: 0,
  };

  readonly #blobs: BlobRepository;
  readonly #index: AssetIndex;
  readonly #images: ImageProcessor;
  readonly #nativeFetch: typeof fetch;
  readonly #ownerResolver: AssetOwnerResolver | undefined;

  constructor(
    blobs: BlobRepository,
    index: AssetIndex,
    images: ImageProcessor,
    nativeFetch: typeof fetch = fetch,
    ownerResolver?: AssetOwnerResolver,
  ) {
    this.#blobs = blobs;
    this.#index = index;
    this.#images = images;
    this.#nativeFetch = nativeFetch;
    this.#ownerResolver = ownerResolver;
  }

  sanitizeFilename(value: unknown): string {
    return sanitizeFilename(value);
  }

  async getAssetByPath(path: string): Promise<AssetWithBlob | null> {
    const normalizedPath = normalizeLegacyPath(path, SUPPORTED_PATH_PREFIXES);
    const record = await this.#index.getByLegacyPath(normalizedPath);
    if (!record) return null;
    const blob = await this.#blobs.get(record.collection, record.id);
    return blob ? { record, blob } : null;
  }

  async uploadFile(name: unknown, data: unknown): Promise<string> {
    const filename = assertSafeFilename(name, 'name');
    if (typeof data !== 'string') throw new AssetValidationError('data must be a base64 string.');
    const decoded = this.#images.decodeBase64(data, mimeTypeForFilename(filename));
    assertFileSize(decoded.blob);
    const content = await this.#validateFile(filename, decoded.blob, false);
    const path = makeLegacyPath('/user/files', filename);
    await this.#storeAsset({
      collection: 'attachments',
      path,
      filename,
      blob: decoded.blob,
      mimeType: content.mimeType,
      ...(content.image ? { image: content.image } : {}),
      replace: true,
    });
    return path;
  }

  async verifyFiles(urls: unknown): Promise<Record<string, boolean>> {
    if (!Array.isArray(urls) || urls.some((url) => typeof url !== 'string')) {
      throw new AssetValidationError('urls must be an array of asset path strings.');
    }
    const result: Record<string, boolean> = {};
    for (const url of urls as string[]) {
      try {
        result[url] = (await this.getAssetByPath(url)) !== null;
      } catch {
        result[url] = false;
      }
    }
    return result;
  }

  async deleteFile(path: unknown): Promise<void> {
    await this.#deleteByPath(path, ['/user/files/']);
  }

  async uploadUserImage(input: {
    image: unknown;
    format: unknown;
    filename?: unknown;
    ch_name?: unknown;
  }): Promise<string> {
    if (typeof input.format !== 'string') {
      throw new AssetValidationError('format must be an image file extension.');
    }
    const extension =
      input.format.toLowerCase().replace(/^\./, '') === 'jpeg'
        ? 'jpg'
        : input.format.toLowerCase().replace(/^\./, '');
    if (!IMAGE_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension)) {
      throw new AssetValidationError(`Unsupported user media format: ${extension || '(empty)'}.`);
    }
    if (typeof input.image !== 'string') {
      throw new AssetValidationError('image must be a base64 string or Data URL.');
    }
    const folder =
      typeof input.ch_name === 'string' && input.ch_name.trim()
        ? assertSafePathSegment(input.ch_name, 'ch_name')
        : '';
    const desiredBase =
      typeof input.filename === 'string' && input.filename.trim()
        ? assertSafeFilename(withoutExtension(input.filename), 'filename')
        : `image-${crypto.randomUUID()}`;
    const filename = `${desiredBase}.${extension}`;
    const decoded = this.#images.decodeBase64(input.image, mimeTypeForFilename(filename));
    assertFileSize(decoded.blob);
    const content = IMAGE_EXTENSIONS.has(extension)
      ? await this.#validateFile(filename, decoded.blob, true)
      : { mimeType: await inspectVideoSignature(decoded.blob, extension) };
    const uniqueFilename = await this.#uniqueFilename('user-images', folder, filename);
    const path = folder
      ? makeLegacyPath('/user/images', folder, uniqueFilename)
      : makeLegacyPath('/user/images', uniqueFilename);
    await this.#storeAsset({
      collection: 'user-images',
      path,
      filename: uniqueFilename,
      blob: decoded.blob,
      mimeType: content.mimeType,
      ...(content.image ? { image: content.image } : {}),
      ...(folder ? { folder } : {}),
      replace: false,
    });
    return path;
  }

  async listUserImages(input: {
    folder?: unknown;
    sortField?: unknown;
    sortOrder?: unknown;
    type?: unknown;
  }): Promise<string[]> {
    const folder =
      typeof input.folder === 'string' && input.folder.trim()
        ? assertSafePathSegment(input.folder, 'folder')
        : '';
    const direction = input.sortOrder === 'desc' ? 'desc' : 'asc';
    const sortBy = input.sortField === 'date' ? 'createdAt' : 'filename';
    const typeMask =
      typeof input.type === 'number' && Number.isInteger(input.type) && input.type > 0
        ? input.type
        : 1 | 2 | 4;
    const records = await this.#index.list({
      collection: 'user-images',
      ...(folder ? { folder } : {}),
      sortBy,
      direction,
    });
    return records
      .filter((record) => matchesMediaType(record.mimeType, typeMask))
      .map((record) => record.filename);
  }

  async listUserImageFolders(): Promise<string[]> {
    const records = await this.#index.list({ collection: 'user-images' });
    return [...new Set(records.map((record) => record.folder).filter(isString))].sort(
      (left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }),
    );
  }

  async deleteUserImage(path: unknown): Promise<void> {
    await this.#deleteByPath(path, ['/user/images/']);
  }

  async uploadBackground(file: Blob, filename: unknown): Promise<string> {
    const safeFilename = assertSafeFilename(filename, 'background filename');
    assertFileSize(file);
    const image = await this.#images.inspect(file);
    assertImageExtension(safeFilename);
    assertMimeMatchesExtension(safeFilename, image.mimeType);
    const path = makeLegacyPath('/backgrounds', safeFilename);
    await this.#storeAsset({
      collection: 'backgrounds',
      path,
      filename: safeFilename,
      blob: file,
      mimeType: image.mimeType,
      image,
      replace: true,
    });
    return safeFilename;
  }

  async listBackgrounds(): Promise<{
    images: { filename: string; isAnimated: boolean }[];
    config: { width: number; height: number };
  }> {
    const records = await this.#index.list({ collection: 'backgrounds', sortBy: 'filename' });
    return {
      images: records.map((record) => ({
        filename: record.filename,
        isAnimated: record.image?.isAnimated ?? false,
      })),
      config: { width: 160, height: 90 },
    };
  }

  async renameBackground(oldName: unknown, newName: unknown): Promise<string> {
    const oldFilename = assertSafeFilename(oldName, 'old_bg');
    const newFilename = assertSafeFilename(newName, 'new_bg');
    assertImageExtension(newFilename);
    const oldPath = makeLegacyPath('/backgrounds', oldFilename);
    const newPath = makeLegacyPath('/backgrounds', newFilename);
    const record = await this.#requireByPath(oldPath);
    if (record.collection !== 'backgrounds') throw new AssetNotFoundError('Background not found.');
    const collision = await this.#index.getByLegacyPath(newPath);
    if (collision && collision.id !== record.id) {
      throw new AssetConflictError(`A background named ${newFilename} already exists.`);
    }
    assertMimeMatchesExtension(newFilename, record.mimeType);

    const previous = structuredClone(record);
    const thumbnailFolders = (await this.#index.listFolders()).filter(
      (folder) => folder.thumbnailFile === oldFilename,
    );
    const previousFolders = thumbnailFolders.map((folder) => structuredClone(folder));
    record.filename = newFilename;
    record.legacyPath = newPath;
    record.updatedAt = new Date().toISOString();
    if (record.imageMetadata) record.imageMetadata.path = newPath;
    try {
      await this.#index.setAlias(newPath, record.id);
      await this.#index.put(record);
      for (const folder of thumbnailFolders) {
        folder.thumbnailFile = newFilename;
        folder.updatedAt = new Date().toISOString();
        await this.#index.putFolder(folder);
      }
      await this.#index.deleteAlias(oldPath);
    } catch (error) {
      await this.#compensate([
        () => this.#index.put(previous),
        () => this.#index.setAlias(oldPath, previous.id),
        () => this.#index.deleteAlias(newPath),
        ...previousFolders.map((folder) => () => this.#index.putFolder(folder)),
      ]);
      throw error;
    }
    return newFilename;
  }

  async deleteBackground(filename: unknown): Promise<void> {
    const safeFilename = assertSafeFilename(filename, 'bg');
    const path = makeLegacyPath('/backgrounds', safeFilename);
    const record = await this.#requireByPath(path);
    const thumbnailFolders = (await this.#index.listFolders()).filter(
      (folder) => folder.thumbnailFile === safeFilename,
    );
    const previousFolders = thumbnailFolders.map((folder) => structuredClone(folder));
    try {
      for (const folder of thumbnailFolders) {
        folder.thumbnailFile = '';
        folder.updatedAt = new Date().toISOString();
        await this.#index.putFolder(folder);
      }
      await this.#deleteRecord(record);
    } catch (error) {
      await this.#compensate(previousFolders.map((folder) => () => this.#index.putFolder(folder)));
      throw error;
    }
  }

  async getBackgroundFolders(): Promise<{
    folders: { id: string; name: string; thumbnailFile: string }[];
    imageFolderMap: Record<string, string[]>;
  }> {
    const [folders, backgrounds] = await Promise.all([
      this.#index.listFolders(),
      this.#index.list({ collection: 'backgrounds' }),
    ]);
    const validFolderIds = new Set(folders.map((folder) => folder.id));
    const imageFolderMap: Record<string, string[]> = {};
    for (const background of backgrounds) {
      const ids = (background.folderIds ?? []).filter((id) => validFolderIds.has(id));
      if (ids.length) imageFolderMap[background.filename] = [...ids];
    }
    return {
      folders: folders.map(({ id, name, thumbnailFile }) => ({ id, name, thumbnailFile })),
      imageFolderMap,
    };
  }

  async getImageMetadata(path: unknown): Promise<ImageMetadata> {
    const normalized = normalizeLegacyPath(path, SUPPORTED_PATH_PREFIXES);
    const record = await this.#requireByPath(normalized);
    return record.imageMetadata ?? this.#metadataFor(record, record.image);
  }

  async setImageMetadata(path: unknown, metadata: unknown): Promise<ImageMetadata> {
    const normalized = normalizeLegacyPath(path, SUPPORTED_PATH_PREFIXES);
    const current = await this.getImageMetadata(normalized);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new AssetValidationError('metadata must be a JSON object.');
    }
    const merged = {
      ...current,
      ...(structuredClone(metadata) as Record<string, unknown>),
      path: normalized,
      addedTimestamp: toFiniteNumber(
        (metadata as Record<string, unknown>).addedTimestamp,
        current.addedTimestamp,
      ),
    } as ImageMetadata;
    assertJsonSerializable(merged);
    await this.#index.putImageMetadata(normalized, merged);
    return merged;
  }

  async listImageMetadata(prefix: unknown = ''): Promise<Record<string, ImageMetadata>> {
    const normalizedPrefix =
      typeof prefix === 'string' && prefix.trim() ? normalizeMetadataPrefix(prefix) : '/';
    const records = await this.#index.list();
    const result: Record<string, ImageMetadata> = {};
    for (const record of records) {
      if (!record.legacyPath.startsWith(normalizedPrefix)) continue;
      const metadata = record.imageMetadata ?? this.#metadataFor(record, record.image);
      result[toLegacyMetadataKey(record.legacyPath)] = metadata;
    }
    return result;
  }

  async cleanupImageMetadata(): Promise<{ removed: number }> {
    return { removed: 0 };
  }

  async createBackgroundFolder(name: unknown): Promise<{
    id: string;
    name: string;
    thumbnailFile: string;
  }> {
    const safeName = assertFolderName(name);
    const folders = await this.#index.listFolders();
    if (
      folders.some((folder) => folder.name.toLocaleLowerCase() === safeName.toLocaleLowerCase())
    ) {
      throw new AssetConflictError(`A background folder named ${safeName} already exists.`);
    }
    const now = new Date().toISOString();
    const folder: BackgroundFolder = {
      id: crypto.randomUUID(),
      name: safeName,
      thumbnailFile: '',
      createdAt: now,
      updatedAt: now,
    };
    await this.#index.putFolder(folder);
    return { id: folder.id, name: folder.name, thumbnailFile: folder.thumbnailFile };
  }

  async updateBackgroundFolder(input: {
    id: unknown;
    name?: unknown;
    thumbnailFile?: unknown;
  }): Promise<{ id: string; name: string; thumbnailFile: string }> {
    const id = requireString(input.id, 'id');
    const folder = await this.#index.getFolder(id);
    if (!folder) throw new AssetNotFoundError('Background folder not found.');
    if (input.name !== undefined) folder.name = assertFolderName(input.name);
    if (input.thumbnailFile !== undefined) {
      const thumbnailFile =
        input.thumbnailFile === '' ? '' : assertSafeFilename(input.thumbnailFile, 'thumbnailFile');
      if (thumbnailFile) {
        const background = await this.#index.getByLegacyPath(
          makeLegacyPath('/backgrounds', thumbnailFile),
        );
        if (!background) throw new AssetNotFoundError('Folder thumbnail background not found.');
      }
      folder.thumbnailFile = thumbnailFile;
    }
    folder.updatedAt = new Date().toISOString();
    await this.#index.putFolder(folder);
    return { id: folder.id, name: folder.name, thumbnailFile: folder.thumbnailFile };
  }

  async setBackgroundFolderThumbnails(updates: unknown): Promise<{ updated: number }> {
    if (!Array.isArray(updates)) throw new AssetValidationError('updates must be an array.');
    let updated = 0;
    for (const value of updates) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new AssetValidationError('Each thumbnail update must be an object.');
      }
      const update = value as Record<string, unknown>;
      await this.updateBackgroundFolder({
        id: update.id,
        thumbnailFile: update.thumbnailFile,
      });
      updated += 1;
    }
    return { updated };
  }

  async deleteBackgroundFolder(idValue: unknown): Promise<void> {
    const id = requireString(idValue, 'id');
    const folder = await this.#index.getFolder(id);
    if (!folder) throw new AssetNotFoundError('Background folder not found.');
    const backgrounds = await this.#index.list({ collection: 'backgrounds' });
    const affected = backgrounds.filter((record) => record.folderIds?.includes(id));
    const originals = affected.map((record) => structuredClone(record));
    try {
      for (const record of affected) {
        const remainingFolderIds = record.folderIds?.filter((folderId) => folderId !== id);
        if (remainingFolderIds?.length) record.folderIds = remainingFolderIds;
        else delete record.folderIds;
        record.updatedAt = new Date().toISOString();
        await this.#index.put(record);
      }
      await this.#index.deleteFolder(id);
    } catch (error) {
      await this.#compensate([
        ...originals.map((record) => () => this.#index.put(record)),
        () => this.#index.putFolder(folder),
      ]);
      throw error;
    }
  }

  async assignBackgroundFolder(
    idValue: unknown,
    pathsValue: unknown,
    remove = false,
  ): Promise<void> {
    const id = requireString(idValue, 'id');
    if (!(await this.#index.getFolder(id))) {
      throw new AssetNotFoundError('Background folder not found.');
    }
    if (!Array.isArray(pathsValue) || pathsValue.some((path) => typeof path !== 'string')) {
      throw new AssetValidationError('paths must be an array of background paths.');
    }
    const originals: AssetRecord[] = [];
    try {
      for (const rawPath of pathsValue as string[]) {
        const path = normalizeBackgroundMetadataPath(rawPath);
        const record = await this.#requireByPath(path);
        if (record.collection !== 'backgrounds') {
          throw new AssetValidationError(`${rawPath} is not a background path.`);
        }
        originals.push(structuredClone(record));
        const folderIds = new Set(record.folderIds ?? []);
        if (remove) folderIds.delete(id);
        else folderIds.add(id);
        record.folderIds = [...folderIds];
        record.updatedAt = new Date().toISOString();
        await this.#index.put(record);
      }
    } catch (error) {
      await this.#compensate(originals.map((record) => () => this.#index.put(record)));
      throw error;
    }
  }

  async listAvatars(): Promise<string[]> {
    const records = await this.#index.list({ collection: 'user-avatars', sortBy: 'filename' });
    const names = records.map((record) => record.filename);
    return names.includes('user-default.png') ? names : ['user-default.png', ...names];
  }

  async uploadAvatar(
    file: Blob,
    filename: unknown,
    overwriteName?: unknown,
    crop?: AvatarCrop,
  ): Promise<string> {
    const sourceFilename = assertSafeFilename(filename, 'avatar filename');
    assertImageExtension(sourceFilename);
    assertFileSize(file);
    const sourceInfo = await this.#images.inspect(file);
    assertMimeMatchesExtension(sourceFilename, sourceInfo.mimeType);
    const processed = await this.#images.processAvatar(file, crop);
    const overwrite =
      typeof overwriteName === 'string' && overwriteName.trim()
        ? assertSafeFilename(overwriteName, 'overwrite_name')
        : null;
    let outputFilename = overwrite ?? sourceFilename;
    if (!overwrite && processed.processed && processed.info.mimeType !== sourceInfo.mimeType) {
      outputFilename = replaceExtension(
        outputFilename,
        extensionForMimeType(processed.info.mimeType) ?? 'png',
      );
    }
    if (!overwrite) outputFilename = await this.#uniqueFilename('user-avatars', '', outputFilename);
    const path = makeLegacyPath('/User Avatars', outputFilename);
    await this.#storeAsset({
      collection: 'user-avatars',
      path,
      filename: outputFilename,
      blob: processed.blob,
      mimeType: processed.info.mimeType,
      image: processed.info,
      replace: Boolean(overwrite),
    });
    return outputFilename;
  }

  async deleteAvatar(filename: unknown): Promise<void> {
    const safeFilename = assertSafeFilename(filename, 'avatar');
    if (safeFilename === 'user-default.png') {
      throw new AssetValidationError('The built-in default avatar cannot be deleted.');
    }
    await this.#deleteByPath(makeLegacyPath('/User Avatars', safeFilename), ['/User Avatars/']);
  }

  async hasAvatar(filename: unknown): Promise<boolean> {
    const safeFilename = assertSafeFilename(filename, 'avatar');
    if (safeFilename === 'user-default.png') return true;
    return (await this.getAssetByPath(makeLegacyPath('/User Avatars', safeFilename))) !== null;
  }

  async renameAvatar(fromFilename: unknown, toFilename: unknown): Promise<string> {
    const from = assertSafeFilename(fromFilename, 'current avatar');
    const to = assertSafeFilename(toFilename, 'new avatar');
    if (from === 'user-default.png' || to === 'user-default.png') {
      throw new AssetValidationError('The built-in default avatar alias cannot be moved.');
    }
    assertImageExtension(to);
    const fromPath = makeLegacyPath('/User Avatars', from);
    const toPath = makeLegacyPath('/User Avatars', to);
    const record = await this.#requireByPath(fromPath);
    if (record.collection !== 'user-avatars') {
      throw new AssetNotFoundError('Persona avatar not found.');
    }
    const collision = await this.#index.getByLegacyPath(toPath);
    if (collision && collision.id !== record.id) {
      throw new AssetConflictError(`A persona avatar named ${to} already exists.`);
    }
    assertMimeMatchesExtension(to, record.mimeType);

    const previous = structuredClone(record);
    record.filename = to;
    record.legacyPath = toPath;
    record.updatedAt = new Date().toISOString();
    try {
      await this.#index.setAlias(toPath, record.id);
      await this.#index.put(record);
      await this.#index.deleteAlias(fromPath);
    } catch (error) {
      await this.#compensate([
        () => this.#index.put(previous),
        () => this.#index.setAlias(fromPath, previous.id),
        () => this.#index.deleteAlias(toPath),
      ]);
      throw error;
    }
    return to;
  }

  async listSprites(name: unknown): Promise<{ label: string; path: string }[]> {
    const ownerAlias = normalizeOwnerAlias(name);
    const owner = await this.#resolveOwner(ownerAlias);
    const records = await this.#index.list({ collection: 'sprites', owner, sortBy: 'filename' });
    return records.map((record) => ({
      label: record.label ?? withoutExtension(record.filename),
      path: record.legacyPath,
    }));
  }

  async uploadSprite(input: {
    name: unknown;
    label: unknown;
    spriteName?: unknown;
    file: Blob;
    filename: unknown;
  }): Promise<{ label: string; path: string }> {
    const ownerAlias = normalizeOwnerAlias(input.name);
    const label = assertSafePathSegment(input.label, 'label');
    const sourceFilename = assertSafeFilename(input.filename, 'sprite filename');
    assertImageExtension(sourceFilename);
    const extension = getExtension(sourceFilename);
    const spriteBase =
      input.spriteName === undefined || input.spriteName === null || input.spriteName === ''
        ? label
        : assertSafeFilename(withoutExtension(String(input.spriteName)), 'spriteName');
    if (
      spriteBase !== label &&
      !spriteBase.startsWith(`${label}-`) &&
      !spriteBase.startsWith(`${label}.`)
    ) {
      throw new AssetValidationError(
        'spriteName must equal the label or use a label-/label. suffix.',
      );
    }
    const outputFilename = `${spriteBase}.${extension}`;
    assertFileSize(input.file);
    const image = await this.#images.inspect(input.file);
    assertMimeMatchesExtension(outputFilename, image.mimeType);
    const owner = await this.#resolveOwner(ownerAlias);
    const path = makeSpritePath(ownerAlias, outputFilename);
    await this.#storeAsset({
      collection: 'sprites',
      path,
      filename: outputFilename,
      blob: input.file,
      mimeType: image.mimeType,
      image,
      owner,
      folder: ownerAlias,
      label,
      spriteName: spriteBase,
      replace: true,
    });
    return { label, path };
  }

  async uploadSpriteZip(name: unknown, archive: Blob): Promise<{ count: number }> {
    const ownerAlias = normalizeOwnerAlias(name);
    assertFileSize(archive, ASSET_LIMITS.maxZipBytes);
    const bytes = new Uint8Array(await archive.arrayBuffer());
    let fileCount = 0;
    let expandedBytes = 0;
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, {
        filter: (file) => {
          assertSafeZipEntry(file);
          if (file.name.endsWith('/')) return false;
          const basename = zipBasename(file.name);
          if (basename === '.DS_Store' || file.name.includes('__MACOSX/')) return false;
          const extension = getExtension(basename);
          if (!IMAGE_EXTENSIONS.has(extension)) return false;
          fileCount += 1;
          expandedBytes += file.originalSize;
          if (fileCount > ASSET_LIMITS.maxZipFiles) {
            throw new AssetLimitError(
              `Sprite ZIP contains more than ${ASSET_LIMITS.maxZipFiles} files.`,
            );
          }
          if (
            file.originalSize > ASSET_LIMITS.maxFileBytes ||
            expandedBytes > ASSET_LIMITS.maxZipExpandedBytes
          ) {
            throw new AssetLimitError('Sprite ZIP expanded size exceeds the safety limit.');
          }
          return true;
        },
      });
    } catch (error) {
      if (error instanceof AssetValidationError || error instanceof AssetLimitError) throw error;
      throw new AssetValidationError(
        `Sprite ZIP could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const prepared: { filename: string; label: string; blob: Blob; image: ImageInfo }[] = [];
    const seen = new Set<string>();
    let actualExpandedBytes = 0;
    for (const [entryName, data] of Object.entries(files)) {
      const filename = assertSafeFilename(zipBasename(entryName), 'sprite ZIP filename');
      if (seen.has(filename.toLocaleLowerCase())) {
        throw new AssetConflictError(`Sprite ZIP contains duplicate filename ${filename}.`);
      }
      seen.add(filename.toLocaleLowerCase());
      actualExpandedBytes += data.byteLength;
      if (actualExpandedBytes > ASSET_LIMITS.maxZipExpandedBytes) {
        throw new AssetLimitError('Sprite ZIP expanded size exceeds the safety limit.');
      }
      const blob = blobFromBytes(data, mimeTypeForFilename(filename));
      assertFileSize(blob);
      const image = await this.#images.inspect(blob);
      assertMimeMatchesExtension(filename, image.mimeType);
      prepared.push({
        filename,
        label: spriteLabelFromFilename(filename),
        blob,
        image,
      });
    }

    const owner = await this.#resolveOwner(ownerAlias);
    for (const sprite of prepared) {
      await this.#storeAsset({
        collection: 'sprites',
        path: makeSpritePath(ownerAlias, sprite.filename),
        filename: sprite.filename,
        blob: sprite.blob,
        mimeType: sprite.image.mimeType,
        image: sprite.image,
        owner,
        folder: ownerAlias,
        label: sprite.label,
        spriteName: withoutExtension(sprite.filename),
        replace: true,
      });
    }
    return { count: prepared.length };
  }

  async deleteSprite(input: {
    name: unknown;
    label?: unknown;
    spriteName?: unknown;
  }): Promise<void> {
    const ownerAlias = normalizeOwnerAlias(input.name);
    const owner = await this.#resolveOwner(ownerAlias);
    const records = await this.#index.list({ collection: 'sprites', owner });
    const label = typeof input.label === 'string' ? input.label : '';
    const spriteName = typeof input.spriteName === 'string' ? input.spriteName : '';
    const record = records.find((candidate) => {
      if (spriteName && withoutExtension(candidate.filename) !== withoutExtension(spriteName))
        return false;
      if (label && candidate.label !== label) return false;
      return Boolean(spriteName || label);
    });
    if (!record) throw new AssetNotFoundError('Sprite not found.');
    await this.#deleteRecord(record);
  }

  async getInstalledLibraryAssets(): Promise<Record<AssetLibraryCategory, string[]>> {
    const result = Object.fromEntries(
      ASSET_LIBRARY_CATEGORIES.map((category) => [category, [] as string[]]),
    ) as Record<AssetLibraryCategory, string[]>;
    const records = await this.#index.list({ collection: 'library', sortBy: 'filename' });
    for (const record of records) {
      if (record.category) result[record.category].push(record.legacyPath);
    }
    return result;
  }

  async downloadLibraryAsset(input: {
    url: unknown;
    category: unknown;
    filename?: unknown;
  }): Promise<LibraryDownloadResult> {
    const category = parseLibraryCategory(input.category);
    const url = parseRemoteUrl(input.url);
    const requestedFilename =
      typeof input.filename === 'string' && input.filename.trim()
        ? assertSafeFilename(input.filename, 'filename')
        : assertSafeFilename(remoteFilename(url), 'remote filename');
    const blob = await this.#fetchRemoteBlob(url);
    if (category === 'character') return { kind: 'blob', blob, filename: requestedFilename };
    await this.#validateLibraryFile(category, requestedFilename, blob);
    const path = makeLegacyPath('/assets', category, requestedFilename);
    const content = await this.#validateFile(requestedFilename, blob, false);
    await this.#storeAsset({
      collection: 'library',
      path,
      filename: requestedFilename,
      blob,
      mimeType: content.mimeType,
      ...(content.image ? { image: content.image } : {}),
      category,
      replace: true,
    });
    return { kind: 'stored', path };
  }

  async fetchCharacterAsset(input: { url: unknown; filename?: unknown }): Promise<{
    blob: Blob;
    filename: string;
  }> {
    const url = parseRemoteUrl(input.url);
    const filename =
      typeof input.filename === 'string' && input.filename.trim()
        ? assertSafeFilename(input.filename, 'filename')
        : assertSafeFilename(remoteFilename(url), 'remote filename');
    const blob = await this.#fetchRemoteBlob(url);
    return { blob, filename };
  }

  async deleteLibraryAsset(categoryValue: unknown, filenameValue: unknown): Promise<void> {
    const category = parseLibraryCategory(categoryValue);
    if (category === 'character') {
      throw new AssetValidationError(
        'Downloaded character blobs are not stored in the Assets library.',
      );
    }
    const filename = assertSafeFilename(filenameValue, 'filename');
    await this.#deleteByPath(makeLegacyPath('/assets', category, filename), ['/assets/']);
  }

  async saveExtensionPackage(input: ExtensionPackageAssetInput): Promise<void> {
    const extensionId = assertSafeExtensionPackageSegment(input.extensionId, 'extensionId');
    const legacyName = normalizeExtensionLegacyName(input.legacyName);
    const owner = extensionPackageOwner(extensionId);
    const existing = await this.#index.list({ collection: 'library', owner });
    const previousByPath = new Map<string, AssetWithBlob>();
    for (const record of existing) {
      const blob = await this.#blobs.get(record.collection, record.id);
      if (blob) previousByPath.set(record.legacyPath, { record, blob });
    }

    const prepared = input.files.map((file) => {
      const relativePath = normalizeExtensionPackageRelativePath(file.path);
      const path = normalizeLegacyPath(`/scripts/extensions/${legacyName}/${relativePath}`, [
        '/scripts/extensions/third-party/',
      ]);
      const filename = relativePath.split('/').at(-1) ?? '';
      return {
        path,
        filename,
        blob: file.data,
        mimeType: extensionPackageMimeType(filename, file.data.type),
      };
    });
    const expectedPaths = new Set(prepared.map((file) => file.path));
    const written: string[] = [];

    try {
      for (const file of prepared) {
        assertFileSize(file.blob, ASSET_LIMITS.maxFileBytes);
        await this.#storeAsset({
          collection: 'library',
          path: file.path,
          filename: file.filename,
          blob: file.blob,
          mimeType: file.mimeType,
          owner,
          folder: legacyName,
          replace: true,
        });
        written.push(file.path);
      }
      for (const stale of existing.filter((record) => !expectedPaths.has(record.legacyPath))) {
        await this.#deleteRecord(stale);
      }
    } catch (error) {
      await this.#compensate(
        written.map((path) => async () => {
          const previous = previousByPath.get(path);
          if (previous) {
            await this.#storeAsset({
              collection: previous.record.collection,
              path: previous.record.legacyPath,
              filename: previous.record.filename,
              blob: previous.blob.data,
              mimeType: previous.record.mimeType,
              ...(previous.record.owner ? { owner: previous.record.owner } : {}),
              ...(previous.record.folder ? { folder: previous.record.folder } : {}),
              replace: true,
            });
            return;
          }
          const current = await this.#index.getByLegacyPath(path);
          if (current) await this.#deleteRecord(current);
        }),
      );
      throw error;
    }
  }

  async removeExtensionPackage(extensionIdInput: unknown): Promise<void> {
    const extensionId = assertSafeExtensionPackageSegment(extensionIdInput, 'extensionId');
    const records = await this.#index.list({
      collection: 'library',
      owner: extensionPackageOwner(extensionId),
    });
    for (const record of records) await this.#deleteRecord(record);
  }

  async resolveExtensionPackageAssetUrl(
    extensionIdInput: unknown,
    relativePathInput: unknown,
  ): Promise<string | null> {
    const extensionId = assertSafeExtensionPackageSegment(extensionIdInput, 'extensionId');
    const relativePath = normalizeExtensionPackageRelativePath(relativePathInput);
    const records = await this.#index.list({
      collection: 'library',
      owner: extensionPackageOwner(extensionId),
    });
    const suffix = `/${relativePath}`;
    return records.find((record) => record.legacyPath.endsWith(suffix))?.legacyPath ?? null;
  }

  async #storeAsset(input: {
    collection: AssetCollection;
    path: string;
    filename: string;
    blob: Blob;
    mimeType: string;
    image?: ImageInfo;
    owner?: string;
    folder?: string;
    category?: AssetLibraryCategory;
    label?: string;
    spriteName?: string;
    replace: boolean;
  }): Promise<AssetRecord> {
    const path = normalizeLegacyPath(input.path, SUPPORTED_PATH_PREFIXES);
    const existing = await this.#index.getByLegacyPath(path);
    if (existing && !input.replace)
      throw new AssetConflictError(`An asset already exists at ${path}.`);
    const previousBlob = existing ? await this.#blobs.get(existing.collection, existing.id) : null;
    const now = new Date().toISOString();
    const record: AssetRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      collection: input.collection,
      legacyPath: path,
      filename: input.filename,
      mimeType: input.mimeType || input.blob.type || 'application/octet-stream',
      size: input.blob.size,
      ...(input.owner ? { owner: input.owner } : {}),
      ...(input.folder ? { folder: input.folder } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.spriteName ? { spriteName: input.spriteName } : {}),
      ...(existing?.folderIds ? { folderIds: [...existing.folderIds] } : {}),
      ...(input.image ? { image: input.image } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (input.image) record.imageMetadata = this.#metadataFor(record, input.image);

    await this.#blobs.put(input.collection, record.id, input.blob, {
      filename: record.filename,
      mimeType: record.mimeType,
      legacyPath: record.legacyPath,
    });
    try {
      await this.#index.put(record);
      await this.#index.setAlias(path, record.id);
    } catch (error) {
      await this.#compensate([
        async () => {
          if (existing) await this.#index.put(existing);
          else await this.#index.delete(record.id);
        },
        async () => {
          if (existing) await this.#index.setAlias(existing.legacyPath, existing.id);
          else await this.#index.deleteAlias(path);
        },
        async () => {
          if (previousBlob) {
            await this.#blobs.put(
              previousBlob.collection,
              previousBlob.id,
              previousBlob.data,
              previousBlob.metadata,
            );
          } else {
            await this.#blobs.delete(input.collection, record.id);
          }
        },
      ]);
      throw error;
    }
    this.diagnostics.totalStored += 1;
    return record;
  }

  async #deleteByPath(path: unknown, prefixes: readonly string[]): Promise<void> {
    const normalizedPath = normalizeLegacyPath(path, prefixes);
    const record = await this.#requireByPath(normalizedPath);
    await this.#deleteRecord(record);
  }

  async #deleteRecord(record: AssetRecord): Promise<void> {
    const blob = await this.#blobs.get(record.collection, record.id);
    try {
      await this.#index.deleteAlias(record.legacyPath);
      await this.#index.delete(record.id);
      await this.#blobs.delete(record.collection, record.id);
    } catch (error) {
      await this.#compensate([
        () => this.#index.put(record),
        () => this.#index.setAlias(record.legacyPath, record.id),
        async () => {
          if (blob) await this.#blobs.put(blob.collection, blob.id, blob.data, blob.metadata);
        },
      ]);
      throw error;
    }
    this.diagnostics.totalDeleted += 1;
  }

  async #requireByPath(path: string): Promise<AssetRecord> {
    const record = await this.#index.getByLegacyPath(path);
    if (!record) throw new AssetNotFoundError(`Asset not found at ${path}.`);
    return record;
  }

  async #validateFile(
    filename: string,
    blob: Blob,
    requireImage: boolean,
  ): Promise<{ mimeType: string; image?: ImageInfo }> {
    assertSafeExtension(filename);
    const extension = getExtension(filename);
    if (requireImage || IMAGE_EXTENSIONS.has(extension)) {
      const image = await this.#images.inspect(blob);
      const declaredTypeMatches =
        blob.type === image.mimeType ||
        (blob.type === 'image/apng' && image.mimeType === 'image/png') ||
        !blob.type ||
        blob.type === 'application/octet-stream';
      if (!declaredTypeMatches) {
        throw new AssetValidationError(
          `Declared MIME type ${blob.type} does not match detected image type ${image.mimeType}.`,
        );
      }
      assertMimeMatchesExtension(filename, image.mimeType);
      return { mimeType: image.mimeType, image };
    }
    const mimeType = blob.type || mimeTypeForFilename(filename);
    assertMimeMatchesExtension(filename, mimeType);
    return { mimeType };
  }

  async #validateLibraryFile(
    category: AssetLibraryCategory,
    filename: string,
    blob: Blob,
  ): Promise<void> {
    assertFileSize(blob, ASSET_LIMITS.maxRemoteFileBytes);
    const extension = getExtension(filename);
    if (
      (category === 'bgm' || category === 'ambient' || category === 'blip') &&
      !AUDIO_EXTENSIONS.has(extension)
    ) {
      throw new AssetValidationError(`${category} assets must use a supported audio extension.`);
    }
    if (category === 'vrm' && extension !== 'vrm') {
      throw new AssetValidationError('VRM assets must use the .vrm extension.');
    }
    if (category === 'live2d' && !['zip', 'json', 'moc3', 'png'].includes(extension)) {
      throw new AssetValidationError('Live2D assets must be ZIP, JSON, MOC3, or PNG files.');
    }
    if (IMAGE_EXTENSIONS.has(extension)) await this.#validateFile(filename, blob, true);
  }

  async #fetchRemoteBlob(url: URL): Promise<Blob> {
    let response: Response;
    try {
      response = await this.#nativeFetch(url.href, { cache: 'no-cache' });
    } catch (error) {
      const message = `Browser fetch failed for ${url.origin}; the remote server may block CORS: ${error instanceof Error ? error.message : String(error)}`;
      this.diagnostics.lastFetchError = message;
      throw new AssetFetchError(message);
    }
    if (!response.ok) {
      const message = `Remote asset request failed with HTTP ${response.status}.`;
      this.diagnostics.lastFetchError = message;
      throw new AssetFetchError(message);
    }
    const contentLength = response.headers.get('content-length');
    const declaredSize = contentLength === null ? null : Number(contentLength);
    if (
      declaredSize !== null &&
      Number.isFinite(declaredSize) &&
      declaredSize > ASSET_LIMITS.maxRemoteFileBytes
    ) {
      throw new AssetLimitError('Remote asset exceeds the download size limit.');
    }
    const blob = await readBoundedResponseBlob(response, ASSET_LIMITS.maxRemoteFileBytes);
    assertFileSize(blob, ASSET_LIMITS.maxRemoteFileBytes);
    return blob;
  }

  async #uniqueFilename(
    collection: AssetCollection,
    folder: string,
    desired: string,
  ): Promise<string> {
    const records = await this.#index.list({
      collection,
      ...(folder ? { folder } : {}),
    });
    const existing = new Set(records.map((record) => record.filename.toLocaleLowerCase()));
    if (!existing.has(desired.toLocaleLowerCase())) return desired;
    const extension = getExtension(desired);
    const stem = withoutExtension(desired);
    for (let suffix = 1; suffix < 10_000; suffix += 1) {
      const candidate = extension ? `${stem}_${suffix}.${extension}` : `${stem}_${suffix}`;
      if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
    }
    throw new AssetConflictError('Could not allocate a unique asset filename.');
  }

  async #resolveOwner(ownerAlias: string): Promise<string> {
    const resolved = await this.#ownerResolver?.resolveOwner(ownerAlias);
    return resolved?.trim() || `legacy:${ownerAlias.normalize('NFKC')}`;
  }

  #metadataFor(record: AssetRecord, image?: ImageInfo): ImageMetadata {
    return {
      path: record.legacyPath,
      addedTimestamp: Date.parse(record.createdAt),
      ...(image
        ? {
            width: image.width,
            height: image.height,
            aspectRatio: image.width / image.height,
            isAnimated: image.isAnimated,
          }
        : {}),
    };
  }

  async #compensate(operations: (() => Promise<void>)[]): Promise<void> {
    const results = await Promise.allSettled(operations.map((operation) => operation()));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) {
      this.diagnostics.lastCompensationError = failures
        .map((failure) => String((failure as PromiseRejectedResult).reason))
        .join('; ');
    }
  }
}

function normalizeOwnerAlias(value: unknown): string {
  const owner = requireString(value, 'name');
  const segments = owner.split('/');
  if (segments.some((segment) => !segment))
    throw new AssetValidationError('name contains an empty path segment.');
  return segments.map((segment) => assertSafePathSegment(segment, 'name')).join('/');
}

function makeSpritePath(ownerAlias: string, filename: string): string {
  const ownerSegments = ownerAlias
    .split('/')
    .map((segment) => assertSafePathSegment(segment, 'name'));
  return normalizeLegacyPath(`/characters/${[...ownerSegments, filename].join('/')}`, [
    '/characters/',
  ]);
}

function assertImageExtension(filename: string): void {
  if (!IMAGE_EXTENSIONS.has(getExtension(filename))) {
    throw new AssetValidationError('Only PNG, JPEG, GIF, WebP, and APNG images are supported.');
  }
}

async function inspectVideoSignature(blob: Blob, extension: string): Promise<string> {
  const bytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  if (extension === 'webm') {
    if (bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) {
      throw new AssetValidationError('WebM file signature does not match its extension.');
    }
    assertMimeMatchesExtension('media.webm', blob.type || 'video/webm');
    return 'video/webm';
  }
  if (extension === 'mp4' || extension === 'mov') {
    const brand = String.fromCharCode(...bytes.slice(4, 8));
    if (brand !== 'ftyp') {
      throw new AssetValidationError('MP4/QuickTime file signature does not match its extension.');
    }
    const mimeType = extension === 'mov' ? 'video/quicktime' : 'video/mp4';
    assertMimeMatchesExtension(`media.${extension}`, blob.type || mimeType);
    return mimeType;
  }
  throw new AssetValidationError(`Unsupported video extension: ${extension}.`);
}

function matchesMediaType(mimeType: string, mask: number): boolean {
  if (mimeType.startsWith('image/')) return (mask & 1) !== 0;
  if (mimeType.startsWith('video/')) return (mask & 2) !== 0;
  if (mimeType.startsWith('audio/')) return (mask & 4) !== 0;
  return false;
}

function normalizeBackgroundMetadataPath(path: string): string {
  const prefixed = path.startsWith('/') ? path : `/${path}`;
  return normalizeLegacyPath(prefixed, ['/backgrounds/']);
}

function normalizeMetadataPrefix(prefix: string): string {
  let normalized = prefix.trim().replace(/\\/g, '/');
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  if (!normalized.endsWith('/')) normalized += '/';
  if (normalized.includes('..') || hasControlCharacters(normalized)) {
    throw new AssetValidationError('Image metadata prefix is unsafe.');
  }
  return normalized;
}

function toLegacyMetadataKey(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function assertFolderName(value: unknown): string {
  const name = requireString(value, 'name').normalize('NFKC').trim();
  if (name.length > 100) throw new AssetValidationError('Folder name is too long.');
  if (hasControlCharacters(name)) {
    throw new AssetValidationError('Folder name contains control characters.');
  }
  return name;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AssetValidationError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function extensionPackageOwner(extensionId: string): string {
  return `extension-package:${extensionId}`;
}

function normalizeExtensionLegacyName(value: unknown): string {
  if (typeof value !== 'string' || !/^third-party\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u.test(value)) {
    throw new AssetValidationError('legacyName must be a safe third-party extension path.');
  }
  return value;
}

function assertSafeExtensionPackageSegment(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(value)) {
    throw new AssetValidationError(`${label} is not a safe extension package identifier.`);
  }
  return value;
}

function normalizeExtensionPackageRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('%')) {
    throw new AssetValidationError('Extension package path is unsafe.');
  }
  const segments = value.split('/');
  if (
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..' || hasControlCharacters(segment),
    )
  ) {
    throw new AssetValidationError(`Extension package path contains an unsafe segment: ${value}`);
  }
  return segments.join('/');
}

function extensionPackageMimeType(filename: string, declaredType: string): string {
  if (declaredType && declaredType !== 'application/octet-stream') return declaredType;
  switch (getExtension(filename)) {
    case 'html':
    case 'htm':
      return 'text/html';
    case 'js':
    case 'mjs':
      return 'text/javascript';
    case 'css':
      return 'text/css';
    case 'json':
      return 'application/json';
    default:
      return mimeTypeForFilename(filename);
  }
}

function parseLibraryCategory(value: unknown): AssetLibraryCategory {
  const category = requireString(value, 'category') as AssetLibraryCategory;
  if (!ASSET_LIBRARY_CATEGORIES.includes(category)) {
    throw new AssetValidationError(`Unsupported asset category: ${category}.`);
  }
  return category;
}

function parseRemoteUrl(value: unknown): URL {
  const raw = requireString(value, 'url');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AssetValidationError('url must be an absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new AssetValidationError('url must be an HTTP(S) URL without embedded credentials.');
  }
  return url;
}

function remoteFilename(url: URL): string {
  const finalSegment = url.pathname.split('/').filter(Boolean).at(-1);
  if (!finalSegment) throw new AssetValidationError('Remote URL does not contain a filename.');
  try {
    return decodeURIComponent(finalSegment);
  } catch {
    throw new AssetValidationError('Remote filename contains invalid percent encoding.');
  }
}

function replaceExtension(filename: string, extension: string): string {
  return `${withoutExtension(filename)}.${extension}`;
}

function assertSafeZipEntry(file: UnzipFileInfo): void {
  const name = file.name.replace(/\\/g, '/');
  if (
    !name ||
    name.startsWith('/') ||
    /^[a-z]:\//i.test(name) ||
    file.name.includes('\\') ||
    name.split('/').some((segment) => segment === '..' || segment === '.') ||
    hasControlCharacters(name)
  ) {
    throw new AssetValidationError(
      `Sprite ZIP contains an unsafe path: ${file.name || '(empty)'}.`,
    );
  }
}

function zipBasename(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '';
}

function spriteLabelFromFilename(filename: string): string {
  const stem = withoutExtension(filename);
  return stem.split(/[-.]/, 1)[0] || stem;
}

async function readBoundedResponseBlob(response: Response, limit: number): Promise<Blob> {
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > limit)
      throw new AssetLimitError('Remote asset exceeds the download size limit.');
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel('asset size limit exceeded').catch(() => undefined);
      throw new AssetLimitError('Remote asset exceeds the download size limit.');
    }
    chunks.push(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer,
    );
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? '';
  return new Blob(chunks, { type: contentType });
}

function blobFromBytes(bytes: Uint8Array, mimeType: string): Blob {
  const data = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([data], { type: mimeType });
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function assertJsonSerializable(value: unknown): void {
  try {
    if (JSON.stringify(value) === undefined) throw new Error('undefined');
  } catch {
    throw new AssetValidationError('Image metadata must be JSON-serializable.');
  }
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string';
}
