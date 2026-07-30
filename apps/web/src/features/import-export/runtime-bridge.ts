import type { ArchiveImportPreview, ArchiveImportReport } from '@pure-tavern/contracts';

import type { ArchiveService } from './application/archive-service';
import type { ArchiveImportOptions } from './domain/archive';
import type { StreamingZipOptions, ZipProgress } from './application/streaming-zip';
import type {
  TauriTavernImportPreview,
  TauriTavernImportReport,
  TauriTavernMigrationService,
  TauriTavernPackageInspection,
} from './tauri-tavern/application/tauri-tavern-service';

export type DataManagementImportMethod = 'fast' | 'slow';

export interface DataManagementStreamingOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ZipProgress) => void;
}

export interface DataManagementImportExecutionOptions extends DataManagementStreamingOptions {
  method?: DataManagementImportMethod;
}

export interface DataManagementRuntimeBridge {
  inspectArchive(
    archive: Blob,
    stream?: DataManagementStreamingOptions,
  ): Promise<ArchiveImportPreview>;
  previewArchive(
    archive: Blob,
    options: ArchiveImportOptions,
    execution?: DataManagementImportExecutionOptions,
  ): Promise<ArchiveImportPreview>;
  importArchive(
    archive: Blob,
    options: ArchiveImportOptions,
    execution?: DataManagementImportExecutionOptions,
  ): Promise<ArchiveImportReport>;
  inspectTauriTavern(
    archive: Blob,
    stream?: DataManagementStreamingOptions,
  ): Promise<TauriTavernPackageInspection>;
  previewTauriTavern(
    archive: Blob,
    options: ArchiveImportOptions,
    execution?: DataManagementImportExecutionOptions,
  ): Promise<TauriTavernImportPreview>;
  importTauriTavern(
    archive: Blob,
    options: ArchiveImportOptions,
    execution?: DataManagementImportExecutionOptions,
  ): Promise<TauriTavernImportReport>;
}

declare global {
  // The data-management UI is a legacy extension script. This bridge keeps large File objects in
  // the same realm instead of serializing them through FormData + Request.formData().
  var __PURE_TAVERN_DATA_STREAMING__: DataManagementRuntimeBridge | undefined;
}

export function installDataManagementRuntimeBridge(
  archive: ArchiveService,
  tauriTavern: TauriTavernMigrationService,
): DataManagementRuntimeBridge {
  const bridge: DataManagementRuntimeBridge = {
    inspectArchive: (blob, stream) => archive.inspectArchiveStreaming(blob, toZipOptions(stream)),
    previewArchive: (blob, options, execution) =>
      execution?.method === 'fast'
        ? archive.previewArchive(blob, options)
        : archive.previewArchiveStreaming(blob, options, toZipOptions(execution)),
    importArchive: (blob, options, execution) =>
      execution?.method === 'fast'
        ? archive.importArchive(blob, options)
        : archive.importArchiveStreaming(blob, options, toZipOptions(execution)),
    inspectTauriTavern: (blob, stream) =>
      tauriTavern.inspectPackageStreaming(blob, toZipOptions(stream)),
    previewTauriTavern: (blob, options, execution) =>
      execution?.method === 'fast'
        ? tauriTavern.previewPackage(blob, options)
        : tauriTavern.previewPackageStreaming(blob, options, toZipOptions(execution)),
    importTauriTavern: (blob, options, execution) =>
      execution?.method === 'fast'
        ? tauriTavern.importPackage(blob, options)
        : tauriTavern.importPackageStreaming(blob, options, toZipOptions(execution)),
  };
  globalThis.__PURE_TAVERN_DATA_STREAMING__ = bridge;
  return bridge;
}

function toZipOptions(options?: DataManagementStreamingOptions): StreamingZipOptions {
  if (!options) return {};
  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };
}
