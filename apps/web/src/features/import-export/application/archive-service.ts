import { sha256 } from 'js-sha256';

import {
  PURE_TAVERN_ARCHIVE_FORMAT,
  PURE_TAVERN_ARCHIVE_SCHEMA_VERSION,
  type ArchiveImportPreview,
  type ArchiveImportReport,
  type ArchiveModuleImportResult,
  type ArchiveModulePreview,
  type BackupDescriptor,
  type PureTavernArchiveManifest,
  type PureTavernArchiveModule,
} from '@pure-tavern/contracts';

import { APP_VERSION } from '@/platform/runtime/app-version';
import type { ModuleRecordStore } from '@/platform/storage/app-storage';
import {
  storagePersistence,
  type StoragePersistence,
  type StoragePersistenceState,
} from '@/platform/storage/storage-persistence';

import {
  ArchiveValidationError,
  normalizeStrategy,
  type ArchiveExportOptions,
  type ArchiveImportOptions,
} from '../domain/archive';
import type { ArchiveExporter, ExportedArchive } from '../ports/archive-exporter';
import type { ArchiveImporter } from '../ports/archive-importer';
import type { BackupTransport } from '../ports/backup-transport';
import type { DecodedArchive } from './archive-codec';
import {
  ArchiveParticipantRegistry,
  type PortableArchiveEntry,
  type ScopedArchiveParticipant,
} from './archive-participant-registry';
import {
  indexStreamingArchive,
  readStreamingArchiveEntry,
  type StreamingArchiveIndex,
} from './streaming-archive-reader';
import { StreamingZipWriter, type StreamingZipOptions } from './streaming-zip';

const JOURNAL_COLLECTION = 'import-journal';
const JOURNAL_ID = 'current';
const DEFAULT_BACKUP_RETENTION = 5;

export interface PortableEntryStreamModule {
  moduleId: string;
  displayName: string;
  dataVersion: number;
  sensitive: boolean;
}

export interface PortableEntryStreamSource {
  archiveId: string;
  createdAt: string;
  appVersion: string;
  upstreamVersion: string;
  totalBytes: number;
  modules: readonly PortableEntryStreamModule[];
  /** 每次调用都必须返回一条全新的流；预览和正式写入各消费一次。 */
  open(): AsyncIterable<readonly PortableArchiveEntry[]>;
}

export interface ArchiveServiceOptions {
  appVersion?: string;
  upstreamVersion?: string;
  clock?: () => Date;
  createId?: () => string;
  backupRetention?: number;
  persistence?: StoragePersistence;
}

export interface DataManagementInspection {
  modules: Awaited<ReturnType<ScopedArchiveParticipant['inspect']>>[];
  backups: BackupDescriptor[];
  quota: { usage: number | null; quota: number | null };
  /** 浏览器是否承诺不回收这个源的数据。best-effort 意味着磁盘紧张时可能被整库清空。 */
  persistence: StoragePersistenceState;
  backupTransport: BackupTransport['capabilities'];
}

