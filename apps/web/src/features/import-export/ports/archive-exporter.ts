import type { PureTavernArchiveManifest } from '@pure-tavern/contracts';

import type { ArchiveExportOptions } from '../domain/archive';

export interface ExportedArchive {
  blob: Blob;
  manifest: PureTavernArchiveManifest;
  fileName: string;
}

export interface ArchiveExporter {
  exportArchive(options?: ArchiveExportOptions): Promise<ExportedArchive>;
}
