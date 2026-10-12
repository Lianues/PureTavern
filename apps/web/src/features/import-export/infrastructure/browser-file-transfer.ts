import { saveFile, type FileSaveResult } from '@/platform/runtime/file-save';
import type { ExportedArchive } from '../ports/archive-exporter';

export class BrowserArchiveFileTransfer {
  async save(exported: ExportedArchive, preferFileSystem = true): Promise<FileSaveResult> {
    return saveFile(exported.blob, exported.fileName, preferFileSystem);
  }
}
