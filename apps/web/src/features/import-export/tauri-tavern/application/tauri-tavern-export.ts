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
  userPath,
  withoutExtension,
} from '../domain/data-tree';
import {
  ASSET_DIRECTORIES,
  PRESET_DIRECTORIES,
  createModuleReport,
  encodeJson,
  isJsonObject,
  textDecoder,
  textEncoder,
  type TauriTavernFile,
  type TauriTavernModuleReport,
} from './tauri-tavern-format';

export interface TauriTavernExportResult {
  files: TauriTavernFile[];
  modules: TauriTavernModuleReport[];
  warnings: string[];
}

interface DecodedRecord {
  id: string;
  value: unknown;
}

interface ModuleEntries {
  records: Map<string, DecodedRecord[]>;
  blobs: Map<string, PortableArchiveEntry[]>;
}

type ModuleExporter = (module: ModuleEntries, sink: FileSink) => void;

/**
 * 把 PureTavern 的模块记录转换成 TauriTavern（= SillyTavern）的 data 目录结构。
 *
 * 转换是**语义级**而不是路径级的：PureTavern 的一个角色是「cards 记录 + avatars blob」两条数据，
 * 在 SillyTavern 那边则是一个把卡片 JSON 内嵌在 tEXt 块里的 PNG。所以每个模块都要单独映射。
 */
export function toTauriTavernFiles(
  entries: readonly PortableArchiveEntry[],
): TauriTavernExportResult {
  const sink = new FileSink();

  for (const [moduleId, module] of groupByModule(entries)) {
    const report = sink.begin(moduleId);
    const exporter = EXPORTERS[moduleId];
    if (!exporter) {
      report.skipped += countEntries(module);
      report.notes.push(
        `PureTavern module "${moduleId}" has no TauriTavern equivalent and was left out of the package.`,
      );
      continue;
    }
    exporter(module, sink);
  }

  return { files: sink.files(), modules: sink.reports(), warnings: sink.warnings };
}

class FileSink {
  readonly warnings: string[] = [];
  readonly #files = new Map<string, TauriTavernFile>();
  readonly #reports: TauriTavernModuleReport[] = [];
  #current: TauriTavernModuleReport = createModuleReport('unknown');

  begin(moduleId: string): TauriTavernModuleReport {
    this.#current = createModuleReport(moduleId);
    this.#reports.push(this.#current);
    return this.#current;
  }

  add(path: string, data: Uint8Array): void {
    // 不同模块可能算出同一个路径。先到先得并记一条警告，否则 zip 里会出现两个同名条目，
    // 解包端只能看到其中一个，而用户完全不知道丢了什么。
    const key = path.normalize('NFKC').toLowerCase();
    if (this.#files.has(key)) {
      this.#current.skipped += 1;
      this.warn(`Two data items map to the same migration path; only the first was kept: ${path}`);
      return;
    }
    this.#files.set(key, { path, data });
    this.#current.files += 1;
  }

  note(message: string): void {
    this.#current.notes.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  skip(count = 1): void {
    this.#current.skipped += count;
  }

  files(): TauriTavernFile[] {
    return [...this.#files.values()].sort((left, right) =>
      left.path.localeCompare(right.path, 'en'),
    );
  }

  reports(): TauriTavernModuleReport[] {
    return this.#reports;
  }
}

const EXPORTERS: Readonly<Record<string, ModuleExporter>> = Object.freeze({
  characters: exportCharacters,
  chats: exportChats,
  'world-books': exportWorldBooks,
  presets: exportPresets,
  settings: exportSettings,
  secrets: exportSecrets,
  stats: exportStats,
  assets: exportAssets,
  personas: exportPersonas,
  extensions: exportExtensions,
});

