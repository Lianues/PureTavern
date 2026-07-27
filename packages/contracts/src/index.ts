export type ModuleStatus =
  | 'inventory'
  | 'designed'
  | 'legacy-hosted'
  | 'migrating'
  | 'browser-ready'
  | 'backend-optional'
  | 'completed'
  | 'removed'
  | 'deferred';

export interface ModuleStateContract {
  moduleId: string;
  status: ModuleStatus;
  updatedAt: string;
  details?: string;
}

export const PURE_TAVERN_ARCHIVE_FORMAT = 'pure-tavern-archive' as const;
export const PURE_TAVERN_ARCHIVE_SCHEMA_VERSION = 1 as const;

export type ArchiveEntryKind = 'record' | 'blob';

export interface PureTavernArchiveFile {
  path: string;
  moduleId: string;
  kind: ArchiveEntryKind;
  collection: string;
  id: string;
  size: number;
  sha256: string;
  updatedAt: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
}

export interface PureTavernArchiveModule {
  moduleId: string;
  displayName: string;
  dataVersion: number;
  sensitive: boolean;
  recordCount: number;
  blobCount: number;
  totalBytes: number;
}

export interface PureTavernArchiveManifest {
  format: typeof PURE_TAVERN_ARCHIVE_FORMAT;
  schemaVersion: typeof PURE_TAVERN_ARCHIVE_SCHEMA_VERSION;
  archiveId: string;
  createdAt: string;
  appVersion: string;
  upstreamVersion: string;
  includeSecrets: boolean;
  modules: PureTavernArchiveModule[];
  files: PureTavernArchiveFile[];
}

export type ArchiveConflictStrategy =
  'merge' | 'skip' | 'replace-module' | 'replace-all' | 'replace-local';

export interface ArchiveModulePreview {
  moduleId: string;
  displayName: string;
  dataVersion: number;
  available: boolean;
  selected: boolean;
  sensitive: boolean;
  incomingRecords: number;
  incomingBlobs: number;
  conflicts: number;
  newItems: number;
  warnings: string[];
}

export interface ArchiveImportPreview {
  manifest: PureTavernArchiveManifest;
  modules: ArchiveModulePreview[];
  totalBytes: number;
  warnings: string[];
}

export interface ArchiveModuleImportResult {
  moduleId: string;
  imported: number;
  overwritten: number;
  skipped: number;
  errors: string[];
}

export interface ArchiveImportReport {
  archiveId: string;
  startedAt: string;
  completedAt: string;
  strategy: ArchiveConflictStrategy;
  recoveryBackupId: string | null;
  modules: ArchiveModuleImportResult[];
  warnings: string[];
}

export interface BackupDescriptor {
  id: string;
  label: string;
  createdAt: string;
  size: number;
  archiveId: string;
  moduleIds: string[];
  includeSecrets: boolean;
  reason: 'manual' | 'pre-import' | 'pre-restore';
}

export interface BackupTransportCapabilities {
  providerId: string;
  kind: 'browser-local' | 'remote';
  list: boolean;
  upload: boolean;
  download: boolean;
  delete: boolean;
  opaqueArchiveStorage: true;
  supportsIncrementalManifestNegotiation: boolean;
}
