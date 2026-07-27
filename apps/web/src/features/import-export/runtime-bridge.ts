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

export interface DataManagementStreamingOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ZipProgress) => void;
}

export interface DataManagementRuntimeBridge {
  inspectArchive(
    archive: Blob,
    stream?: DataManagementStreamingOptions,
  ): Promise<ArchiveImportPreview>;
  previewArchive(
    archive: Blob,
    options: ArchiveImportOptions,
    stream?: DataManagementStreamingOptions,
  ): Promise<ArchiveImportPreview>;
  importArchive(
    archive: Blob,
    options: ArchiveImportOptions,
    stream?: DataManagementStreamingOptions,
  ): Promise<ArchiveImportReport>;
  inspectTauriTavern(
    archive: Blob,
    stream?: DataManagementStreamingOptions,
  ): Promise<TauriTavernPackageInspection>;
  previewTauriTavern(
    archive: Blob,
    options: ArchiveImportOptions,
    stream?: DataManagementStreamingOptions,
  ): Promise<TauriTavernImportPreview>;
  importTauriTavern(
    archive: Blob,
    options: ArchiveImportOptions,
    stream?: DataManagementStreamingOptions,
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
    previewArchive: (blob, options, stream) =>
      archive.previewArchiveStreaming(blob, options, toZipOptions(stream)),
    importArchive: (blob, options, stream) =>
      archive.importArchiveStreaming(blob, options, toZipOptions(stream)),
    inspectTauriTavern: (blob, stream) =>
      tauriTavern.inspectPackageStreaming(blob, toZipOptions(stream)),
    previewTauriTavern: (blob, options, stream) =>
      tauriTavern.previewPackageStreaming(blob, options, toZipOptions(stream)),
    importTauriTavern: (blob, options, stream) =>
      tauriTavern.importPackageStreaming(blob, options, toZipOptions(stream)),
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