function exportCharacters(module: ModuleEntries, sink: FileSink): void {
  const written = new Set<string>();
  for (const avatar of module.blobs.get('avatars') ?? []) {
    const avatarFile = avatar.descriptor.id;
    written.add(avatarFile);
    sink.add(userPath(TAURI_TAVERN_DIRECTORIES.characters, avatarFile), avatar.data);
  }

  for (const card of module.records.get('cards') ?? []) {
    const value = isJsonObject(card.value) ? card.value : {};
    const avatarFile = typeof value.avatarFile === 'string' ? value.avatarFile : '';
    if (avatarFile && written.has(avatarFile)) continue;
    // 角色卡的 JSON 就存在头像 PNG 的 tEXt 块里，没有图片就没有可写出的文件。
    sink.skip();
    sink.warn(
      `Character "${avatarFile || card.id}" has no stored avatar image and cannot be exported to TauriTavern.`,
    );
  }

  const rawCards = module.blobs.get('raw-cards')?.length ?? 0;
  if (rawCards > 0) {
    sink.skip(rawCards);
    sink.note(
      `${rawCards} cached original card file(s) were omitted; the avatar PNG already carries the card.`,
    );
  }
}

function exportChats(module: ModuleEntries, sink: FileSink): void {
  const messagesById = new Map(
    (module.records.get('messages') ?? []).map((record) => [record.id, record.value]),
  );

  for (const record of module.records.get('sessions') ?? []) {
    const session = isJsonObject(record.value) ? record.value : null;
    const ownerAlias = typeof session?.ownerAlias === 'string' ? session.ownerAlias : '';
    const legacyFileName =
      typeof session?.legacyFileName === 'string' ? session.legacyFileName : '';
    if (!session || !ownerAlias || !legacyFileName) {
      sink.skip();
      sink.warn(`Chat "${record.id}" is missing its character or file name and was skipped.`);
      continue;
    }
    const messages = messagesById.get(record.id);
    const lines = [
      JSON.stringify(session.header ?? {}),
      ...(Array.isArray(messages) ? messages : []).map((message) => JSON.stringify(message)),
    ];
    sink.add(
      userPath(TAURI_TAVERN_DIRECTORIES.chats, withoutExtension(ownerAlias), legacyFileName),
      textEncoder.encode(`${lines.join('\n')}\n`),
    );
  }

  sink.skip(module.records.get('owner-aliases')?.length ?? 0);
}

function exportWorldBooks(module: ModuleEntries, sink: FileSink): void {
  for (const record of module.records.get('books') ?? []) {
    const book = isJsonObject(record.value) ? record.value : null;
    if (!book || typeof book.legacyFileId !== 'string' || !book.legacyFileId) {
      sink.skip();
      continue;
    }
    sink.add(
      userPath(TAURI_TAVERN_DIRECTORIES.worlds, `${book.legacyFileId}.json`),
      encodeJson(book.document ?? { entries: {} }),
    );
  }
  sink.skip(module.records.get('aliases')?.length ?? 0);
}

function exportPresets(module: ModuleEntries, sink: FileSink): void {
  for (const record of module.records.get('documents') ?? []) {
    const preset = isJsonObject(record.value) ? record.value : null;
    if (!preset || typeof preset.type !== 'string' || typeof preset.name !== 'string') {
      sink.skip();
      continue;
    }
    const directory = PRESET_DIRECTORIES[preset.type];
    if (!directory) {
      sink.skip();
      sink.note(`Preset type "${preset.type}" has no TauriTavern directory and was skipped.`);
      continue;
    }
    sink.add(userPath(directory, `${preset.name}.json`), encodeJson(preset.value ?? {}));
  }
  for (const collection of ['aliases', 'seed-state', 'tombstones']) {
    sink.skip(module.records.get(collection)?.length ?? 0);
  }
}

function exportSettings(module: ModuleEntries, sink: FileSink): void {
  const current = findById(module.records.get('documents'), 'current');
  if (current) sink.add(userPath(TAURI_TAVERN_SETTINGS_FILE), encodeJson(current.value));

  const snapshots = module.records.get('snapshots')?.length ?? 0;
  if (snapshots > 0) {
    sink.skip(snapshots);
    sink.note(`${snapshots} settings snapshot(s) were omitted; TauriTavern keeps its own.`);
  }
}

