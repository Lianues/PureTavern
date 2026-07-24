import type { BackupDescriptor, PureTavernArchiveManifest } from '@pure-tavern/contracts';

export interface SaveBackupInput {
  label: string;
  archive: Blob;
  manifest: PureTavernArchiveManifest;
  reason: BackupDescriptor['reason'];
}

export interface BackupRepository {
  list(): Promise<BackupDescriptor[]>;
  get(id: string): Promise<{ descriptor: BackupDescriptor; archive: Blob } | null>;
  save(input: SaveBackupInput): Promise<BackupDescriptor>;
  delete(id: string): Promise<void>;
}