export class ArchiveService implements ArchiveExporter, ArchiveImporter {
  readonly #participants: ArchiveParticipantRegistry;
  readonly #backups: BackupTransport;
  readonly #journal: ModuleRecordStore;
  readonly #appVersion: string;
  readonly #upstreamVersion: string;
  readonly #clock: () => Date;
  readonly #createId: () => string;
  readonly #backupRetention: number;
  readonly #persistence: StoragePersistence;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    participants: ArchiveParticipantRegistry,
    backups: BackupTransport,
    journal: ModuleRecordStore,
    options: ArchiveServiceOptions = {},
  ) {
    this.#participants = participants;
    this.#backups = backups;
    this.#journal = journal;
    this.#appVersion = options.appVersion ?? APP_VERSION;
    this.#upstreamVersion = options.upstreamVersion ?? '1.18.0';
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#backupRetention = options.backupRetention ?? DEFAULT_BACKUP_RETENTION;
    this.#persistence = options.persistence ?? storagePersistence;
  }

  async inspect(): Promise<DataManagementInspection> {
    const [modules, backups, quota, persistence] = await Promise.all([
      Promise.all(this.#participants.list().map((participant) => participant.inspect())),
      this.#backups.list(),
      storageEstimate(),
      // 打开面板时再补一次申请：首次启动可能因为站点参与度不足被拒，用户主动来看数据时值得重试。
      this.#persistence.ensure(),
    ]);
    return { modules, backups, quota, persistence, backupTransport: this.#backups.capabilities };
  }

  exportArchive(options: ArchiveExportOptions = {}): Promise<ExportedArchive> {
    return this.#enqueue(() => this.#exportWithoutQueue(options));
  }

  previewArchive(archive: Blob, options: ArchiveImportOptions = {}): Promise<ArchiveImportPreview> {
    return this.previewArchiveStreaming(archive, options);
  }

  /**
   * 大归档专用入口：只把当前条目解压到内存，冲突计数完成后立刻释放。
   * 未选模块只校验 manifest/目录关系，不读取其正文。
   */
  async inspectArchiveStreaming(
    archive: Blob,
    stream: StreamingZipOptions = {},
  ): Promise<ArchiveImportPreview> {
    const index = await indexStreamingArchive(archive, stream);
    const modules: ArchiveModulePreview[] = index.manifest.modules.map((incoming) => {
      const participant = this.#participants.get(incoming.moduleId);
      return {
        moduleId: incoming.moduleId,
        displayName: participant?.displayName ?? incoming.displayName,
        dataVersion: incoming.dataVersion,
        available: Boolean(participant),
        selected: Boolean(participant),
        sensitive: incoming.sensitive,
        incomingRecords: incoming.recordCount,
        incomingBlobs: incoming.blobCount,
        conflicts: 0,
        newItems: incoming.recordCount + incoming.blobCount,
        warnings: participant ? [] : ['This module is not installed and will be skipped.'],
      };
    });
    return {
      manifest: index.manifest,
      modules,
      totalBytes: index.totalBytes,
      warnings: ['Package directory scanned; payload integrity is checked after module selection.'],
    };
  }

  async previewArchiveStreaming(
    archive: Blob,
    options: ArchiveImportOptions = {},
    stream: StreamingZipOptions = {},
  ): Promise<ArchiveImportPreview> {
    const index = await indexStreamingArchive(archive, stream);
    return this.#previewStreaming(index, options, stream);
  }

  /**
   * 收集模块条目但不打包。外部格式（例如 TauriTavern 迁移包）需要的是条目本身，
   * 而不是我们自己的 zip，所以把这一步单独暴露出来。
   */
  collectEntries(
    options: ArchiveExportOptions = {},
  ): Promise<{ modules: PureTavernArchiveModule[]; entries: PortableArchiveEntry[] }> {
    return this.#enqueue(() =>
      this.#collectEntries(
        this.#selectParticipants(options.moduleIds, Boolean(options.includeSecrets)),
      ),
    );
  }

  /**
   * 从外部格式转换出来的条目走这里进入导入流水线，于是冲突预览、恢复点、导入日志和
   * merge/skip/replace 策略全部复用，不需要为每种外部格式再写一遍。
   */
  previewDecodedArchive(
    decoded: DecodedArchive,
    options: ArchiveImportOptions = {},
  ): Promise<ArchiveImportPreview> {
    return this.#previewDecoded(decoded, options);
  }

  importDecodedArchive(
    decoded: DecodedArchive,
    options: ArchiveImportOptions = {},
  ): Promise<ArchiveImportReport> {
    return this.#enqueue(() => this.#importDecoded(decoded, options, 'pre-import'));
  }

  importArchive(archive: Blob, options: ArchiveImportOptions = {}): Promise<ArchiveImportReport> {
    return this.#enqueue(async () => {
      const index = await indexStreamingArchive(archive);
      return this.#importStreaming(index, options, {}, 'pre-import');
    });
  }

  importArchiveStreaming(
    archive: Blob,
    options: ArchiveImportOptions = {},
    stream: StreamingZipOptions = {},
  ): Promise<ArchiveImportReport> {
    return this.#enqueue(async () => {
      const index = await indexStreamingArchive(archive, stream);
      return this.#importStreaming(index, options, stream, 'pre-import');
    });
  }

  previewEntryStream(
    source: PortableEntryStreamSource,
    options: ArchiveImportOptions = {},
  ): Promise<ArchiveImportPreview> {
    return this.#previewEntryStream(source, options);
  }

  importEntryStream(
    source: PortableEntryStreamSource,
    options: ArchiveImportOptions = {},
  ): Promise<ArchiveImportReport> {
    return this.#enqueue(() => this.#importEntryStream(source, options, 'pre-import'));
  }

  createBackup(label: string, options: ArchiveExportOptions = {}): Promise<BackupDescriptor> {
    return this.#enqueue(async () => {
      const exported = await this.#exportWithoutQueue(options);
      const descriptor = await this.#backups.upload({
        label: normalizeLabel(label),
        archive: exported.blob,
        manifest: exported.manifest,
        reason: 'manual',
      });
      await this.#rotateBackups();
      return descriptor;
    });
  }

  listBackups(): Promise<BackupDescriptor[]> {
    return this.#backups.list();
  }

  downloadBackup(id: string): Promise<Blob | null> {
    return this.#backups.download(id);
  }

  deleteBackup(id: string): Promise<void> {
    return this.#backups.delete(id);
  }

  restoreBackup(id: string, options: ArchiveImportOptions = {}): Promise<ArchiveImportReport> {
    return this.#enqueue(async () => {
      const archive = await this.#backups.download(id);
      if (!archive) throw new ArchiveValidationError('backup-not-found', 'Backup was not found.');
      const index = await indexStreamingArchive(archive);
      return this.#importStreaming(index, options, {}, 'pre-restore');
    });
  }

  async #exportWithoutQueue(options: ArchiveExportOptions): Promise<ExportedArchive> {
    const selected = this.#selectParticipants(options.moduleIds, Boolean(options.includeSecrets));
    const createdAt = this.#clock().toISOString();
    const files: PortableArchiveEntry['descriptor'][] = [];
    const modules: PureTavernArchiveModule[] = [];

    // 第一遍只保留 descriptor；每次哈希一个 record/blob，文件正文不会跨条目累积。
    for (const participant of selected) {
      let recordCount = 0;
      let blobCount = 0;
      let totalBytes = 0;
      for await (const entry of participant.streamExportEntries()) {
        const descriptor = {
          ...entry.descriptor,
          size: entry.data instanceof Blob ? entry.data.size : entry.data.byteLength,
          sha256: await hashExportSource(entry.data),
        };
        files.push(descriptor);
        totalBytes += descriptor.size;
        if (descriptor.kind === 'record') recordCount += 1;
        else blobCount += 1;
      }
      modules.push({
        moduleId: participant.moduleId,
        displayName: participant.displayName,
        dataVersion: participant.dataVersion,
        sensitive: participant.sensitive,
        recordCount,
        blobCount,
        totalBytes,
      });
    }
    files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    const manifest: PureTavernArchiveManifest = {
      format: PURE_TAVERN_ARCHIVE_FORMAT,
      schemaVersion: PURE_TAVERN_ARCHIVE_SCHEMA_VERSION,
      archiveId: this.#createId(),
      createdAt,
      appVersion: this.#appVersion,
      upstreamVersion: this.#upstreamVersion,
      includeSecrets: selected.some((participant) => participant.sensitive),
      modules,
      files,
    };

    const writer = new StreamingZipWriter();
    try {
      await writer.add(
        'manifest.json',
        new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
      );
      // 第二遍才写 ZIP；writer 会定期把输出块折叠成 Blob，不在 JS 堆保留完整压缩包。
      const expectedHashes = new Map(files.map((file) => [file.path, file.sha256]));
      for (const participant of selected) {
        for await (const entry of participant.streamExportEntries()) {
          const hash = await hashExportSource(entry.data);
          if (hash !== expectedHashes.get(entry.descriptor.path)) {
            throw new ArchiveValidationError(
              'data-changed-during-export',
              `Module data changed while it was being exported: ${entry.descriptor.path}`,
            );
          }
          await writer.add(entry.descriptor.path, entry.data);
        }
      }
      return {
        blob: await writer.end(),
        manifest,
        fileName: `pure-tavern-backup-${createdAt.replace(/[:.]/gu, '-')}.zip`,
      };
    } catch (error) {
      writer.terminate();
      throw error;
    }
  }

  async #collectEntries(
    selected: readonly ScopedArchiveParticipant[],
  ): Promise<{ modules: PureTavernArchiveModule[]; entries: PortableArchiveEntry[] }> {
    const [modules, entries] = await Promise.all([
      Promise.all(selected.map((participant) => participant.inspect())),
      Promise.all(selected.map((participant) => participant.exportEntries())),
    ]);
    return { modules, entries: entries.flat() };
  }

  async #previewEntryStream(
    source: PortableEntryStreamSource,
    options: ArchiveImportOptions,
  ): Promise<ArchiveImportPreview> {
    const strategy = normalizeStrategy(options.strategy);
    const selectedIds = new Set(options.moduleIds ?? source.modules.map((item) => item.moduleId));
    const includeSecrets = Boolean(options.includeSecrets);
    const files: PortableArchiveEntry['descriptor'][] = [];
    const counters = new Map<
      string,
      { records: number; blobs: number; bytes: number; conflicts: number }
    >();
    for await (const batch of source.open()) {
      for (const module of source.modules) {
        const participant = this.#participants.get(module.moduleId);
        const selected =
          selectedIds.has(module.moduleId) && (!module.sensitive || includeSecrets) && participant;
        if (!selected) continue;
        const entries = batch.filter((entry) => entry.descriptor.moduleId === module.moduleId);
        if (entries.length === 0) continue;
        const preview = await participant.preview(entries, true);
        const counter = counters.get(module.moduleId) ?? {
          records: 0,
          blobs: 0,
          bytes: 0,
          conflicts: 0,
        };
        for (const entry of entries) {
          files.push(entry.descriptor);
          counter.bytes += entry.data.byteLength;
          if (entry.descriptor.kind === 'record') counter.records += 1;
          else counter.blobs += 1;
        }
        counter.conflicts += preview.conflicts;
        counters.set(module.moduleId, counter);
      }
    }

    const manifestModules: PureTavernArchiveModule[] = source.modules.map((module) => {
      const counter = counters.get(module.moduleId) ?? {
        records: 0,
        blobs: 0,
        bytes: 0,
        conflicts: 0,
      };
      return {
        moduleId: module.moduleId,
        displayName: module.displayName,
        dataVersion: module.dataVersion,
        sensitive: module.sensitive,
        recordCount: counter.records,
        blobCount: counter.blobs,
        totalBytes: counter.bytes,
      };
    });
    const manifest: PureTavernArchiveManifest = {
      format: PURE_TAVERN_ARCHIVE_FORMAT,
      schemaVersion: PURE_TAVERN_ARCHIVE_SCHEMA_VERSION,
      archiveId: source.archiveId,
      createdAt: source.createdAt,
      appVersion: source.appVersion,
      upstreamVersion: source.upstreamVersion,
      includeSecrets: manifestModules.some(
        (module) => module.sensitive && selectedIds.has(module.moduleId),
      ),
      modules: manifestModules,
      files,
    };
    const warnings: string[] =
      strategy === 'replace-local'
        ? [
            'Complete local replacement will clear every registered local data module, including Secrets and modules absent from this archive.',
          ]
        : [];
    const modules: ArchiveModulePreview[] = source.modules.map((module) => {
      const participant = this.#participants.get(module.moduleId);
      const selected =
        Boolean(participant) &&
        selectedIds.has(module.moduleId) &&
        (!module.sensitive || includeSecrets);
      const counter = counters.get(module.moduleId) ?? {
        records: 0,
        blobs: 0,
        bytes: 0,
        conflicts: 0,
      };
      if (!participant) warnings.push(`Module is not installed: ${module.moduleId}`);
      return {
        moduleId: module.moduleId,
        displayName: participant?.displayName ?? module.displayName,
        dataVersion: module.dataVersion,
        available: Boolean(participant),
        selected,
        sensitive: module.sensitive,
        incomingRecords: counter.records,
        incomingBlobs: counter.blobs,
        conflicts: counter.conflicts,
        newItems: counter.records + counter.blobs - counter.conflicts,
        warnings: participant ? [] : ['This module is not installed and will be skipped.'],
      };
    });
    return { manifest, modules, totalBytes: source.totalBytes, warnings };
  }

  async #importEntryStream(
    source: PortableEntryStreamSource,
    options: ArchiveImportOptions,
    recoveryReason: BackupDescriptor['reason'],
  ): Promise<ArchiveImportReport> {
    const strategy = normalizeStrategy(options.strategy);
    const replaceLocal = strategy === 'replace-local';
    const preview = await this.#previewEntryStream(source, options);
    const selected = preview.modules.filter((module) => module.selected && module.available);
    const selectedIds = selected.map((module) => module.moduleId);
    if (selectedIds.length === 0) {
      throw new ArchiveValidationError(
        'no-modules-selected',
        'At least one available archive module must be selected for import.',
      );
    }
    const includeSecrets = selected.some((module) => module.sensitive);
    const allParticipantIds = this.#participants.list().map((participant) => participant.moduleId);
    const recoveryModuleIds = replaceLocal ? allParticipantIds : selectedIds;
    const recoveryIncludesSecrets = replaceLocal || includeSecrets;
    const mustCreateRecoveryPoint = replaceLocal || options.createRecoveryPoint !== false;
    const startedAt = this.#clock().toISOString();
    let recoveryBackupId: string | null = null;

    if (mustCreateRecoveryPoint && recoveryModuleIds.length > 0) {
      const recovery = await this.#exportWithoutQueue({
        moduleIds: recoveryModuleIds,
        includeSecrets: recoveryIncludesSecrets,
      });
      recoveryBackupId = (
        await this.#backups.upload({
          label: replaceLocal
            ? 'Recovery before complete local replacement'
            : `Recovery before ${recoveryReason === 'pre-restore' ? 'restore' : 'import'}`,
          archive: recovery.blob,
          manifest: recovery.manifest,
          reason: recoveryReason,
        })
      ).id;
      await this.#rotateBackups();
    }
    await this.#journal.put(JOURNAL_COLLECTION, JOURNAL_ID, {
      archiveId: source.archiveId,
      stage: 'running',
      startedAt,
      strategy,
      recoveryBackupId,
      selectedIds,
      currentModule: null,
    });

    const results = new Map<string, ArchiveModuleImportResult>();
    const cleared = new Set<string>();
    try {
      if (replaceLocal) {
        await Promise.all(
          this.#participants.list().map((participant) => participant.clearAllData()),
        );
      }
      for await (const batch of source.open()) {
        for (const moduleId of selectedIds) {
          const entries = batch.filter((entry) => entry.descriptor.moduleId === moduleId);
          if (entries.length === 0) continue;
          const participant = this.#participants.get(moduleId);
          if (!participant) continue;
          if (!cleared.has(moduleId)) {
            cleared.add(moduleId);
            await this.#journal.put(JOURNAL_COLLECTION, JOURNAL_ID, {
              archiveId: source.archiveId,
              stage: 'running',
              startedAt,
              strategy,
              recoveryBackupId,
              selectedIds,
              currentModule: moduleId,
            });
            if (!replaceLocal && (strategy === 'replace-module' || strategy === 'replace-all')) {
              await participant.clearAllData();
            }
          }
          const participantStrategy =
            replaceLocal || strategy === 'replace-module' || strategy === 'replace-all'
              ? 'merge'
              : strategy;
          const item = await participant.importEntries(entries, participantStrategy);
          const result = results.get(moduleId) ?? {
            moduleId,
            imported: 0,
            overwritten: 0,
            skipped: 0,
            errors: [],
          };
          result.imported += item.imported;
          result.overwritten += item.overwritten;
          result.skipped += item.skipped;
          result.errors.push(...item.errors);
          results.set(moduleId, result);
        }
      }
      const completedAt = this.#clock().toISOString();
      await this.#journal.put(JOURNAL_COLLECTION, JOURNAL_ID, {
        archiveId: source.archiveId,
        stage: 'completed',
        startedAt,
        completedAt,
        strategy,
        recoveryBackupId,
        selectedIds,
        currentModule: null,
      });
      return {
        archiveId: source.archiveId,
        startedAt,
        completedAt,
        strategy,
        recoveryBackupId,
        modules: selectedIds.map(
          (moduleId) =>
            results.get(moduleId) ?? {
              moduleId,
              imported: 0,
              overwritten: 0,
              skipped: 0,
              errors: [],
            },
        ),
        warnings: preview.warnings,
      };
    } catch (error) {
      await this.#journal.put(JOURNAL_COLLECTION, JOURNAL_ID, {
        archiveId: source.archiveId,
        stage: 'failed',
        startedAt,
        failedAt: this.#clock().toISOString(),
        strategy,
        recoveryBackupId,
        selectedIds,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async #previewStreaming(
    index: StreamingArchiveIndex,
    options: ArchiveImportOptions,
    stream: StreamingZipOptions,
  ): Promise<ArchiveImportPreview> {
    const strategy = normalizeStrategy(options.strategy);
    const selectedIds = new Set(
      options.moduleIds ?? index.manifest.modules.map((item) => item.moduleId),
    );
    const includeSecrets = Boolean(options.includeSecrets);
    const modules: ArchiveModulePreview[] = [];
    const warnings: string[] =
      strategy === 'replace-local'
        ? [
            'Complete local replacement will clear every registered local data module, including Secrets and modules absent from this archive.',
          ]
        : [];

    for (const incoming of index.manifest.modules) {
      const participant = this.#participants.get(incoming.moduleId);
      const selected =
        selectedIds.has(incoming.moduleId) && (!incoming.sensitive || includeSecrets);
      const descriptors = index.manifest.files.filter(
        (entry) => entry.moduleId === incoming.moduleId,
      );
      const incomingRecords = descriptors.filter((entry) => entry.kind === 'record').length;
      const incomingBlobs = descriptors.length - incomingRecords;
      if (!participant) {
        modules.push({
          moduleId: incoming.moduleId,
          displayName: incoming.displayName,
          dataVersion: incoming.dataVersion,
          available: false,
          selected: false,
          sensitive: incoming.sensitive,
          incomingRecords,
          incomingBlobs,
          conflicts: 0,
          newItems: descriptors.length,
          warnings: ['This module is not installed and will be skipped.'],
        });
        warnings.push(`Module is not installed: ${incoming.moduleId}`);
        continue;
      }

      let conflicts = 0;
      if (selected) {
        for (const descriptor of descriptors) {
          const entry = await readStreamingArchiveEntry(index, descriptor, stream);
          const item = await participant.preview([entry], true);
          conflicts += item.conflicts;
        }
      }
      const moduleWarnings: string[] = [];
      if (incoming.dataVersion !== participant.dataVersion) {
        moduleWarnings.push(
          `Archive data version ${incoming.dataVersion} differs from installed version ${participant.dataVersion}.`,
        );
      }
      if (incoming.sensitive && !includeSecrets) {
        moduleWarnings.push('Sensitive data is excluded until explicitly confirmed.');
      }
      modules.push({
        moduleId: incoming.moduleId,
        displayName: participant.displayName,
        dataVersion: incoming.dataVersion,
        available: true,
        selected,
        sensitive: incoming.sensitive,
        incomingRecords,
        incomingBlobs,
        conflicts,
        newItems: descriptors.length - conflicts,
        warnings: moduleWarnings,
      });
    }
    return { manifest: index.manifest, modules, totalBytes: index.totalBytes, warnings };
  }

  async #importStreaming(
    index: StreamingArchiveIndex,
    options: ArchiveImportOptions,
    stream: StreamingZipOptions,
    recoveryReason: BackupDescriptor['reason'],
  ): Promise<ArchiveImportReport> {
    const strategy = normalizeStrategy(options.strategy);
    const replaceLocal = strategy === 'replace-local';
    const preview = await this.#previewStreaming(index, options, stream);
    const selected = preview.modules.filter((module) => module.selected && module.available);
    const selectedIds = selected.map((module) => module.moduleId);
    if (selectedIds.length === 0) {
      throw new ArchiveValidationError(
        'no-modules-selected',
        'At least one available archive module must be selected for import.',
      );
    }

    const includeSecrets = selected.some((module) => module.sensitive);
    const allParticipantIds = this.#participants.list().map((participant) => participant.moduleId);
    const recoveryModuleIds = replaceLocal ? allParticipantIds : selectedIds;
    const recoveryIncludesSecrets = replaceLocal || includeSecrets;
    const mustCreateRecoveryPoint = replaceLocal || options.createRecoveryPoint !== false;
    const startedAt = this.#clock().toISOString();
    let recoveryBackupId: string | null = null;

    if (mustCreateRecoveryPoint && recoveryModuleIds.length > 0) {
      const recovery = await this.#exportWithoutQueue({
        moduleIds: recoveryModuleIds,
        includeSecrets: recoveryIncludesSecrets,
      });
      recoveryBackupId = (
        await this.#backups.upload({
          label: replaceLocal
            ? 'Recovery before complete local replacement'
            : `Recovery before ${recoveryReason === 'pre-restore' ? 'restore' : 'import'}`,
          archive: recovery.blob,
          manifest: recovery.manifest,
          reason: recoveryReason,
        })
      ).id;
      await this.#rotateBackups();
    }

    await this.#journal.put(JOURNAL_COLLECTION, JOURNAL_ID, {
      archiveId: index.manifest.archiveId,
      stage: 'running',
      startedAt,
      strategy,
      recoveryBackupId,
      selectedIds,
      currentModule: null,
    });

    const results: ArchiveModuleImportResult[] = [];
    try {
      if (replaceLocal) {
        await Promise.all(
          this.#participants.list().map((participant) => participant.clearAllData()),
        );
      }
      for (const moduleId of selectedIds) {
        await this.#journal.put(JOURNAL_COLLECTION, JOURNAL_ID, {
          archiveId: index.manifest.archiveId,
          stage: 'running',
          startedAt,
          strategy,
          recoveryBackupId,
          selectedIds,
          currentModule: moduleId,
        });
        const participant = this.#participants.get(moduleId);
        if (!participant) continue;
        if (!replaceLocal && (strategy === 'replace-module' || strategy === 'replace-all')) {
          await participant.clearAllData();
        }
        const participantStrategy =
          replaceLocal || strategy === 'replace-module' || strategy === 'replace-all'
            ? 'merge'
            : strategy;
        const result: ArchiveModuleImportResult = {
          moduleId,
          imported: 0,
          overwritten: 0,
          skipped: 0,
          errors: [],
        };
        for (const descriptor of index.manifest.files) {
          if (descriptor.moduleId !== moduleId) continue;
          const entry = await readStreamingArchiveEntry(index, descriptor, stream);
          const item = await participant.importEntries([entry], participantStrategy);
          result.imported += item.imported;
          result.overwritten += item.overwritten;
          result.skipped += item.skipped;
          result.errors.push(...item.errors);
        }
        results.push(result);
      }
      const completedAt = this.#clock().toISOString();
      await this.#journal.put(JOURNAL_COLLECTION, JOURNAL_ID, {
        archiveId: index.manifest.archiveId,
        stage: 'completed',
        startedAt,
        completedAt,
        strategy,
        recoveryBackupId,
        selectedIds,
        currentModule: null,
      });
      return {
        archiveId: index.manifest.archiveId,
        startedAt,
        completedAt,
        strategy,
        recoveryBackupId,
        modules: results,
        warnings: preview.warnings,
      };
    } catch (error) {
      await this.#journal.put(JOURNAL_COLLECTION, JOURNAL_ID, {
        archiveId: index.manifest.archiveId,
        stage: 'failed',
        startedAt,
        failedAt: this.#clock().toISOString(),
        strategy,
        recoveryBackupId,
        selectedIds,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async #previewDecoded(
    decoded: DecodedArchive,
    options: ArchiveImportOptions,
  ): Promise<ArchiveImportPreview> {
    const strategy = normalizeStrategy(options.strategy);
    const selectedIds = new Set(
      options.moduleIds ?? decoded.manifest.modules.map((item) => item.moduleId),
    );
    const includeSecrets = Boolean(options.includeSecrets);
    const modules: ArchiveModulePreview[] = [];
    const warnings: string[] =
      strategy === 'replace-local'
        ? [
            'Complete local replacement will clear every registered local data module, including Secrets and modules absent from this archive.',
          ]
        : [];
    for (const incoming of decoded.manifest.modules) {
      const participant = this.#participants.get(incoming.moduleId);
      const selected =
        selectedIds.has(incoming.moduleId) && (!incoming.sensitive || includeSecrets);
      const entries = decoded.entries.filter(
        (entry) => entry.descriptor.moduleId === incoming.moduleId,
      );
      if (!participant) {
        modules.push({
          moduleId: incoming.moduleId,
          displayName: incoming.displayName,
          dataVersion: incoming.dataVersion,
          available: false,
          selected: false,
          sensitive: incoming.sensitive,
          incomingRecords: entries.filter((entry) => entry.descriptor.kind === 'record').length,
          incomingBlobs: entries.filter((entry) => entry.descriptor.kind === 'blob').length,
          conflicts: 0,
          newItems: entries.length,
          warnings: ['This module is not installed and will be skipped.'],
        });
        warnings.push(`Module is not installed: ${incoming.moduleId}`);
        continue;
      }
      const preview = await participant.preview(entries, selected);
      preview.dataVersion = incoming.dataVersion;
      if (incoming.dataVersion !== participant.dataVersion) {
        preview.warnings.push(
          `Archive data version ${incoming.dataVersion} differs from installed version ${participant.dataVersion}.`,
        );
      }
      if (incoming.sensitive && !includeSecrets) {
        preview.warnings.push('Sensitive data is excluded until explicitly confirmed.');
      }
      modules.push(preview);
    }
    return { manifest: decoded.manifest, modules, totalBytes: decoded.totalBytes, warnings };
  }

  async #importDecoded(
    decoded: DecodedArchive,
    options: ArchiveImportOptions,
    recoveryReason: BackupDescriptor['reason'],
  ): Promise<ArchiveImportReport> {
    const strategy = normalizeStrategy(options.strategy);
    const replaceLocal = strategy === 'replace-local';
    const preview = await this.#previewDecoded(decoded, options);
    const selected = preview.modules.filter((module) => module.selected && module.available);
    const selectedIds = selected.map((module) => module.moduleId);
    if (selectedIds.length === 0) {
      throw new ArchiveValidationError(
        'no-modules-selected',
        'At least one available archive module must be selected for import.',
      );
    }
    const includeSecrets = selected.some((module) => module.sensitive);
    const allParticipantIds = this.#participants.list().map((participant) => participant.moduleId);
    const recoveryModuleIds = replaceLocal ? allParticipantIds : selectedIds;
    const recoveryIncludesSecrets = replaceLocal || includeSecrets;
    const mustCreateRecoveryPoint = replaceLocal || options.createRecoveryPoint !== false;
    const startedAt = this.#clock().toISOString();
    let recoveryBackupId: string | null = null;

    if (mustCreateRecoveryPoint && recoveryModuleIds.length > 0) {
      const recovery = await this.#exportWithoutQueue({
        moduleIds: recoveryModuleIds,
        includeSecrets: recoveryIncludesSecrets,
      });
      recoveryBackupId = (
        await this.#backups.upload({
          label: replaceLocal
            ? 'Recovery before complete local replacement'
            : `Recovery before ${recoveryReason === 'pre-restore' ? 'restore' : 'import'}`,
          archive: recovery.blob,
          manifest: recovery.manifest,
          reason: recoveryReason,
        })
      ).id;
      await this.#rotateBackups();
    }

    await this.#journal.put(JOURNAL_COLLECTION, JOURNAL_ID, {
      archiveId: decoded.manifest.archiveId,
      stage: 'running',
      startedAt,
      strategy,
      recoveryBackupId,
      selectedIds,
      currentModule: null,
    });

    const results: ArchiveModuleImportResult[] = [];
    try {
      if (replaceLocal) {
        await Promise.all(
          this.#participants.list().map((participant) => participant.clearAllData()),
        );
      }
      const participantStrategy = replaceLocal ? 'merge' : strategy;
      for (const moduleId of selectedIds) {
        await this.#journal.put(JOURNAL_COLLECTION, JOURNAL_ID, {
          archiveId: decoded.manifest.archiveId,
          stage: 'running',
          startedAt,
          strategy,
          recoveryBackupId,
          selectedIds,
          currentModule: moduleId,
        });
        const participant = this.#participants.get(moduleId);
        if (!participant) continue;
        const entries = decoded.entries.filter((entry) => entry.descriptor.moduleId === moduleId);
        results.push(await participant.importEntries(entries, participantStrategy));
      }
      const completedAt = this.#clock().toISOString();
      await this.#journal.put(JOURNAL_COLLECTION, JOURNAL_ID, {
        archiveId: decoded.manifest.archiveId,
        stage: 'completed',
        startedAt,
        completedAt,
        strategy,
        recoveryBackupId,
        selectedIds,
        currentModule: null,
      });
      return {
        archiveId: decoded.manifest.archiveId,
        startedAt,
        completedAt,
        strategy,
        recoveryBackupId,
        modules: results,
        warnings: preview.warnings,
      };
    } catch (error) {
      await this.#journal.put(JOURNAL_COLLECTION, JOURNAL_ID, {
        archiveId: decoded.manifest.archiveId,
        stage: 'failed',
        startedAt,
        failedAt: this.#clock().toISOString(),
        strategy,
        recoveryBackupId,
        selectedIds,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  #selectParticipants(
    requested: readonly string[] | undefined,
    includeSecrets: boolean,
  ): ScopedArchiveParticipant[] {
    const all = this.#participants.list();
    if (!requested) {
      return all.filter(
        (participant) =>
          (participant.defaultSelected || (participant.sensitive && includeSecrets)) &&
          (!participant.sensitive || includeSecrets),
      );
    }
    const requestedIds = [...new Set(requested)];
    const selected = requestedIds.map((moduleId) => {
      const participant = this.#participants.get(moduleId);
      if (!participant) {
        throw new ArchiveValidationError('unknown-module', `Unknown archive module: ${moduleId}`);
      }
      return participant;
    });
    return selected.filter((participant) => !participant.sensitive || includeSecrets);
  }

  async #rotateBackups(): Promise<void> {
    const backups = await this.#backups.list();
    for (const backup of backups.slice(this.#backupRetention)) {
      await this.#backups.delete(backup.id);
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

async function hashExportSource(source: Uint8Array | Blob): Promise<string> {
  // Uint8Array may come from another realm (legacy iframe/jsdom), so Blob is the reliable branch.
  if (!(source instanceof Blob)) return sha256(source);
  const hasher = sha256.create();
  const chunkSize = 256 * 1024;
  for (let offset = 0; offset < source.size; offset += chunkSize) {
    const chunk = new Uint8Array(
      await source.slice(offset, Math.min(source.size, offset + chunkSize)).arrayBuffer(),
    );
    hasher.update(chunk);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return hasher.hex();
}

function normalizeLabel(value: string): string {
  const label = value.trim().slice(0, 120);
  return label || 'Manual backup';
}

async function storageEstimate(): Promise<{ usage: number | null; quota: number | null }> {
  try {
    const estimate = await navigator.storage?.estimate();
    return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null };
  } catch {
    return { usage: null, quota: null };
  }
}
