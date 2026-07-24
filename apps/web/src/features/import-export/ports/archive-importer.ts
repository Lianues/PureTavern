import type { ArchiveImportPreview, ArchiveImportReport } from '@pure-tavern/contracts';

import type { ArchiveImportOptions } from '../domain/archive';

export interface ArchiveImporter {
  previewArchive(archive: Blob, options?: ArchiveImportOptions): Promise<ArchiveImportPreview>;
  importArchive(archive: Blob, options?: ArchiveImportOptions): Promise<ArchiveImportReport>;
}
