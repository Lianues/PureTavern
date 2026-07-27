import type { ExtensionMigrationCapability } from '@/platform/features/standard-capabilities';

import type { PortableArchiveEntry } from '../../application/archive-participant-registry';
import {
  EXTENSION_PACKAGE_PATH_PREFIX,
  TAURI_TAVERN_DIRECTORIES,
  TAURI_TAVERN_EXTENSION_SOURCES_ROOT,
  TAURI_TAVERN_IMAGE_METADATA_FILE,
  TAURI_TAVERN_SECRETS_FILE,
  TAURI_TAVERN_SETTINGS_FILE,
  TAURI_TAVERN_STATS_FILE,
  TAURI_TAVERN_THIRD_PARTY_ROOT,
  deterministicId,
  fileExtension,
  isDerivedPath,
  mimeTypeForFile,
  readDirectory,
  readUserPath,
  withoutExtension,
} from '../domain/data-tree';
import {
  EMPTY_MIGRATION_IDENTITY,
  type MigrationIdentityLookup,
} from '../ports/migration-identity';
import {
  ASSET_LIBRARY_CATEGORIES,
  PRESET_TYPE_BY_DIRECTORY,
  createModuleReport,
  decodeJson,
  isJsonObject,
  textDecoder,
  textEncoder,
  type TauriTavernFile,
  type TauriTavernModuleReport,
} from './tauri-tavern-format';

/** 角色卡 PNG 的解码能力，由 characters 特性通过 capability 提供。 */
export interface CharacterCardReader {
  readCardFromPng(bytes: Uint8Array): Record<string, unknown>;
}

export interface TauriTavernImportState {
  characterIds: Map<string, string>;
  characterNames: Map<string, string>;
  imageMetadata: Map<string, Record<string, unknown>>;
  targets: Set<string>;
}

export function createTauriTavernImportState(): TauriTavernImportState {
  return {
    characterIds: new Map(),
    characterNames: new Map(),
    imageMetadata: new Map(),
    targets: new Set(),
  };
}

export interface TauriTavernImportOptions {
  identity?: MigrationIdentityLookup;
  cardReader?: CharacterCardReader | null;
  /** 由 extensions 特性提供；缺席时第三方扩展会被跳过并给出警告。 */
  extensionMigration?: ExtensionMigrationCapability | null;
  now?: string;
  /** 流式导入跨文件复用的轻量身份/元数据状态；不保存文件正文。 */
  state?: TauriTavernImportState;
}

export interface TauriTavernImportResult {
  entries: PortableArchiveEntry[];
  modules: TauriTavernModuleReport[];
  warnings: string[];
}

/**
 * 把 TauriTavern（= SillyTavern）的 data 目录还原成 PureTavern 的模块记录。
 *
 * 产出的是标准 `PortableArchiveEntry`，因此后续的冲突预览、恢复点、导入日志和
 * merge/skip/replace 策略全部复用既有归档流水线，不需要第二套导入逻辑。
 */
export async function fromTauriTavernFiles(
  files: readonly TauriTavernFile[],
  options: TauriTavernImportOptions = {},
): Promise<TauriTavernImportResult> {
  const context = new ImportContext(options);

  // 角色必须先于聊天和表情处理：后两者的归属 id 要么直接取角色 id，要么按同样的规则推导。
  // 图片元数据也必须先解析，importAssets 要把它挂到对应的资源记录上。
  const routed = routeFiles(files, context);
  importImageMetadata(routed.imageMetadata, context);
  // 扩展也要先于 importAssets：它的包文件是以 library 资源的形式落盘的。
  await importExtensions(routed, context);
  await importCharacters(routed.characters, context);
  await importChats(routed.chats, context);
  await importWorldBooks(routed.worldBooks, context);
  await importPresets(routed.presets, context);
  await importAssets(routed.assets, context);
  importSingletons(routed.singletons, context);

  return { entries: context.entries, modules: context.reports(), warnings: context.warnings };
}

interface RoutedFile extends TauriTavernFile {
  /** `data/default-user/` 之下的相对路径。 */
  relativePath: string;
}