function exportSecrets(module: ModuleEntries, sink: FileSink): void {
  const current = findById(module.records.get('store'), 'current');
  if (!current) return;
  // SillyTavern 的 secrets.json 存的就是 { key: SecretValue[] }，和我们内层的 secrets 字段同构。
  const document = isJsonObject(current.value) ? current.value : {};
  sink.add(userPath(TAURI_TAVERN_SECRETS_FILE), encodeJson(document.secrets ?? {}));
}

function exportStats(module: ModuleEntries, sink: FileSink): void {
  const current = findById(module.records.get('documents'), 'current');
  if (current) sink.add(userPath(TAURI_TAVERN_STATS_FILE), encodeJson(current.value));
}

function exportAssets(module: ModuleEntries, sink: FileSink): void {
  const blobsByKey = new Map<string, PortableArchiveEntry>();
  for (const [collection, entries] of module.blobs) {
    for (const entry of entries) blobsByKey.set(`${collection}\u001f${entry.descriptor.id}`, entry);
  }

  const claimed = new Set<string>();
  for (const record of module.records.get('index') ?? []) {
    const asset = isJsonObject(record.value) ? record.value : null;
    const collection = typeof asset?.collection === 'string' ? asset.collection : '';
    const legacyPath = typeof asset?.legacyPath === 'string' ? asset.legacyPath : '';
    if (!ASSET_DIRECTORIES[collection] || !legacyPath.startsWith('/')) {
      sink.skip();
      continue;
    }
    const key = `${collection}\u001f${record.id}`;
    const blob = blobsByKey.get(key);
    if (!blob) {
      sink.skip();
      sink.warn(`Asset "${legacyPath}" has an index entry but no stored file and was skipped.`);
      continue;
    }
    claimed.add(key);
    // 扩展包也存成 library 资源，但它在包里属于 data/extensions/third-party/，不在 default-user/ 下。
    // 按 legacyPath 直接拼会写出 default-user/scripts/... 这种 SillyTavern 根本不认识的目录。
    const packagePath = readExtensionPackagePath(legacyPath);
    if (packagePath) {
      sink.add(packagePath, blob.data);
      continue;
    }
    // 其余 legacyPath 已经是 SillyTavern 的 URL 形式（/backgrounds/x.png），去掉开头的 / 即可。
    sink.add(userPath(legacyPath.slice(1)), blob.data);
  }

  const orphans = [...blobsByKey.keys()].filter((key) => !claimed.has(key)).length;
  if (orphans > 0) {
    sink.skip(orphans);
    sink.note(`${orphans} unindexed asset file(s) were skipped.`);
  }
  sink.skip(module.records.get('path-aliases')?.length ?? 0);
  exportImageMetadata(module, sink);
}

/**
 * 背景的虚拟文件夹和每张图的宽高/主色调在 SillyTavern 里合成一个 image-metadata.json。
 * 不写这个文件，导入方的背景管理器就会丢掉全部分组，只剩一堆散图。
 */
function exportImageMetadata(module: ModuleEntries, sink: FileSink): void {
  const images: Record<string, unknown> = {};
  for (const record of module.records.get('index') ?? []) {
    const asset = isJsonObject(record.value) ? record.value : null;
    const legacyPath = typeof asset?.legacyPath === 'string' ? asset.legacyPath : '';
    if (!legacyPath.startsWith('/')) continue;
    const metadata = isJsonObject(asset?.imageMetadata) ? asset.imageMetadata : null;
    const folderIds = Array.isArray(asset?.folderIds) ? asset.folderIds : null;
    if (!metadata && !folderIds) continue;
    images[legacyPath.slice(1)] = {
      ...metadata,
      // SillyTavern 从元数据对象里读 folderIds，而我们的权威副本在资源记录顶层。
      folderIds: folderIds ?? metadata?.folderIds ?? [],
    };
  }

  const folders = (module.records.get('background-folders') ?? [])
    .map((record) => (isJsonObject(record.value) ? record.value : null))
    .filter((folder): folder is Record<string, unknown> => folder !== null)
    .map((folder) => ({
      id: folder.id,
      name: folder.name,
      thumbnailFile: typeof folder.thumbnailFile === 'string' ? folder.thumbnailFile : '',
    }));

  if (Object.keys(images).length === 0 && folders.length === 0) return;
  sink.add(userPath(TAURI_TAVERN_IMAGE_METADATA_FILE), encodeJson({ version: 1, images, folders }));
}

