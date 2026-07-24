import {
  cloneJson,
  deepMerge,
  formatCharacterData,
  getPath,
  isPlainObject,
  normalizeCharacterCard,
  processUnsetSentinels,
  readFromV2,
  serializeCard,
  toLegacyCharacterDto,
  unsetPath,
  unsetPrivateFields,
  type CharacterCard,
  type JsonObject,
  type LegacyCharacterDto,
} from '../domain/character-card';
import type { CharacterAssetRepository } from '../ports/character-asset-repository';
import type { CharacterRepository, StoredCharacter } from '../ports/character-repository';
import { CharacterCardCodec } from './character-card-codec';
import {
  CharacterNotFoundError,
  CharacterValidationError,
  duplicateAvatarFileName,
  ensureBlobSize,
  ensureImageBlob,
  ensureSupportedImportType,
  MAX_IMPORT_BYTES,
  normalizeAvatarFile,
  normalizeInternalName,
  sanitizeDisplayName,
  sanitizeFileBaseName,
  toAvatarFile,
  uniqueName,
} from './character-validation';

export interface CharacterServiceDiagnostics {
  avatarWorker: 'pending' | 'ready' | 'skipped' | 'error';
  avatarWorkerMessage: string | null;
}

export type DefaultAvatarLoader = () => Promise<Blob>;
export type DeleteOwnerChats = (ownerId: string) => Promise<void>;

export interface StableCharacterIdentity {
  ownerId: string;
  avatarUrl: string;
}

export interface MergeBulkResult {
  updated: string[];
  skipped: string[];
  failed: string[];
}

export interface ExportedCharacterFile {
  data: Blob;
  contentType: string;
  fileName: string;
}

const PNG_MIME = 'image/png';

export class CharacterService {
  readonly diagnostics: CharacterServiceDiagnostics = {
    avatarWorker: 'pending',
    avatarWorkerMessage: null,
  };

  readonly #repository: CharacterRepository;
  readonly #assets: CharacterAssetRepository;
  readonly #codec: CharacterCardCodec;
  readonly #loadDefaultAvatar: DefaultAvatarLoader;
  readonly #avatarWorkerReady: Promise<unknown>;
  readonly #deleteOwnerChats: DeleteOwnerChats | null;

  constructor(
    repository: CharacterRepository,
    assets: CharacterAssetRepository,
    loadDefaultAvatar: DefaultAvatarLoader,
    avatarWorkerReady: Promise<unknown> = Promise.resolve('skipped'),
    codec = new CharacterCardCodec(),
    deleteOwnerChats: DeleteOwnerChats | null = null,
  ) {
    this.#repository = repository;
    this.#assets = assets;
    this.#loadDefaultAvatar = loadDefaultAvatar;
    this.#avatarWorkerReady = avatarWorkerReady
      .then((value) => {
        this.diagnostics.avatarWorker = value === 'skipped' ? 'skipped' : 'ready';
        this.diagnostics.avatarWorkerMessage = null;
        return value;
      })
      .catch((error: unknown) => {
        this.diagnostics.avatarWorker = 'error';
        this.diagnostics.avatarWorkerMessage =
          error instanceof Error ? error.message : String(error);
      });
    this.#codec = codec;
    this.#deleteOwnerChats = deleteOwnerChats;
  }

  async listCharacters(): Promise<LegacyCharacterDto[]> {
    await this.#waitForAvatarWorker();
    const characters = await this.#repository.list();
    return characters.map((character) =>
      toLegacyCharacterDto(character.card, {
        avatarFile: character.avatarFile,
        createdAt: character.createdAt,
        updatedAt: character.updatedAt,
      }),
    );
  }

  async getCharacter(avatarFileInput: unknown): Promise<LegacyCharacterDto> {
    const avatarFile = normalizeAvatarFile(avatarFileInput);
    const character = await this.#requireByAvatar(avatarFile);
    return toLegacyCharacterDto(character.card, {
      avatarFile: character.avatarFile,
      createdAt: character.createdAt,
      updatedAt: character.updatedAt,
    });
  }

  async resolveStableIdentity(avatarFileInput: unknown): Promise<StableCharacterIdentity | null> {
    const avatarFile = normalizeAvatarFile(avatarFileInput);
    const character = await this.#repository.findByAvatar(avatarFile);
    return character ? { ownerId: character.id, avatarUrl: character.avatarFile } : null;
  }