interface AssetCandidate extends RoutedFile {
  collection: string;
  legacyPath: string;
  filename: string;
  folder?: string;
  category?: string;
  ownerAlias?: string;
  /** 扩展包文件的 owner 是 `extension-package:<id>`，不是从角色头像推导出来的。 */
  owner?: string;
  /** 归到哪个模块的报告里；扩展包文件算在 extensions 名下更好理解。 */
  reportAs?: string;
}

interface ExtensionFolder {
  folderName: string;
  files: { path: string; data: Uint8Array }[];
}

interface RoutedFiles {
  characters: RoutedFile[];
  chats: RoutedFile[];
  worldBooks: RoutedFile[];
  presets: { file: RoutedFile; type: string }[];
  assets: AssetCandidate[];
  singletons: RoutedFile[];
  imageMetadata: RoutedFile | null;
  extensions: Map<string, ExtensionFolder>;
  extensionSources: Map<string, { scope: 'local' | 'global'; data: Uint8Array }>;
}

class ImportContext {
  readonly entries: PortableArchiveEntry[] = [];
  readonly warnings: string[] = [];
  readonly identity: MigrationIdentityLookup;
  readonly cardReader: CharacterCardReader | null;
  readonly extensionMigration: ExtensionMigrationCapability | null;
  readonly now: string;
  /** 本次包里角色头像文件名 -> 将要写入的角色 id，供聊天和表情复用。 */
  readonly characterIds: Map<string, string>;
  readonly characterNames: Map<string, string>;
  /** image-metadata.json 里的「相对路径 -> 元数据」，由 importAssets 挂到资源记录上。 */
  readonly imageMetadata: Map<string, Record<string, unknown>>;
  readonly #reports = new Map<string, TauriTavernModuleReport>();
  readonly #targets: Set<string>;

  constructor(options: TauriTavernImportOptions) {
    this.identity = options.identity ?? EMPTY_MIGRATION_IDENTITY;
    this.cardReader = options.cardReader ?? null;
    this.extensionMigration = options.extensionMigration ?? null;
    this.now = options.now ?? new Date().toISOString();
    const state = options.state ?? createTauriTavernImportState();
    this.characterIds = state.characterIds;
    this.characterNames = state.characterNames;
    this.imageMetadata = state.imageMetadata;
    this.#targets = state.targets;
  }

  report(moduleId: string): TauriTavernModuleReport {
    let report = this.#reports.get(moduleId);
    if (!report) {
      report = createModuleReport(moduleId);
      this.#reports.set(moduleId, report);
    }
    return report;
  }