/** `/scripts/extensions/third-party/<name>/<path>` -> `data/extensions/third-party/<name>/<path>`。 */
function readExtensionPackagePath(legacyPath: string): string | null {
  if (!legacyPath.startsWith(EXTENSION_PACKAGE_PATH_PREFIX)) return null;
  const relative = legacyPath.slice(EXTENSION_PACKAGE_PATH_PREFIX.length);
  return relative ? `${TAURI_TAVERN_THIRD_PARTY_ROOT}/${relative}` : null;
}

/**
 * 扩展的字节由 assets 模块写出（包文件就是 library 资源），这里只补上来源记录：
 * 没有它，对面导入时算不出同一个扩展 id，更新检查也会断。
 */
function exportExtensions(module: ModuleEntries, sink: FileSink): void {
  for (const record of module.records.get('registry-v2') ?? []) {
    const extension = isJsonObject(record.value) ? record.value : null;
    const source = isJsonObject(extension?.source) ? extension.source : null;
    const folderName = typeof extension?.folderName === 'string' ? extension.folderName : '';
    if (!extension || !folderName) {
      sink.skip();
      continue;
    }
    if (source?.kind !== 'remote' || typeof source.repositoryUrl !== 'string') {
      // 内置扩展跟着应用走，不需要也不应该被迁移包带走。
      sink.skip();
      continue;
    }
    const scope = extension.scope === 'local' ? 'local' : 'global';
    sink.add(
      `${TAURI_TAVERN_EXTENSION_SOURCES_ROOT}/${scope}/${folderName}.json`,
      encodeJson({
        host: hostOf(source.repositoryUrl),
        repo_path: repoPathOf(source.repositoryUrl),
        reference: typeof source.requestedRef === 'string' ? source.requestedRef : '',
        remote_url: source.repositoryUrl,
        installed_commit: typeof source.revision === 'string' ? source.revision : '',
      }),
    );
  }
}

function hostOf(repositoryUrl: string): string {
  try {
    return new URL(repositoryUrl).hostname;
  } catch {
    return '';
  }
}

function repoPathOf(repositoryUrl: string): string {
  try {
    return new URL(repositoryUrl).pathname.replace(/^\/+|\/+$/gu, '');
  } catch {
    return '';
  }
}

function exportPersonas(module: ModuleEntries, sink: FileSink): void {
  sink.skip(countEntries(module));
  // Persona 在 SillyTavern 里没有独立文件：名字和描述在 settings.json 的 power_user 下，
  // 头像在 User Avatars/。两者分别由 settings 和 assets 模块写出，这里再写一份只会冲突。
  sink.note(
    'Persona data travels inside settings.json and User Avatars/; no separate file is written.',
  );
}

function findById(records: readonly DecodedRecord[] | undefined, id: string): DecodedRecord | null {
  return records?.find((record) => record.id === id) ?? null;
}

function groupByModule(entries: readonly PortableArchiveEntry[]): Map<string, ModuleEntries> {
  const grouped = new Map<string, ModuleEntries>();
  for (const entry of entries) {
    const { moduleId, kind, collection, id } = entry.descriptor;
    let module = grouped.get(moduleId);
    if (!module) {
      module = { records: new Map(), blobs: new Map() };
      grouped.set(moduleId, module);
    }
    if (kind === 'record') {
      push(module.records, collection, { id, value: parseRecord(entry.data) });
    } else {
      push(module.blobs, collection, entry);
    }
  }
  return grouped;
}

function push<T>(target: Map<string, T[]>, key: string, value: T): void {
  const bucket = target.get(key);
  if (bucket) bucket.push(value);
  else target.set(key, [value]);
}

function parseRecord(data: Uint8Array): unknown {
  try {
    return JSON.parse(textDecoder.decode(data)) as unknown;
  } catch {
    return null;
  }
}

function countEntries(module: ModuleEntries): number {
  let total = 0;
  for (const records of module.records.values()) total += records.length;
  for (const blobs of module.blobs.values()) total += blobs.length;
  return total;
}
