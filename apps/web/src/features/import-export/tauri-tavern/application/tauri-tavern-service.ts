import type {
  ArchiveImportPreview,
  ArchiveImportReport,
  ArchiveModulePreview,
} from '@pure-tavern/contracts';

import type { ExtensionMigrationCapability } from '@/platform/features/standard-capabilities';
import { APP_VERSION } from '@/platform/runtime/app-version';

import type { PortableArchiveEntry } from '../../application/archive-participant-registry';
import type { ArchiveParticipantRegistry } from '../../application/archive-participant-registry';
import type {
  PortableEntryStreamModule,
  PortableEntryStreamSource,
} from '../../application/archive-service';
import type { StreamingZipOptions } from '../../application/streaming-zip';
import { decodeArchive } from '../../application/archive-codec';
import type { ArchiveService } from '../../application/archive-service';
import type { ArchiveExportOptions, ArchiveImportOptions } from '../../domain/archive';
import {
  TAURI_TAVERN_DIRECTORIES,
  TAURI_TAVERN_EXTENSION_SOURCES_ROOT,
  TAURI_TAVERN_IMAGE_METADATA_FILE,
  TAURI_TAVERN_SECRETS_FILE,
  TAURI_TAVERN_SETTINGS_FILE,
  TAURI_TAVERN_STATS_FILE,
  TAURI_TAVERN_THIRD_PARTY_ROOT,
  deterministicId,
  isDerivedPath,
  readDirectory,
  readUserPath,
} from '../domain/data-tree';
import type { MigrationIdentityLookup } from '../ports/migration-identity';
import {
  indexTauriTavernArchive,
  packTauriTavernArchive,
  readIndexedTauriTavernFile,
  type IndexedTauriTavernArchive,
  type IndexedTauriTavernFile,
} from './tauri-tavern-archive';
import { toTauriTavernFiles } from './tauri-tavern-export';
import {
  PRESET_TYPE_BY_DIRECTORY,
  createModuleReport,
  type TauriTavernFile,
  type TauriTavernModuleReport,
} from './tauri-tavern-format';
import {
  createTauriTavernImportState,
  fromTauriTavernFiles,
  type CharacterCardReader,
} from './tauri-tavern-import';

export interface TauriTavernMigrationSummary {
  files: number;
  modules: TauriTavernModuleReport[];
  warnings: string[];
}

export interface TauriTavernPackage {
  blob: Blob;
  fileName: string;
  migration: TauriTavernMigrationSummary;
}

export interface TauriTavernImportPreview extends ArchiveImportPreview {
  migration: TauriTavernMigrationSummary;
}

export interface TauriTavernImportReport extends ArchiveImportReport {
  migration: TauriTavernMigrationSummary;
}

export interface TauriTavernInspectionModule extends ArchiveModulePreview {
  files: number;
  totalBytes: number;
  inspectionOnly: true;
}

export interface TauriTavernPackageInspection {
  modules: TauriTavernInspectionModule[];
  totalBytes: number;
  migration: TauriTavernMigrationSummary;
}

export interface TauriTavernMigrationOptions {
  clock?: () => Date;
  appVersion?: string;
  upstreamVersion?: string;
}

/**
 * 这些能力由别的特性提供，而它们不保证在本模块之前安装完成，
 * 所以统一做成「用的时候再取」的函数，不能在构造时固化。
 */
export interface TauriTavernDependencies {
  cardReader: () => CharacterCardReader | null;
  extensionMigration: () => ExtensionMigrationCapability | null;
}

/**
 * PureTavern <-> TauriTavern 数据互通。
 *
 * 两个方向都只做「格式转换」：导入时把 data 目录转成标准归档条目再交给 ArchiveService，
 * 因此冲突预览、导入前恢复点、导入日志和全部冲突策略都复用，不存在第二条写入路径。
 */
export class TauriTavernMigrationService {
  readonly #participants: ArchiveParticipantRegistry;
  readonly #archive: ArchiveService;
  readonly #dependencies: TauriTavernDependencies;
  readonly #clock: () => Date;
  readonly #appVersion: string;
  readonly #upstreamVersion: string;

  constructor(
    participants: ArchiveParticipantRegistry,
    archive: ArchiveService,
    dependencies: TauriTavernDependencies,
    options: TauriTavernMigrationOptions = {},
  ) {
    this.#participants = participants;
    this.#archive = archive;
    this.#dependencies = dependencies;
    this.#clock = options.clock ?? (() => new Date());
    this.#appVersion = options.appVersion ?? APP_VERSION;
    this.#upstreamVersion = options.upstreamVersion ?? '1.18.0';
  }

