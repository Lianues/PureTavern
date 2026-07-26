import type {
  ArchiveImportPreview,
  ArchiveImportReport,
  ArchiveModuleImportResult,
  ArchiveModulePreview,
  BackupDescriptor,
} from '@pure-tavern/contracts';

import { APP_VERSION } from '@/platform/runtime/app-version';
import type { ModuleRecordStore } from '@/platform/storage/app-storage';

import {
  ArchiveValidationError,
  normalizeStrategy,
  type ArchiveExportOptions,
  type ArchiveImportOptions,
} from '../domain/archive';
import type { ArchiveExporter, ExportedArchive } from '../ports/archive-exporter';
import type { ArchiveImporter } from '../ports/archive-importer';
import type { BackupTransport } from '../ports/backup-transport';
import { decodeArchive, encodeArchive, type DecodedArchive } from './archive-codec';
import {
  ArchiveParticipantRegistry,
  type ScopedArchiveParticipant,
} from './archive-participant-registry';

const JOURNAL_COLLECTION = 'import-journal';
const JOURNAL_ID = 'current';
const DEFAULT_BACKUP_RETENTION = 5;

export interface ArchiveServiceOptions {
  appVersion?: string;
  upstreamVersion?: string;
  clock?: () => Date;
  createId?: () => string;
  backupRetention?: number;
}

export interface DataManagementInspection {
  modules: Awaited<ReturnType<ScopedArchiveParticipant['inspect']>>[];
  backups: BackupDescriptor[];
  quota: { usage: number | null; quota: number | null };
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
  }

  async inspect(): Promise<DataManagementInspection> {
    const [modules, backups, quota] = await Promise.all([
      Promise.all(this.#participants.list().map((participant) => participant.inspect())),
      this.#backups.list(),
      storageEstimate(),
    ]);
    return { modules, backups, quota, backupTransport: this.#backups.capabilities };
  }

  exportArchive(options: ArchiveExportOptions = {}): Promise<ExportedArchive> {
    return this.#enqueue(async () => {
      const selected = this.#selectParticipants(options.moduleIds, Boolean(options.includeSecrets));
      const modules = await Promise.all(selected.map((participant) => participant.inspect()));
      const entries = (
        await Promise.all(selected.map((participant) => participant.exportEntries()))
      ).flat();
      const createdAt = this.#clock().toISOString();
      const { blob, manifest } = await encodeArchive(
        {
          archiveId: this.#createId(),
          createdAt,
          appVersion: this.#appVersion,
          upstreamVersion: this.#upstreamVersion,
          includeSecrets: selected.some((participant) => participant.sensitive),
          modules,
        },
        entries,
      );
      return {
        blob,
        manifest,
        fileName: `pure-tavern-backup-${createdAt.replace(/[:.]/gu, '-')}.zip`,
      };
    });
  }

  async previewArchive(
    archive: Blob,
    options: ArchiveImportOptions = {},
  ): Promise<ArchiveImportPreview> {
    const decoded = await decodeArchive(archive);
    return this.#previewDecoded(decoded, options);
  }

  importArchive(archive: Blob, options: ArchiveImportOptions = {}): Promise<ArchiveImportReport> {
    return this.#enqueue(async () => {
      const decoded = await decodeArchive(archive);
      return this.#importDecoded(decoded, options, 'pre-import');
    });
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
      const decoded = await decodeArchive(archive);
      return this.#importDecoded(decoded, options, 'pre-restore');
    });
  }

  async #exportWithoutQueue(options: ArchiveExportOptions): Promise<ExportedArchive> {
    const selected = this.#selectParticipants(options.moduleIds, Boolean(options.includeSecrets));
    const modules = await Promise.all(selected.map((participant) => participant.inspect()));
    const entries = (
      await Promise.all(selected.map((participant) => participant.exportEntries()))
    ).flat();
    const createdAt = this.#clock().toISOString();
    const { blob, manifest } = await encodeArchive(
      {
        archiveId: this.#createId(),
        createdAt,
        appVersion: this.#appVersion,
        upstreamVersion: this.#upstreamVersion,
        includeSecrets: selected.some((participant) => participant.sensitive),
        modules,
      },
      entries,
    );
    return {
      blob,
      manifest,
      fileName: `pure-tavern-backup-${createdAt.replace(/[:.]/gu, '-')}.zip`,
    };
  }

  async #previewDecoded(
    decoded: DecodedArchive,
    options: ArchiveImportOptions,
  ): Promise<ArchiveImportPreview> {
    const selectedIds = new Set(
      options.moduleIds ?? decoded.manifest.modules.map((item) => item.moduleId),
    );
    const includeSecrets = Boolean(options.includeSecrets);
    const modules: ArchiveModulePreview[] = [];
    const warnings: string[] = [];
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
    const preview = await this.#previewDecoded(decoded, options);
    const selected = preview.modules.filter((module) => module.selected && module.available);
    const selectedIds = selected.map((module) => module.moduleId);
    const includeSecrets = selected.some((module) => module.sensitive);
    const startedAt = this.#clock().toISOString();
    let recoveryBackupId: string | null = null;

    if (options.createRecoveryPoint !== false && selectedIds.length > 0) {
      const recovery = await this.#exportWithoutQueue({ moduleIds: selectedIds, includeSecrets });
      recoveryBackupId = (
        await this.#backups.upload({
          label: `Recovery before ${recoveryReason === 'pre-restore' ? 'restore' : 'import'}`,
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
        results.push(await participant.importEntries(entries, strategy));
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
