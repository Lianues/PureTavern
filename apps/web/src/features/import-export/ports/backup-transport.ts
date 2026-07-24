import type {
  BackupDescriptor,
  BackupTransportCapabilities,
  PureTavernArchiveManifest,
} from '@pure-tavern/contracts';

export interface BackupTransport {
  readonly capabilities: BackupTransportCapabilities;
  list(): Promise<BackupDescriptor[]>;
  upload(input: {
    label: string;
    archive: Blob;
    manifest: PureTavernArchiveManifest;
    reason: BackupDescriptor['reason'];
  }): Promise<BackupDescriptor>;
  download(id: string): Promise<Blob | null>;
  delete(id: string): Promise<void>;
}