  async exportPackage(options: ArchiveExportOptions = {}): Promise<TauriTavernPackage> {
    const { entries } = await this.#archive.collectEntries(options);
    return this.#pack(entries);
  }

  /** 把已有的本地恢复点另存为 TauriTavern 迁移包，不影响恢复点本身。 */
  async exportBackupPackage(id: string): Promise<TauriTavernPackage | null> {
    const stored = await this.#archive.downloadBackup(id);
    if (!stored) return null;
    const decoded = await decodeArchive(stored);
    return this.#pack(decoded.entries);
  }

  previewPackage(
    archive: Blob,
    options: ArchiveImportOptions = {},
  ): Promise<TauriTavernImportPreview> {
    return this.previewPackageStreaming(archive, options);
  }

  importPackage(
    archive: Blob,
    options: ArchiveImportOptions = {},
  ): Promise<TauriTavernImportReport> {
    return this.importPackageStreaming(archive, options);
  }

  async inspectPackageStreaming(
    archive: Blob,
    stream: StreamingZipOptions = {},
  ): Promise<TauriTavernPackageInspection> {
    return this.#inspectIndex(await indexTauriTavernArchive(archive, stream));
  }

  async previewPackageStreaming(
    archive: Blob,
    options: ArchiveImportOptions = {},
    stream: StreamingZipOptions = {},
  ): Promise<TauriTavernImportPreview> {
    const index = await indexTauriTavernArchive(archive, stream);
    const inspection = this.#inspectIndex(index);
    const selectedIds = options.moduleIds ?? inspection.modules.map((module) => module.moduleId);
    const source = await this.#createStreamingSource(index, selectedIds, stream);
    const preview = await this.#archive.previewEntryStream(source, options);
    return {
      ...preview,
      warnings: [...preview.warnings, ...inspection.migration.warnings],
      migration: inspection.migration,
    };
  }

  async importPackageStreaming(
    archive: Blob,
    options: ArchiveImportOptions = {},
    stream: StreamingZipOptions = {},
  ): Promise<TauriTavernImportReport> {
    const index = await indexTauriTavernArchive(archive, stream);
    const inspection = this.#inspectIndex(index);
    const selectedIds = options.moduleIds ?? inspection.modules.map((module) => module.moduleId);
    const source = await this.#createStreamingSource(index, selectedIds, stream);
    const report = await this.#archive.importEntryStream(source, options);
    return {
      ...report,
      warnings: [...report.warnings, ...inspection.migration.warnings],
      migration: inspection.migration,
    };
  }

