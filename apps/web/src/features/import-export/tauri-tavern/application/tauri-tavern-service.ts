import {
  PURE_TAVERN_ARCHIVE_FORMAT,
  PURE_TAVERN_ARCHIVE_SCHEMA_VERSION,
  type ArchiveImportPreview,
  type ArchiveImportReport,
  type PureTavernArchiveManifest,
  type PureTavernArchiveModule,
} from '@pure-tavern/contracts';

import type { ExtensionMigrationCapability } from '@/platform/features/standard-capabilities';
import { APP_VERSION } from '@/platform/runtime/app-version';

import type { PortableArchiveEntry } from '../../application/archive-participant-registry';
import type { ArchiveParticipantRegistry } from '../../application/archive-participant-registry';
import { decodeArchive, type DecodedArchive } from '../../application/archive-codec';
import type { ArchiveService } from '../../application/archive-service';
import type { ArchiveExportOptions, ArchiveImportOptions } from '../../domain/archive';
import type { MigrationIdentityLookup } from '../ports/migration-identity';
import { packTauriTavernArchive, unpackTauriTavernArchive } from './tauri-tavern-archive';
import { toTauriTavernFiles } from './tauri-tavern-export';
import type { TauriTavernModuleReport } from './tauri-tavern-format';
import {
  fromTauriTavernFiles,
  type CharacterCardReader,
  type TauriTavernImportResult,
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

  async previewPackage(
    archive: Blob,
    options: ArchiveImportOptions = {},
  ): Promise<TauriTavernImportPreview> {
    const { decoded, migration } = await this.#decode(archive);
    const preview = await this.#archive.previewDecodedArchive(decoded, options);
    return { ...preview, warnings: [...preview.warnings, ...migration.warnings], migration };
  }

  async importPackage(
    archive: Blob,
    options: ArchiveImportOptions = {},
  ): Promise<TauriTavernImportReport> {
    const { decoded, migration } = await this.#decode(archive);
    const report = await this.#archive.importDecodedArchive(decoded, options);
    return { ...report, warnings: [...report.warnings, ...migration.warnings], migration };
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

  async #decode(
    archive: Blob,
  ): Promise<{ decoded: DecodedArchive; migration: TauriTavernMigrationSummary }> {
    const files = await unpackTauriTavernArchive(archive);
    const converted = await fromTauriTavernFiles(files, {
      identity: await this.#buildIdentity(),
      cardReader: this.#dependencies.cardReader(),
      extensionMigration: this.#dependencies.extensionMigration(),
      now: this.#clock().toISOString(),
    });
    return {
      decoded: this.#toDecodedArchive(converted),
      migration: {
        files: files.length,
        modules: converted.modules,
        warnings: converted.warnings,
      },
    };
  }

  #toDecodedArchive(converted: TauriTavernImportResult): DecodedArchive {
    const counters = new Map<string, { records: number; blobs: number; bytes: number }>();
    let totalBytes = 0;
    for (const entry of converted.entries) {
      const counter = counters.get(entry.descriptor.moduleId) ?? { records: 0, blobs: 0, bytes: 0 };
      if (entry.descriptor.kind === 'record') counter.records += 1;
      else counter.blobs += 1;
      counter.bytes += entry.data.byteLength;
      totalBytes += entry.data.byteLength;
      counters.set(entry.descriptor.moduleId, counter);
    }

    const modules: PureTavernArchiveModule[] = [...counters.entries()]
      .map(([moduleId, counter]) => {
        const participant = this.#participants.get(moduleId);
        return {
          moduleId,
          displayName: participant?.displayName ?? moduleId,
          dataVersion: participant?.dataVersion ?? 1,
          sensitive: participant?.sensitive ?? false,
          recordCount: counter.records,
          blobCount: counter.blobs,
          totalBytes: counter.bytes,
        };
      })
      .sort((left, right) => left.moduleId.localeCompare(right.moduleId, 'en'));

    const createdAt = this.#clock().toISOString();
    const manifest: PureTavernArchiveManifest = {
      format: PURE_TAVERN_ARCHIVE_FORMAT,
      schemaVersion: PURE_TAVERN_ARCHIVE_SCHEMA_VERSION,
      archiveId: `tauri-tavern-${createdAt}`,
      createdAt,
      appVersion: this.#appVersion,
      upstreamVersion: this.#upstreamVersion,
      includeSecrets: modules.some((module) => module.sensitive),
      modules,
      files: converted.entries.map((entry) => entry.descriptor),
    };
    return { manifest, entries: converted.entries, totalBytes };
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
