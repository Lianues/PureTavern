import type { ExportedArchive } from '../ports/archive-exporter';

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<{
    createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
  }>;
}

export class BrowserArchiveFileTransfer {
  async save(
    exported: ExportedArchive,
    preferFileSystem = true,
  ): Promise<'file-system' | 'download'> {
    const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
    if (preferFileSystem && picker) {
      const handle = await picker({
        suggestedName: exported.fileName,
        types: [{ description: 'PureTavern backup', accept: { 'application/zip': ['.zip'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(exported.blob);
      await writable.close();
      return 'file-system';
    }

    const url = URL.createObjectURL(exported.blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = exported.fileName;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return 'download';
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }
}