  #inspectIndex(index: IndexedTauriTavernArchive): TauriTavernPackageInspection {
    const reports = new Map<string, TauriTavernModuleReport>();
    const moduleStats = new Map<string, { files: number; totalBytes: number }>();
    let totalBytes = 0;
    for (const file of index.files) {
      const classified = classifyTauriTavernPath(file.path);
      const reportId = classified.primaryModule ?? (classified.derived ? 'derived' : 'unsupported');
      const report = reports.get(reportId) ?? createModuleReport(reportId);
      report.files += 1;
      if (classified.derived || !classified.primaryModule) report.skipped += 1;
      if (!classified.primaryModule && report.notes.length < 12) report.notes.push(file.path);
      reports.set(reportId, report);
      if (classified.modules.length === 0) continue;
      totalBytes += file.entry.uncompressedSize;
      for (const moduleId of classified.modules) {
        const stat = moduleStats.get(moduleId) ?? { files: 0, totalBytes: 0 };
        stat.files += 1;
        stat.totalBytes += file.entry.uncompressedSize;
        moduleStats.set(moduleId, stat);
      }
    }
    const warnings: string[] = [];
    const derived = reports.get('derived');
    if (derived?.files) {
      derived.notes.push(
        'Thumbnails, automatic backups and vector caches are regenerated on demand and will not be imported.',
      );
    }
    const unsupported = reports.get('unsupported');
    if (unsupported?.files) {
      warnings.push(
        `${unsupported.files} file(s) have no PureTavern equivalent and will be skipped.`,
      );
    }
    const modules: TauriTavernInspectionModule[] = [...moduleStats.entries()]
      .map(([moduleId, stat]) => {
        const participant = this.#participants.get(moduleId);
        return {
          moduleId,
          displayName: participant?.displayName ?? moduleId,
          dataVersion: participant?.dataVersion ?? 1,
          available: Boolean(participant),
          selected: Boolean(participant),
          sensitive: participant?.sensitive ?? moduleId === 'secrets',
          incomingRecords: 0,
          incomingBlobs: 0,
          conflicts: 0,
          newItems: stat.files,
          warnings: participant ? [] : ['This module is not installed and will be skipped.'],
          files: stat.files,
          totalBytes: stat.totalBytes,
          inspectionOnly: true as const,
        };
      })
      .sort((left, right) => left.moduleId.localeCompare(right.moduleId, 'en'));
    return {
      modules,
      totalBytes,
      migration: {
        files: index.files.length,
        modules: [...reports.values()].sort((left, right) =>
          left.moduleId.localeCompare(right.moduleId, 'en'),
        ),
        warnings,
      },
    };
  }

  async #createStreamingSource(
    index: IndexedTauriTavernArchive,
    requestedModuleIds: readonly string[],
    stream: StreamingZipOptions,
  ): Promise<PortableEntryStreamSource> {
    const inspection = this.#inspectIndex(index);
    const selectedIds = new Set(requestedModuleIds);
    const modules: PortableEntryStreamModule[] = inspection.modules.map((module) => ({
      moduleId: module.moduleId,
      displayName: module.displayName,
      dataVersion: module.dataVersion,
      sensitive: module.sensitive,
    }));
    const createdAt = this.#clock().toISOString();
    return {
      archiveId: `tauri-tavern-${createdAt}`,
      createdAt,
      appVersion: this.#appVersion,
      upstreamVersion: this.#upstreamVersion,
      totalBytes: inspection.totalBytes,
      modules,
      open: () => this.#streamConvertedEntries(index, selectedIds, stream),
    };
  }

  async *#streamConvertedEntries(
    index: IndexedTauriTavernArchive,
    selectedIds: ReadonlySet<string>,
    stream: StreamingZipOptions,
  ): AsyncGenerator<readonly PortableArchiveEntry[]> {
    const identity = await this.#buildIdentity();
    const state = createTauriTavernImportState();
    const importOptions = {
      identity,
      state,
      cardReader: this.#dependencies.cardReader(),
      extensionMigration: this.#dependencies.extensionMigration(),
      now: this.#clock().toISOString(),
    };

    // 表情即使不导入角色模块，也必须得到与角色卡相同的稳定 owner id；这一步只看文件名。
    for (const file of index.files) {
      const relativePath = readUserPath(file.path);
      if (!relativePath) continue;
      const character = readDirectory(relativePath, TAURI_TAVERN_DIRECTORIES.characters);
      if (character === null || character.includes('/')) continue;
      state.characterIds.set(
        character,
        identity.characterIdByAvatar(character) ?? (await deterministicId('character', character)),
      );
    }

    const metadata = index.files.find((file) => {
      const relative = readUserPath(file.path);
      return relative === TAURI_TAVERN_IMAGE_METADATA_FILE;
    });
    if (metadata && selectedIds.has('assets')) {
      const converted = await fromTauriTavernFiles(
        [await readIndexedTauriTavernFile(index, metadata, stream)],
        importOptions,
      );
      const entries = converted.entries.filter((entry) =>
        selectedIds.has(entry.descriptor.moduleId),
      );
      if (entries.length) yield entries;
    }

    if (selectedIds.has('extensions') || selectedIds.has('assets')) {
      const sources = index.files.filter((file) =>
        file.path.startsWith(`${TAURI_TAVERN_EXTENSION_SOURCES_ROOT}/`),
      );
      const sourceFiles: TauriTavernFile[] = [];
      for (const file of sources) {
        sourceFiles.push(await readIndexedTauriTavernFile(index, file, stream));
      }
      const folders = groupExtensionFiles(index.files);
      for (const files of folders.values()) {
        const packageFiles: TauriTavernFile[] = [];
        for (const file of files) {
          packageFiles.push(await readIndexedTauriTavernFile(index, file, stream));
        }
        const converted = await fromTauriTavernFiles(
          [...packageFiles, ...sourceFiles],
          importOptions,
        );
        const entries = converted.entries.filter((entry) =>
          selectedIds.has(entry.descriptor.moduleId),
        );
        if (entries.length) yield entries;
      }
    }

    const regular = index.files
      .filter((file) => {
        if (file === metadata) return false;
        if (file.path.startsWith(`${TAURI_TAVERN_THIRD_PARTY_ROOT}/`)) return false;
        if (file.path.startsWith(`${TAURI_TAVERN_EXTENSION_SOURCES_ROOT}/`)) return false;
        return classifyTauriTavernPath(file.path).modules.some((moduleId) =>
          selectedIds.has(moduleId),
        );
      })
      .sort((left, right) => streamingPriority(left.path) - streamingPriority(right.path));
    for (const file of regular) {
      const converted = await fromTauriTavernFiles(
        [await readIndexedTauriTavernFile(index, file, stream)],
        importOptions,
      );
      const entries = converted.entries.filter((entry) =>
        selectedIds.has(entry.descriptor.moduleId),
      );
      if (entries.length) yield entries;
    }
  }

  #pack(entries: readonly PortableArchiveEntry[]): TauriTavernPackage {
    const converted = toTauriTavernFiles(entries);
    return {
      blob: packTauriTavernArchive(converted.files),
      fileName: migrationFileName(this.#clock()),
      migration: {
        files: converted.files.length,
        modules: converted.modules,
        warnings: converted.warnings,
      },
    };
  }

  /**
   * 同一份数据在本地可能已经存在（用户之前手动导入过某个角色）。
   * 这里把「自然键 -> 已有 id」读出来，让转换结果覆盖既有记录而不是新建一份重复的。
   */
  async #buildIdentity(): Promise<MigrationIdentityLookup> {
    const characters = new Map<string, string>();
    const chatOwners = new Map<string, string>();
    const chatSessions = new Map<string, string>();
    const worldBooks = new Map<string, string>();
    const presets = new Map<string, string>();
    const assets = new Map<string, string>();

    await Promise.all([
      this.#collect('characters', 'cards', (id, value) => {
        if (typeof value.avatarFile === 'string') characters.set(value.avatarFile, id);
      }),
      this.#collect('chats', 'owner-aliases', (id, value) => {
        if (typeof value.ownerId === 'string') chatOwners.set(id, value.ownerId);
      }),
      this.#collect('chats', 'sessions', (id, value) => {
        if (typeof value.ownerId === 'string' && typeof value.legacyFileName === 'string') {
          chatSessions.set(sessionKey(value.ownerId, value.legacyFileName), id);
        }
      }),
      this.#collect('world-books', 'aliases', (id, value) => {
        if (typeof value.bookId === 'string') worldBooks.set(id, value.bookId);
      }),
      this.#collect('presets', 'aliases', (id, value) => {
        if (typeof value.presetId === 'string') presets.set(id, value.presetId);
      }),
      this.#collect('assets', 'path-aliases', (id, value) => {
        if (typeof value.assetId === 'string') assets.set(id, value.assetId);
      }),
    ]);

    return {
      characterIdByAvatar: (avatarFile) => characters.get(avatarFile) ?? null,
      chatOwnerIdByAvatar: (avatarFile) => chatOwners.get(avatarFile) ?? null,
      chatSessionId: (ownerId, legacyFileName) =>
        chatSessions.get(sessionKey(ownerId, legacyFileName)) ?? null,
      worldBookId: (legacyFileId) => worldBooks.get(legacyFileId) ?? null,
      // presets 的别名 key 就是 `${type}:${name}`。
      presetId: (type, name) => presets.get(`${type}:${name}`) ?? null,
      assetId: (legacyPath) => assets.get(legacyPath) ?? null,
    };
  }

  async #collect(
    moduleId: string,
    collection: string,
    visit: (id: string, value: Record<string, unknown>) => void,
  ): Promise<void> {
    const participant = this.#participants.get(moduleId);
    if (!participant) return;
    for (const record of await participant.listRecords<Record<string, unknown>>(collection)) {
      if (record.value && typeof record.value === 'object') visit(record.id, record.value);
    }
  }
}