  async getAvatarForStableIdentity(ownerId: string): Promise<string | null> {
    if (!ownerId) return null;
    return (await this.#repository.get(ownerId))?.avatarFile ?? null;
  }

  async createCharacter(input: Record<string, unknown>, avatarBlob?: Blob | null): Promise<string> {
    const now = Date.now();
    const payload = {
      ...input,
      ch_name: sanitizeDisplayName(input.ch_name ?? input.name),
    };
    const card = formatCharacterData(payload, now);
    card.name = sanitizeDisplayName(card.name);
    card.data.name = card.name;

    const existing = await this.#avatarFileSet();
    const requestedInternalName =
      typeof input.file_name === 'string' && input.file_name.trim()
        ? normalizeInternalName(input.file_name)
        : uniqueName(card.name, existing);
    const avatarFile = toAvatarFile(requestedInternalName);
    if (existing.has(avatarFile)) {
      throw new CharacterValidationError(`Character already exists: ${avatarFile}`);
    }

    const image = avatarBlob && avatarBlob.size > 0 ? avatarBlob : await this.#loadDefaultAvatar();
    ensureImageBlob(image);
    const character = this.#newStoredCharacter(avatarFile, card, now);
    await this.#writeAvatarWithCard(avatarFile, image, card, 'create');
    await this.#repository.save(character);
    return avatarFile;
  }

  async renameCharacter(avatarFileInput: unknown, newNameInput: unknown): Promise<string> {
    const oldAvatarFile = normalizeAvatarFile(avatarFileInput);
    const newName = sanitizeFileBaseName(newNameInput);
    const character = await this.#requireByAvatar(oldAvatarFile);
    const existing = await this.#avatarFileSet();
    const newInternalName = uniqueName(newName, existing);
    const newAvatarFile = toAvatarFile(newInternalName);

    const updated = cloneJson(character);
    updated.avatarFile = newAvatarFile;
    updated.updatedAt = new Date().toISOString();
    updated.card.name = newName;
    updated.card.data.name = newName;

    const image =
      (await this.#assets.getAvatar(oldAvatarFile))?.data ?? (await this.#loadDefaultAvatar());
    await this.#writeAvatarWithCard(newAvatarFile, image, updated.card, 'rename');
    await this.#repository.save(updated);
    await this.#assets.deleteAvatar(oldAvatarFile);
    return newAvatarFile;
  }

  async editCharacter(input: Record<string, unknown>, avatarBlob?: Blob | null): Promise<void> {
    const avatarFile = normalizeAvatarFile(input.avatar_url);
    const existing = await this.#requireByAvatar(avatarFile);
    const card = formatCharacterData(
      {
        ...input,
        ch_name: sanitizeDisplayName(input.ch_name ?? existing.card.name),
      },
      Date.now(),
    );
    card.chat = typeof input.chat === 'string' ? input.chat : existing.card.chat;
    if (typeof input.create_date === 'string' && input.create_date)
      card.create_date = input.create_date;

    const image =
      avatarBlob && avatarBlob.size > 0
        ? avatarBlob
        : ((await this.#assets.getAvatar(avatarFile))?.data ?? (await this.#loadDefaultAvatar()));
    ensureImageBlob(image);
    await this.#writeAvatarWithCard(
      avatarFile,
      image,
      card,
      avatarBlob && avatarBlob.size > 0 ? 'edit' : 'metadata',
    );
    await this.#repository.save({
      ...existing,
      card,
      updatedAt: new Date().toISOString(),
    });
  }

  async editAvatar(avatarFileInput: unknown, avatarBlob: Blob | null | undefined): Promise<void> {
    const avatarFile = normalizeAvatarFile(avatarFileInput);
    if (!avatarBlob || avatarBlob.size === 0)
      throw new CharacterValidationError('No file uploaded.');
    ensureImageBlob(avatarBlob);
    const character = await this.#requireByAvatar(avatarFile);
    await this.#writeAvatarWithCard(avatarFile, avatarBlob, character.card, 'edit-avatar');
    await this.#repository.save({ ...character, updatedAt: new Date().toISOString() });
  }

  async editAttribute(input: Record<string, unknown>): Promise<void> {
    const avatarFile = normalizeAvatarFile(input.avatar_url);
    const field = typeof input.field === 'string' ? input.field : '';
    if (!field || field === 'json_data') throw new CharacterValidationError('Invalid field.');
    if (input.ch_name === '' || input.ch_name === undefined || input.ch_name === '.') {
      throw new CharacterValidationError('Invalid name.');
    }

    const character = await this.#requireByAvatar(avatarFile);
    const card = cloneJson(character.card) as CharacterCard;
    if (
      (card as JsonObject)[field] === undefined &&
      (card.data as JsonObject)[field] === undefined
    ) {
      throw new CharacterValidationError('Invalid field.');
    }
    (card as JsonObject)[field] = input.value;
    (card.data as JsonObject)[field] = input.value;
    await this.#saveCardAndRewriteAvatar(character, card, 'edit-attribute');
  }

  async mergeAttributes(input: Record<string, unknown>): Promise<void> {
    const avatarFile = normalizeAvatarFile(input.avatar);
    const character = await this.#requireByAvatar(avatarFile);
    const update = cloneJson(input) as JsonObject;
    unsetPath(update, 'json_data');
    const merged = deepMerge(cloneJson(character.card) as JsonObject, update);
    processUnsetSentinels(merged, update);
    const card = normalizeCharacterCard(merged, { hoistDate: false });
    await this.#saveCardAndRewriteAvatar(character, card, 'merge-attributes');
  }

  async mergeAttributesBulk(input: Record<string, unknown>): Promise<MergeBulkResult> {
    const avatarsValue = input.avatars;
    if (!Array.isArray(avatarsValue))
      throw new CharacterValidationError('avatars must be an array.');
    if (!isPlainObject(input.data))
      throw new CharacterValidationError('No valid update data provided.');
    const allCharacters = await this.#repository.list();
    const targets = avatarsValue.length
      ? avatarsValue.map((avatar) => normalizeAvatarFile(avatar))
      : allCharacters.map((character) => character.avatarFile);
    const updated: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    const filter =
      isPlainObject(input.filter) && typeof input.filter.path === 'string'
        ? input.filter.path
        : null;

    for (const avatar of targets) {
      try {
        const character = await this.#requireByAvatar(avatar);
        if (filter && getPath(character.card, filter) === undefined) {
          skipped.push(avatar);
          continue;
        }
        await this.mergeAttributes({ avatar, ...(input.data as JsonObject) });
        updated.push(avatar);
      } catch {
        failed.push(avatar);
      }
    }

    return { updated, skipped, failed };
  }

  async deleteCharacter(avatarFileInput: unknown, deleteChats = false): Promise<void> {
    const avatarFile = normalizeAvatarFile(avatarFileInput);
    const character = await this.#requireByAvatar(avatarFile);
    if (deleteChats) await this.#deleteOwnerChats?.(character.id);
    await this.#repository.delete(character.id);
    await this.#assets.deleteAvatar(avatarFile);
  }

  async duplicateCharacter(avatarFileInput: unknown): Promise<string> {
    const avatarFile = normalizeAvatarFile(avatarFileInput);
    const character = await this.#requireByAvatar(avatarFile);
    const existing = await this.#avatarFileSet();
    const newAvatarFile = duplicateAvatarFileName(avatarFile, existing);
    const now = new Date().toISOString();
    const duplicate: StoredCharacter = {
      id: crypto.randomUUID(),
      avatarFile: newAvatarFile,
      card: cloneJson(character.card),
      createdAt: now,
      updatedAt: now,
    };
    const image =
      (await this.#assets.getAvatar(avatarFile))?.data ?? (await this.#loadDefaultAvatar());
    await this.#writeAvatarWithCard(newAvatarFile, image, duplicate.card, 'duplicate');
    await this.#repository.save(duplicate);
    return newAvatarFile;
  }

  async importCharacter(
    file: Blob,
    fileTypeInput: unknown,
    preservedNameInput?: unknown,
  ): Promise<string> {
    ensureBlobSize(file, MAX_IMPORT_BYTES, 'Character import');
    const fileType = ensureSupportedImportType(fileTypeInput);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let card: CharacterCard;
    let image: Blob;

    if (fileType === 'png') {
      card = this.#codec.readPngCard(bytes);
      image = file;
    } else {
      card = this.#codec.parseJsonBytes(bytes);
      image = await this.#loadDefaultAvatar();
    }

    const exportable = unsetPrivateFields(cloneJson(card) as JsonObject);
    card = readFromV2(exportable, Date.now());
    card.name = sanitizeFileBaseName(card.data?.name || card.name);
    card.data.name = card.name;
    card.create_date = new Date().toISOString();

    const preservedName =
      typeof preservedNameInput === 'string' && preservedNameInput.trim()
        ? normalizeInternalName(preservedNameInput)
        : null;
    const avatarFile = preservedName
      ? toAvatarFile(preservedName)
      : toAvatarFile(uniqueName(card.name, await this.#avatarFileSet()));
    const existing = await this.#repository.findByAvatar(avatarFile);
    const now = new Date().toISOString();
    const character: StoredCharacter = existing
      ? { ...existing, card, updatedAt: now }
      : { id: crypto.randomUUID(), avatarFile, card, createdAt: now, updatedAt: now };

    await this.#writeAvatarWithCard(avatarFile, image, card, `import:${fileType}`);
    await this.#assets.putRawCard(character.id, file, {
      fileName: avatarFile,
      contentType: file.type || (fileType === 'png' ? PNG_MIME : 'application/json'),
      source: `import:${fileType}`,
      cardJson: serializeCard(card),
    });
    await this.#repository.save(character);
    return normalizeInternalName(avatarFile);
  }

  async exportCharacter(
    avatarFileInput: unknown,
    formatInput: unknown,
  ): Promise<ExportedCharacterFile> {
    const avatarFile = normalizeAvatarFile(avatarFileInput);
    const format = String(formatInput ?? '').toLowerCase();
    const character = await this.#requireByAvatar(avatarFile);
    const exportedCard = unsetPrivateFields(readFromV2(cloneJson(character.card) as JsonObject));

    if (format === 'json') {
      const json = this.#codec.exportJson(exportedCard, true);
      return {
        data: new Blob([json], { type: 'application/json' }),
        contentType: 'application/json; charset=utf-8',
        fileName: avatarFile.replace(/\.png$/i, '.json'),
      };
    }

    if (format === 'png') {
      const image =
        (await this.#assets.getAvatar(avatarFile))?.data ?? (await this.#loadDefaultAvatar());
      const png = await this.#blobWithEmbeddedCard(image, exportedCard);
      return {
        data: png,
        contentType: PNG_MIME,
        fileName: avatarFile,
      };
    }

    throw new CharacterValidationError(`Unsupported export format: ${format}.`);
  }

  async listChats(): Promise<[]> {
    return [];
  }

  async #saveCardAndRewriteAvatar(
    character: StoredCharacter,
    card: CharacterCard,
    source: string,
  ): Promise<void> {
    const image =
      (await this.#assets.getAvatar(character.avatarFile))?.data ??
      (await this.#loadDefaultAvatar());
    await this.#writeAvatarWithCard(character.avatarFile, image, card, source);
    await this.#repository.save({ ...character, card, updatedAt: new Date().toISOString() });
  }

  async #requireByAvatar(avatarFile: string): Promise<StoredCharacter> {
    const character = await this.#repository.findByAvatar(avatarFile);
    if (!character) throw new CharacterNotFoundError(`Character not found: ${avatarFile}`);
    return character;
  }

  #newStoredCharacter(avatarFile: string, card: CharacterCard, nowMs: number): StoredCharacter {
    const now = new Date(nowMs).toISOString();
    return {
      id: crypto.randomUUID(),
      avatarFile,
      card: cloneJson(card),
      createdAt: now,
      updatedAt: now,
    };
  }

  async #avatarFileSet(): Promise<Set<string>> {
    const characters = await this.#repository.list();
    return new Set(characters.map((character) => character.avatarFile));
  }

  async #writeAvatarWithCard(
    avatarFile: string,
    image: Blob,
    card: CharacterCard,
    source: string,
  ): Promise<void> {
    const blob = await this.#blobWithEmbeddedCard(image, card);
    await this.#assets.putAvatar(avatarFile, blob, {
      fileName: avatarFile,
      contentType: blob.type || image.type || PNG_MIME,
      source,
      cardJson: serializeCard(card),
    });
  }

  async #blobWithEmbeddedCard(
    image: Blob,
    card: CharacterCard,
    allowFallback = true,
  ): Promise<Blob> {
    const bytes = await readBlobBytes(image);
    if (!bytes) {
      if (allowFallback) {
        return this.#blobWithEmbeddedCard(await this.#loadDefaultAvatar(), card, false);
      }
      return image;
    }
    if (isPng(bytes)) {
      const written = this.#codec.writePngCard(bytes, card);
      const arrayBuffer = written.buffer.slice(
        written.byteOffset,
        written.byteOffset + written.byteLength,
      ) as ArrayBuffer;
      return new Blob([arrayBuffer], { type: PNG_MIME });
    }
    return image;
  }

  async #waitForAvatarWorker(): Promise<void> {
    await this.#avatarWorkerReady;
  }
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array | null> {
  const withArrayBuffer = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof withArrayBuffer.arrayBuffer === 'function') {
    return new Uint8Array(await withArrayBuffer.arrayBuffer());
  }

  if (typeof FileReader !== 'undefined' && blob instanceof Blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        const result = reader.result;
        resolve(result instanceof ArrayBuffer ? new Uint8Array(result) : null);
      });
      reader.addEventListener('error', () => resolve(null));
      reader.readAsArrayBuffer(blob);
    });
  }

  return null;
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}
