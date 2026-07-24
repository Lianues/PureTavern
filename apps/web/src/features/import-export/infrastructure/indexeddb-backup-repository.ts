import type { BackupDescriptor } from '@pure-tavern/contracts';

import type { ModuleBlobStore, ModuleRecordStore } from '@/platform/storage/app-storage';

import type { BackupRepository, SaveBackupInput } from '../ports/backup-repository';

const BACKUP_RECORDS = 'backups';
const BACKUP_ARCHIVES = 'archives';

export class IndexedDbBackupRepository implements BackupRepository {
  readonly #records: ModuleRecordStore;
  readonly #blobs: ModuleBlobStore;
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(
    records: ModuleRecordStore,
    blobs: ModuleBlobStore,
    clock: () => Date = () => new Date(),
    createId: () => string = () => crypto.randomUUID(),
  ) {
    this.#records = records;
    this.#blobs = blobs;
    this.#clock = clock;
    this.#createId = createId;
  }

  async list(): Promise<BackupDescriptor[]> {
    const records = await this.#records.list<BackupDescriptor>(BACKUP_RECORDS);
    return records
      .map((record) => structuredClone(record.value))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt, 'en'));
  }

  async get(id: string): Promise<{ descriptor: BackupDescriptor; archive: Blob } | null> {
    const [record, blob] = await Promise.all([
      this.#records.get<BackupDescriptor>(BACKUP_RECORDS, id),
      this.#blobs.get(BACKUP_ARCHIVES, id),
    ]);
    if (!record || !blob) return null;
    return { descriptor: structuredClone(record.value), archive: blob.data };
  }

  async save(input: SaveBackupInput): Promise<BackupDescriptor> {
    const id = this.#createId();
    const descriptor: BackupDescriptor = {
      id,
      label: input.label,
      createdAt: this.#clock().toISOString(),
      size: input.archive.size,
      archiveId: input.manifest.archiveId,
      moduleIds: input.manifest.modules.map((module) => module.moduleId),
      includeSecrets: input.manifest.includeSecrets,
      reason: input.reason,
    };
    await this.#blobs.put(BACKUP_ARCHIVES, id, input.archive, {
      archiveId: input.manifest.archiveId,
      schemaVersion: input.manifest.schemaVersion,
    });
    try {
      await this.#records.put(BACKUP_RECORDS, id, descriptor);
    } catch (error) {
      await this.#blobs.delete(BACKUP_ARCHIVES, id).catch(() => undefined);
      throw error;
    }
    return structuredClone(descriptor);
  }

  async delete(id: string): Promise<void> {
    await Promise.all([
      this.#records.delete(BACKUP_RECORDS, id),
      this.#blobs.delete(BACKUP_ARCHIVES, id),
    ]);
  }
}