function sessionKey(ownerId: string, legacyFileName: string): string {
  return `${ownerId}\u001f${legacyFileName}`;
}

/** 沿用 TauriTavern 迁移脚本的命名，用户一眼就知道这个包该拖到哪里。 */
function migrationFileName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
  return `tauritavern-data-${stamp}.zip`;
}

interface ClassifiedTauriTavernPath {
  modules: string[];
  primaryModule: string | null;
  derived: boolean;
}

function classifyTauriTavernPath(path: string): ClassifiedTauriTavernPath {
  if (path.startsWith(`${TAURI_TAVERN_THIRD_PARTY_ROOT}/`)) {
    return { modules: ['extensions', 'assets'], primaryModule: 'extensions', derived: false };
  }
  if (path.startsWith(`${TAURI_TAVERN_EXTENSION_SOURCES_ROOT}/`)) {
    return { modules: ['extensions'], primaryModule: 'extensions', derived: false };
  }
  const relative = readUserPath(path);
  if (!relative) return { modules: [], primaryModule: null, derived: false };
  if (isDerivedPath(relative)) return { modules: [], primaryModule: null, derived: true };
  if (relative === TAURI_TAVERN_SETTINGS_FILE) {
    return { modules: ['settings'], primaryModule: 'settings', derived: false };
  }
  if (relative === TAURI_TAVERN_SECRETS_FILE) {
    return { modules: ['secrets'], primaryModule: 'secrets', derived: false };
  }
  if (relative === TAURI_TAVERN_STATS_FILE) {
    return { modules: ['stats'], primaryModule: 'stats', derived: false };
  }
  if (relative === TAURI_TAVERN_IMAGE_METADATA_FILE) {
    return { modules: ['assets'], primaryModule: 'assets', derived: false };
  }

  const character = readDirectory(relative, TAURI_TAVERN_DIRECTORIES.characters);
  if (character !== null) {
    const moduleId = character.includes('/') ? 'assets' : 'characters';
    return { modules: [moduleId], primaryModule: moduleId, derived: false };
  }
  if (readDirectory(relative, TAURI_TAVERN_DIRECTORIES.chats) !== null) {
    return { modules: ['chats'], primaryModule: 'chats', derived: false };
  }
  if (readDirectory(relative, TAURI_TAVERN_DIRECTORIES.worlds) !== null) {
    return { modules: ['world-books'], primaryModule: 'world-books', derived: false };
  }
  const directory = relative.slice(0, relative.lastIndexOf('/'));
  if (PRESET_TYPE_BY_DIRECTORY[directory]) {
    return { modules: ['presets'], primaryModule: 'presets', derived: false };
  }
  for (const assetDirectory of [
    TAURI_TAVERN_DIRECTORIES.backgrounds,
    TAURI_TAVERN_DIRECTORIES.userAvatars,
    TAURI_TAVERN_DIRECTORIES.userImages,
    TAURI_TAVERN_DIRECTORIES.userFiles,
    TAURI_TAVERN_DIRECTORIES.assets,
  ]) {
    if (readDirectory(relative, assetDirectory) !== null) {
      return { modules: ['assets'], primaryModule: 'assets', derived: false };
    }
  }
  return { modules: [], primaryModule: null, derived: false };
}