  reports(): TauriTavernModuleReport[] {
    return [...this.#reports.values()].sort((left, right) =>
      left.moduleId.localeCompare(right.moduleId, 'en'),
    );
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  /** 同一次导入里重复写同一条目标记录会让归档流水线的唯一性校验失败，这里提前拦掉。 */
  #claim(moduleId: string, kind: string, collection: string, id: string): boolean {
    const key = [moduleId, kind, collection, id].join('\u001f');
    if (this.#targets.has(key)) return false;
    this.#targets.add(key);
    return true;
  }

  addRecord(moduleId: string, collection: string, id: string, value: unknown): void {
    if (!this.#claim(moduleId, 'record', collection, id)) {
      this.report(moduleId).skipped += 1;
      return;
    }
    const data = textEncoder.encode(JSON.stringify(value));
    this.entries.push({
      descriptor: {
        path: entryPath(moduleId, 'records', collection, id, 'json'),
        moduleId,
        kind: 'record',
        collection,
        id,
        size: data.byteLength,
        sha256: '',
        updatedAt: this.now,
        contentType: 'application/json',
      },
      data,
    });
    this.report(moduleId).records += 1;
  }

  addBlob(
    moduleId: string,
    collection: string,
    id: string,
    data: Uint8Array,
    contentType: string,
    metadata: Record<string, unknown>,
  ): void {
    if (!this.#claim(moduleId, 'blob', collection, id)) {
      this.report(moduleId).skipped += 1;
      return;
    }
    this.entries.push({
      descriptor: {
        path: entryPath(moduleId, 'blobs', collection, id, 'bin'),
        moduleId,
        kind: 'blob',
        collection,
        id,
        size: data.byteLength,
        sha256: '',
        updatedAt: this.now,
        contentType,
        metadata,
      },
      data,
    });
    this.report(moduleId).blobs += 1;
  }
}

function routeFiles(files: readonly TauriTavernFile[], context: ImportContext): RoutedFiles {
  const routed: RoutedFiles = {
    characters: [],
    chats: [],
    worldBooks: [],
    presets: [],
    assets: [],
    singletons: [],
    imageMetadata: null,
    extensions: new Map(),
    extensionSources: new Map(),
  };

  for (const file of files) {
    if (routeExtensionFile(file, routed)) continue;
    const relativePath = readUserPath(file.path);
    if (!relativePath) {
      // TauriTavern 自己的运行时目录（data/_tauritavern、data/_errors …），不属于用户数据。
      skipUnsupported(context, file.path);
      continue;
    }
    // 缩略图、备份和向量库都是可以重新生成的派生数据。丢掉是对的，但必须计数：
    // 一个 864 个文件的包如果报告只加得出 752，用户没法判断剩下的去哪了。
    if (isDerivedPath(relativePath)) {
      const derived = context.report('derived');
      derived.files += 1;
      derived.skipped += 1;
      continue;
    }

    const entry: RoutedFile = { ...file, relativePath };
    if (!routeOne(entry, routed, context)) skipUnsupported(context, relativePath);
  }

  const derived = context.report('derived');
  if (derived.files > 0) {
    derived.notes.push(
      'Thumbnails, automatic backups and vector caches are regenerated on demand and were not imported.',
    );
  }
  const unsupported = context.report('unsupported');
  if (unsupported.skipped > 0) {
    context.warn(
      `${unsupported.skipped} file(s) have no PureTavern equivalent and were skipped, for example: ${unsupported.notes.slice(0, 3).join(', ')}`,
    );
  }
  return routed;
}

/** 扩展相关的两类文件都在 `data/` 下、`default-user/` 之外，先于用户目录路由。 */
function routeExtensionFile(file: TauriTavernFile, routed: RoutedFiles): boolean {
  const packagePath = readPrefix(file.path, TAURI_TAVERN_THIRD_PARTY_ROOT);
  if (packagePath !== null) {
    const separator = packagePath.indexOf('/');
    if (separator <= 0) return false;
    const folderName = packagePath.slice(0, separator);
    const relativePath = packagePath.slice(separator + 1);
    if (!relativePath) return false;
    const folder = routed.extensions.get(folderName) ?? { folderName, files: [] };
    folder.files.push({ path: relativePath, data: file.data });
    routed.extensions.set(folderName, folder);
    return true;
  }

  const sourcePath = readPrefix(file.path, TAURI_TAVERN_EXTENSION_SOURCES_ROOT);
  if (sourcePath !== null) {
    const [scope, name] = sourcePath.split('/');
    if (!name || !name.endsWith('.json')) return false;
    routed.extensionSources.set(withoutExtension(name), {
      scope: scope === 'local' ? 'local' : 'global',
      data: file.data,
    });
    return true;
  }
  return false;
}

function toBlob(data: Uint8Array): Blob {
  const copy = data.slice();
  return new Blob([copy.buffer]);
}

function readPrefix(path: string, prefix: string): string | null {
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : null;
}

function skipUnsupported(context: ImportContext, path: string): void {
  const report = context.report('unsupported');
  report.files += 1;
  report.skipped += 1;
  if (report.notes.length < 12) report.notes.push(path);
}

function routeOne(file: RoutedFile, routed: RoutedFiles, context: ImportContext): boolean {
  const { relativePath } = file;
  const directories = TAURI_TAVERN_DIRECTORIES;

  if (
    relativePath === TAURI_TAVERN_SETTINGS_FILE ||
    relativePath === TAURI_TAVERN_SECRETS_FILE ||
    relativePath === TAURI_TAVERN_STATS_FILE
  ) {
    routed.singletons.push(file);
    return true;
  }

  if (relativePath === TAURI_TAVERN_IMAGE_METADATA_FILE) {
    routed.imageMetadata = file;
    return true;
  }

  const character = readDirectory(relativePath, directories.characters);
  if (character !== null) {
    // characters/ 下一层是角色卡 PNG，再往下一层是该角色的表情图。
    const segments = character.split('/');
    if (segments.length === 1) {
      routed.characters.push(file);
      return true;
    }
    if (segments.length === 2) {
      const [ownerAlias, filename] = segments as [string, string];
      routed.assets.push({
        ...file,
        collection: 'sprites',
        legacyPath: `/${directories.characters}/${ownerAlias}/${filename}`,
        filename,
        folder: ownerAlias,
        ownerAlias,
      });
      return true;
    }
    return false;
  }

  const chat = readDirectory(relativePath, directories.chats);
  if (chat !== null) {
    if (chat.split('/').length !== 2 || fileExtension(chat) !== 'jsonl') return false;
    routed.chats.push(file);
    return true;
  }

  const world = readDirectory(relativePath, directories.worlds);
  if (world !== null) {
    if (world.includes('/') || fileExtension(world) !== 'json') return false;
    routed.worldBooks.push(file);
    return true;
  }

  const presetDirectory = relativePath.slice(0, relativePath.lastIndexOf('/'));
  const presetType = PRESET_TYPE_BY_DIRECTORY[presetDirectory];
  if (presetType) {
    const name = relativePath.slice(presetDirectory.length + 1);
    if (name.includes('/') || fileExtension(name) !== 'json') return false;
    routed.presets.push({ file, type: presetType });
    return true;
  }

  const asset = routeAsset(file, context);
  if (asset) {
    routed.assets.push(asset);
    return true;
  }
  return false;
}

function routeAsset(file: RoutedFile, context: ImportContext): AssetCandidate | null {
  const { relativePath } = file;
  const directories = TAURI_TAVERN_DIRECTORIES;

  for (const [collection, directory] of [
    ['backgrounds', directories.backgrounds],
    ['user-avatars', directories.userAvatars],
    ['attachments', directories.userFiles],
  ] as const) {
    const remainder = readDirectory(relativePath, directory);
    if (remainder === null) continue;
    if (remainder.includes('/')) return null;
    return {
      ...file,
      collection,
      legacyPath: `/${directory}/${remainder}`,
      filename: remainder,
    };
  }

  const image = readDirectory(relativePath, directories.userImages);
  if (image !== null) {
    const segments = image.split('/');
    if (segments.length > 2) return null;
    const filename = segments.at(-1) as string;
    return {
      ...file,
      collection: 'user-images',
      legacyPath: `/${directories.userImages}/${image}`,
      filename,
      ...(segments.length === 2 ? { folder: segments[0] as string } : {}),
    };
  }

  const library = readDirectory(relativePath, directories.assets);
  if (library !== null) {
    const segments = library.split('/');
    if (segments.length !== 2) return null;
    const [category, filename] = segments as [string, string];
    if (!ASSET_LIBRARY_CATEGORIES.includes(category)) {
      context.warn(`Asset category "${category}" is not supported and was skipped.`);
      return null;
    }
    return {
      ...file,
      collection: 'library',
      legacyPath: `/${directories.assets}/${category}/${filename}`,
      filename,
      category,
    };
  }
  return null;
}

async function importCharacters(
  files: readonly RoutedFile[],
  context: ImportContext,
): Promise<void> {
  if (files.length === 0) return;
  const report = context.report('characters');
  report.files = files.length;

  if (!context.cardReader) {
    report.skipped += files.length;
    context.warn(
      'Character import is unavailable because the character card decoder is not installed.',
    );
    return;
  }

  for (const file of files) {
    const avatarFile = file.relativePath.slice(TAURI_TAVERN_DIRECTORIES.characters.length + 1);
    if (fileExtension(avatarFile) !== 'png') {
      report.skipped += 1;
      context.warn(`Character file "${avatarFile}" is not a PNG card and was skipped.`);
      continue;
    }
    let card: Record<string, unknown>;
    try {
      card = context.cardReader.readCardFromPng(file.data);
    } catch (error) {
      report.skipped += 1;
      context.warn(
        `Character "${avatarFile}" does not contain readable card data and was skipped: ${message(error)}`,
      );
      continue;
    }

    const id =
      context.identity.characterIdByAvatar(avatarFile) ??
      (await deterministicId('character', avatarFile));
    const name =
      typeof card.name === 'string' && card.name ? card.name : withoutExtension(avatarFile);
    context.characterIds.set(avatarFile, id);
    context.characterNames.set(avatarFile, name);

    const createdAt =
      typeof card.create_date === 'string' && !Number.isNaN(Date.parse(card.create_date))
        ? new Date(card.create_date).toISOString()
        : context.now;

    context.addRecord('characters', 'cards', id, {
      id,
      avatarFile,
      card,
      createdAt,
      updatedAt: context.now,
    });
    context.addBlob('characters', 'avatars', avatarFile, file.data, 'image/png', {
      fileName: avatarFile,
      contentType: 'image/png',
      size: file.data.byteLength,
      source: 'tauri-tavern-migration',
    });
  }
}

async function importChats(files: readonly RoutedFile[], context: ImportContext): Promise<void> {
  if (files.length === 0) return;
  const report = context.report('chats');
  report.files = files.length;
  const aliases = new Map<string, string>();

  for (const file of files) {
    const relative = file.relativePath.slice(TAURI_TAVERN_DIRECTORIES.chats.length + 1);
    const separator = relative.indexOf('/');
    const directory = relative.slice(0, separator);
    const legacyFileName = relative.slice(separator + 1);
    const avatarFile = `${directory}.png`;

    const document = parseChatJsonl(file.data);
    if (!document) {
      report.skipped += 1;
      context.warn(`Chat "${relative}" is not a readable JSONL transcript and was skipped.`);
      continue;
    }

    const ownerId = await resolveChatOwner(avatarFile, context);
    aliases.set(avatarFile, ownerId);
    const sessionId =
      context.identity.chatSessionId(ownerId, legacyFileName) ??
      (await deterministicId('chat', `${ownerId}/${legacyFileName}`));

    const serialized = [document.header, ...document.messages]
      .map((value) => JSON.stringify(value))
      .join('\n');
    const lastMessage = document.messages.at(-1);
    const sendDate = lastMessage?.send_date;

    context.addRecord('chats', 'sessions', sessionId, {
      id: sessionId,
      ownerId,
      ownerAlias: avatarFile,
      characterName: context.characterNames.get(avatarFile) ?? directory,
      legacyFileName,
      header: document.header,
      chatMetadata: isJsonObject(document.header.chat_metadata)
        ? document.header.chat_metadata
        : {},
      messageCount: document.messages.length,
      byteSize: textEncoder.encode(serialized).byteLength,
      lastMessage: lastMessage
        ? String(lastMessage.mes ?? '[The message is empty]')
        : '[The chat is empty]',
      lastMessageAt:
        typeof sendDate === 'string' || typeof sendDate === 'number' ? sendDate : context.now,
      createdAt: context.now,
      updatedAt: context.now,
    });
    context.addRecord('chats', 'messages', sessionId, document.messages);
  }

  for (const [avatarUrl, ownerId] of aliases) {
    context.addRecord('chats', 'owner-aliases', avatarUrl, {
      ownerId,
      avatarUrl,
      updatedAt: context.now,
    });
  }
}

/**
 * 聊天的 ownerId 必须和角色的稳定 id 对齐，否则同一个角色会出现两套聊天记录。
 * 优先级和运行时的 OwnerIdentityResolver 保持一致：先角色，后别名表。
 */
async function resolveChatOwner(avatarFile: string, context: ImportContext): Promise<string> {
  return (
    context.identity.characterIdByAvatar(avatarFile) ??
    context.characterIds.get(avatarFile) ??
    context.identity.chatOwnerIdByAvatar(avatarFile) ??
    (await deterministicId('chat-owner', avatarFile))
  );
}

async function importWorldBooks(
  files: readonly RoutedFile[],
  context: ImportContext,
): Promise<void> {
  if (files.length === 0) return;
  const report = context.report('world-books');
  report.files = files.length;

  for (const file of files) {
    const filename = file.relativePath.slice(TAURI_TAVERN_DIRECTORIES.worlds.length + 1);
    const legacyFileId = withoutExtension(filename);
    const document = decodeJson(file.data, file.path);
    if (!isJsonObject(document)) {
      report.skipped += 1;
      context.warn(`World book "${filename}" is not a JSON object and was skipped.`);
      continue;
    }
    const id =
      context.identity.worldBookId(legacyFileId) ??
      (await deterministicId('world-book', legacyFileId));
    context.addRecord('world-books', 'books', id, {
      id,
      legacyFileId,
      name:
        typeof document.name === 'string' && document.name.trim()
          ? document.name.trim()
          : legacyFileId,
      document,
      createdAt: context.now,
      updatedAt: context.now,
    });
    context.addRecord('world-books', 'aliases', legacyFileId, { bookId: id });
  }
}

async function importPresets(
  presets: readonly { file: RoutedFile; type: string }[],
  context: ImportContext,
): Promise<void> {
  if (presets.length === 0) return;
  const report = context.report('presets');
  report.files = presets.length;

  for (const { file, type } of presets) {
    const name = withoutExtension(file.relativePath.slice(file.relativePath.lastIndexOf('/') + 1));
    const value = decodeJson(file.data, file.path);
    if (value === null || typeof value !== 'object') {
      report.skipped += 1;
      context.warn(`Preset "${type}/${name}" is not a JSON object or array and was skipped.`);
      continue;
    }
    const id =
      context.identity.presetId(type, name) ?? (await deterministicId('preset', `${type}:${name}`));
    context.addRecord('presets', 'documents', `${type}:${id}`, {
      id,
      type,
      name,
      value,
      metadata: {
        origin: 'user',
        userModified: true,
        createdAt: context.now,
        updatedAt: context.now,
      },
    });
    context.addRecord('presets', 'aliases', `${type}:${name}`, { presetId: id });
  }
}

/**
 * 把迁移包里的第三方扩展装进来。
 *
 * 校验、id 推导和记录结构全部交给 extensions 特性（`buildImportedExtension`），这里只负责
 * 搬字节；产出的记录和正常从远端安装出来的完全一致，所以更新检查照常可用。
 * 来源仓库取自 TauriTavern 的 extension-sources，没有它就退回 manifest 的 homePage。
 */
async function importExtensions(routed: RoutedFiles, context: ImportContext): Promise<void> {
  if (routed.extensions.size === 0 && routed.extensionSources.size === 0) return;
  const report = context.report('extensions');
  for (const folder of routed.extensions.values()) report.files += folder.files.length;
  // 来源记录本身也是包里的文件，同样要计数，否则总数又对不上了。
  report.files += routed.extensionSources.size;

  const builder = context.extensionMigration;
  if (!builder) {
    report.skipped = report.files;
    context.warn(
      'Third-party extensions were not imported because the extension installer is unavailable.',
    );
    return;
  }

  for (const folder of routed.extensions.values()) {
    const source = readExtensionSource(routed, folder, context);
    if (!source) {
      report.skipped += folder.files.length;
      context.warn(
        `Extension "${folder.folderName}" has no recorded source repository and was skipped; reinstall it from the extension panel.`,
      );
      continue;
    }
    try {
      const built = await builder.buildImportedExtension({
        folderName: folder.folderName,
        repositoryUrl: source.repositoryUrl,
        requestedRef: source.reference,
        revision: source.revision,
        scope: source.scope,
        installedAt: context.now,
        files: folder.files.map((file) => ({ path: file.path, data: toBlob(file.data) })),
      });
      context.addRecord('extensions', 'registry-v2', built.extensionId, built.record);

      // 包文件是 assets 模块的 library 资源，交给资源那一路统一处理，
      // 这样 id 推导、path-aliases 和二进制写入都只有一份实现。
      for (const file of built.files) {
        const relativePath = file.path;
        routed.assets.push({
          path: `${TAURI_TAVERN_THIRD_PARTY_ROOT}/${folder.folderName}/${relativePath}`,
          relativePath,
          data: new Uint8Array(await file.data.arrayBuffer()),
          collection: 'library',
          legacyPath: `${EXTENSION_PACKAGE_PATH_PREFIX}${folder.folderName}/${relativePath}`,
          filename: relativePath.split('/').at(-1) ?? relativePath,
          folder: built.legacyName,
          owner: `extension-package:${built.extensionId}`,
          reportAs: 'extensions',
        });
      }
      report.notes.push(
        `${folder.folderName} → ${source.repositoryUrl}${source.reference ? ` @ ${source.reference}` : ''}`,
      );
    } catch (error) {
      report.skipped += folder.files.length;
      context.warn(`Extension "${folder.folderName}" failed validation: ${message(error)}`);
    }
  }
}

interface ResolvedExtensionSource {
  repositoryUrl: string;
  reference: string;
  revision: string;
  scope: 'local' | 'global';
}

function readExtensionSource(
  routed: RoutedFiles,
  folder: ExtensionFolder,
  context: ImportContext,
): ResolvedExtensionSource | null {
  const recorded = routed.extensionSources.get(folder.folderName);
  if (recorded) {
    const value = decodeJson(recorded.data, `${folder.folderName}.json`);
    if (isJsonObject(value) && typeof value.remote_url === 'string' && value.remote_url.trim()) {
      return {
        repositoryUrl: value.remote_url.trim(),
        reference: typeof value.reference === 'string' ? value.reference : '',
        revision: typeof value.installed_commit === 'string' ? value.installed_commit : '',
        scope: recorded.scope,
      };
    }
  }

  // 没有来源记录时退回 manifest 的 homePage：够用来推导身份，也保住更新检查。
  const manifestFile = folder.files.find((file) => file.path === 'manifest.json');
  if (!manifestFile) return null;
  let manifest: unknown;
  try {
    manifest = decodeJson(manifestFile.data, `${folder.folderName}/manifest.json`);
  } catch {
    return null;
  }
  const homePage =
    isJsonObject(manifest) && typeof manifest.homePage === 'string' ? manifest.homePage.trim() : '';
  if (!/^https:\/\//iu.test(homePage)) return null;
  context.warn(
    `Extension "${folder.folderName}" had no source record; its identity was derived from manifest.homePage (${homePage}).`,
  );
  return { repositoryUrl: homePage, reference: '', revision: '', scope: 'global' };
}

/**
 * `image-metadata.json` 是 SillyTavern 的图片索引：虚拟文件夹加每张图的宽高、主色调、
 * 是否动图。PureTavern 用 `background-folders` 记录和 `AssetRecord.imageMetadata` 表达同一件事，
 * 丢掉它会让导入后的背景管理器失去全部分组。
 */
function importImageMetadata(file: RoutedFile | null, context: ImportContext): void {
  if (!file) return;
  const report = context.report('assets');
  report.files += 1;

  const document = decodeJson(file.data, file.path);
  if (!isJsonObject(document)) {
    report.skipped += 1;
    context.warn('image-metadata.json is not a JSON object and was skipped.');
    return;
  }

  const images = isJsonObject(document.images) ? document.images : {};
  for (const [path, metadata] of Object.entries(images)) {
    if (isJsonObject(metadata)) context.imageMetadata.set(path, metadata);
  }

  const folders = Array.isArray(document.folders) ? document.folders : [];
  for (const folder of folders) {
    if (!isJsonObject(folder)) continue;
    const id = typeof folder.id === 'string' ? folder.id.trim() : '';
    const name = typeof folder.name === 'string' ? folder.name.trim() : '';
    // 文件夹 id 会直接变成 IndexedDB 的 key，带分隔符或为空都存不进去。
    if (!id || !name || id.includes(String.fromCharCode(0x1f))) {
      report.skipped += 1;
      continue;
    }
    context.addRecord('assets', 'background-folders', id, {
      id,
      name,
      thumbnailFile: typeof folder.thumbnailFile === 'string' ? folder.thumbnailFile : '',
      createdAt: context.now,
      updatedAt: context.now,
    });
  }
}

async function importAssets(
  candidates: readonly AssetCandidate[],
  context: ImportContext,
): Promise<void> {
  if (candidates.length === 0) return;
  // 扩展包文件已经算在 extensions 名下了，不能在 assets 里再数一遍，否则总数对不上。
  context.report('assets').files += candidates.filter(
    (candidate) => candidate.reportAs === undefined,
  ).length;

  for (const candidate of candidates) {
    const id =
      context.identity.assetId(candidate.legacyPath) ??
      (await deterministicId('asset', candidate.legacyPath));
    const mimeType = mimeTypeForFile(candidate.filename);
    // image-metadata.json 的 key 是不带开头斜杠的相对路径。
    const metadata = context.imageMetadata.get(candidate.legacyPath.slice(1));
    const folderIds = Array.isArray(metadata?.folderIds)
      ? metadata.folderIds.filter((value): value is string => typeof value === 'string')
      : [];
    const spriteName =
      candidate.collection === 'sprites' ? withoutExtension(candidate.filename) : undefined;
    const owner =
      candidate.owner ??
      (candidate.ownerAlias
        ? (context.identity.characterIdByAvatar(`${candidate.ownerAlias}.png`) ??
          context.characterIds.get(`${candidate.ownerAlias}.png`) ??
          `legacy:${candidate.ownerAlias.normalize('NFKC')}`)
        : undefined);

    const declaredTimestamp = Number(metadata?.addedTimestamp);
    const addedTimestamp = Number.isFinite(declaredTimestamp)
      ? declaredTimestamp
      : Date.parse(context.now);
    const createdAt = new Date(addedTimestamp).toISOString();

    context.addRecord('assets', 'index', id, {
      id,
      collection: candidate.collection,
      legacyPath: candidate.legacyPath,
      filename: candidate.filename,
      mimeType,
      size: candidate.data.byteLength,
      ...(owner ? { owner } : {}),
      ...(candidate.folder ? { folder: candidate.folder } : {}),
      ...(candidate.category ? { category: candidate.category } : {}),
      ...(spriteName ? { label: spriteName, spriteName } : {}),
      // folderIds 在 SillyTavern 里嵌在元数据对象内，在 PureTavern 里是资源记录的顶层字段。
      // 背景分组查询读的是顶层那份，所以两边都要写。
      ...(folderIds.length > 0 ? { folderIds } : {}),
      ...(metadata
        ? { imageMetadata: { ...metadata, path: candidate.legacyPath, addedTimestamp } }
        : {}),
      createdAt,
      updatedAt: context.now,
    });
    context.addRecord('assets', 'path-aliases', candidate.legacyPath, { assetId: id });
    context.addBlob('assets', candidate.collection, id, candidate.data, mimeType, {
      filename: candidate.filename,
      mimeType,
      legacyPath: candidate.legacyPath,
    });
  }
}

function importSingletons(files: readonly RoutedFile[], context: ImportContext): void {
  for (const file of files) {
    const value = decodeJson(file.data, file.path);
    if (!isJsonObject(value)) {
      context.report('unsupported').skipped += 1;
      context.warn(`"${file.relativePath}" is not a JSON object and was skipped.`);
      continue;
    }
    if (file.relativePath === TAURI_TAVERN_SETTINGS_FILE) {
      // Persona 的名字、描述和当前选择都在 settings.json 的 power_user 里，
      // 应用启动时会由 personas 模块从这份文档水合，所以这里不需要单独写 persona 记录。
      context.report('settings').files += 1;
      context.addRecord('settings', 'documents', 'current', value);
      continue;
    }
    if (file.relativePath === TAURI_TAVERN_SECRETS_FILE) {
      context.report('secrets').files += 1;
      context.addRecord('secrets', 'store', 'current', { secrets: value });
      continue;
    }
    context.report('stats').files += 1;
    context.addRecord('stats', 'documents', 'current', value);
  }
}

interface ChatDocument {
  header: Record<string, unknown>;
  messages: Record<string, unknown>[];
}

function parseChatJsonl(data: Uint8Array): ChatDocument | null {
  const lines = textDecoder
    .decode(data)
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;

  const values: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      if (!isJsonObject(value)) return null;
      values.push(value);
    } catch {
      return null;
    }
  }
  const [header, ...messages] = values as [Record<string, unknown>, ...Record<string, unknown>[]];
  return { header, messages };
}

function entryPath(
  moduleId: string,
  kind: string,
  collection: string,
  id: string,
  extension: string,
): string {
  const encode = (value: string) => {
    try {
      return encodeURIComponent(value);
    } catch {
      // 单个代理项无法被 encodeURIComponent 处理；用可逆性无关的转义顶替即可，
      // 这个路径只用于归档内部去重，不参与还原。
      return value.replace(/[^\w.-]/gu, '_');
    }
  };
  return `modules/${encode(moduleId)}/${kind}/${encode(collection)}/${encode(id)}.${extension}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