function groupExtensionFiles(
  files: readonly IndexedTauriTavernFile[],
): Map<string, IndexedTauriTavernFile[]> {
  const groups = new Map<string, IndexedTauriTavernFile[]>();
  const prefix = `${TAURI_TAVERN_THIRD_PARTY_ROOT}/`;
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const remainder = file.path.slice(prefix.length);
    const separator = remainder.indexOf('/');
    if (separator <= 0) continue;
    const folder = remainder.slice(0, separator);
    const group = groups.get(folder) ?? [];
    group.push(file);
    groups.set(folder, group);
  }
  return groups;
}

function streamingPriority(path: string): number {
  const relative = readUserPath(path);
  if (!relative) return 100;
  if (readDirectory(relative, TAURI_TAVERN_DIRECTORIES.characters) !== null) return 10;
  if (readDirectory(relative, TAURI_TAVERN_DIRECTORIES.chats) !== null) return 20;
  if (readDirectory(relative, TAURI_TAVERN_DIRECTORIES.worlds) !== null) return 30;
  const directory = relative.slice(0, relative.lastIndexOf('/'));
  if (PRESET_TYPE_BY_DIRECTORY[directory]) return 40;
  if (
    relative === TAURI_TAVERN_SETTINGS_FILE ||
    relative === TAURI_TAVERN_SECRETS_FILE ||
    relative === TAURI_TAVERN_STATS_FILE
  ) {
    return 60;
  }
  return 50;
}
