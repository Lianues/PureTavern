export interface FileSaveResult {
  status: 'saved' | 'handed-off' | 'cancelled';
  method: 'native' | 'file-system' | 'share' | 'download';
  fileName: string;
  location: string;
}

interface NativeFileSaver {
  beginSave(options: {
    fileName: string;
    mimeType: string;
  }): Promise<{ cancelled?: boolean; sessionId?: string; fileName?: string }>;
  writeChunk(options: { sessionId: string; data: string }): Promise<void>;
  finishSave(options: { sessionId: string }): Promise<void>;
  abortSave?(options: { sessionId: string }): Promise<void>;
}

interface FileSaveHost {
  Capacitor?: { Plugins?: { PureTavernFileSaver?: NativeFileSaver } };
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    name: string;
    createWritable(): Promise<{
      write(data: Blob): Promise<void>;
      close(): Promise<void>;
      abort?(): Promise<void>;
    }>;
  }>;
  toastr?: {
    success(message: string): void;
    info(message: string): void;
    error(message: string): void;
  };
}

declare global {
  var __PURE_TAVERN_SAVE_FILE__: typeof saveFile | undefined;
  var __PURE_TAVERN_DOWNLOAD_FILE__: typeof downloadFile | undefined;
}

const CHUNK_BYTES = 512 * 1024;
const OBJECT_URL_LIFETIME = 60_000;

/** The result distinguishes an acknowledged write from an unconfirmed browser download/share. */
export function saveFile(
  blob: Blob,
  fileName: string,
  preferFileSystem = true,
): Promise<FileSaveResult> {
  return saveWithGesture(blob, fileName, preferFileSystem, true);
}

async function saveWithGesture(
  blob: Blob,
  fileName: string,
  preferFileSystem: boolean,
  allowPrompt: boolean,
): Promise<FileSaveResult> {
  if (
    !fileName ||
    /[\\/]/u.test(fileName) ||
    Array.from(fileName).some((character) => character.codePointAt(0)! <= 0x1f)
  )
    throw new TypeError('A safe file name is required.');
  const host = globalThis as unknown as FileSaveHost;
  const saver = host.Capacitor?.Plugins?.PureTavernFileSaver;
  if (saver?.beginSave && saver.writeChunk && saver.finishSave) {
    const target = await saver.beginSave({
      fileName,
      mimeType: blob.type || 'application/octet-stream',
    });
    if (target.cancelled) return result('cancelled', 'native', fileName, '');
    if (!target.sessionId) throw new Error('The native file picker did not create a save session.');
    const sessionId = target.sessionId;
    try {
      for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
        const blocks: string[] = [];
        for (let start = 0; start < bytes.length; start += 0x8000) {
          blocks.push(String.fromCharCode(...bytes.subarray(start, start + 0x8000)));
        }
        await saver.writeChunk({ sessionId, data: btoa(blocks.join('')) });
      }
      await saver.finishSave({ sessionId });
    } catch (error) {
      await saver.abortSave?.({ sessionId }).catch(() => undefined);
      throw error;
    }
    return result(
      'saved',
      'native',
      target.fileName || fileName,
      '你在 Android 系统文件选择器中选择的位置',
    );
  }

  const extension = fileName.match(/\.[a-z\d][a-z\d._-]{0,14}$/iu)?.[0];
  if (preferFileSystem && host.showSaveFilePicker) {
    if (allowPrompt && navigator.userActivation?.isActive === false)
      return awaitSaveClick(blob, fileName, preferFileSystem, 'file-system');
    let handle: Awaited<ReturnType<NonNullable<FileSaveHost['showSaveFilePicker']>>> | undefined;
    try {
      handle = await host.showSaveFilePicker({
        suggestedName: fileName,
        types: extension
          ? [
              {
                description: 'PureTavern export',
                accept: { [blob.type || 'application/octet-stream']: [extension] },
              },
            ]
          : [],
      });
    } catch (error) {
      if (isAbort(error)) return result('cancelled', 'file-system', fileName, '');
      if (!hasErrorName(error, 'SecurityError')) throw error;
      if (allowPrompt && navigator.userActivation?.isActive !== true)
        return awaitSaveClick(blob, fileName, preferFileSystem, 'file-system');
      // A fresh click cannot overcome a cross-origin/permission restriction. Fall back once.
    }
    if (handle) {
      const writable = await handle.createWritable();
      try {
        await writable.write(blob);
        await writable.close();
      } catch (error) {
        await writable.abort?.().catch(() => undefined);
        throw error;
      }
      return result(
        'saved',
        'file-system',
        handle.name || fileName,
        '你在系统文件选择器中选择的位置',
      );
    }
  }

  if (typeof File === 'function' && typeof navigator.share === 'function') {
    const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
    const data = { files: [file], title: 'PureTavern 导出文件' };
    let supported = false;
    try {
      supported = !navigator.canShare || navigator.canShare(data);
    } catch {
      /* Use a download. */
    }
    if (supported) {
      if (allowPrompt && navigator.userActivation?.isActive === false)
        return awaitSaveClick(blob, fileName, preferFileSystem, 'share');
      try {
        await navigator.share(data);
        return result('handed-off', 'share', fileName, '你在系统文件/分享面板中选择的位置');
      } catch (error) {
        if (isAbort(error)) return result('cancelled', 'share', fileName, '');
        // Some browsers advertise file sharing without accepting this file type.
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = fileName;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME);
  }
  return result(
    'handed-off',
    'download',
    fileName,
    '浏览器/系统默认下载目录（通常是 Download/下载）',
  );
}

function result(
  status: FileSaveResult['status'],
  method: FileSaveResult['method'],
  fileName: string,
  location: string,
): FileSaveResult {
  return { status, method, fileName, location };
}

function isAbort(error: unknown): boolean {
  return hasErrorName(error, 'AbortError');
}

function hasErrorName(error: unknown, name: string): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === name);
}

/** Slow exports need a fresh user gesture before opening a browser file picker/share sheet. */
function awaitSaveClick(
  blob: Blob,
  fileName: string,
  preferFileSystem: boolean,
  method: 'file-system' | 'share',
): Promise<FileSaveResult> {
  return new Promise((resolve, reject) => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', '保存导出文件');
    const label = document.createElement('p');
    label.textContent = `文件已准备好：${fileName}`;
    const save = document.createElement('button');
    save.textContent = '保存文件';
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    dialog.style.cssText =
      'max-width:min(90vw,32rem);padding:1.5rem;border:1px solid currentColor;border-radius:0.5rem;background:Canvas;color:CanvasText;';
    for (const button of [save, cancel])
      button.style.cssText = 'font:inherit;padding:0.5rem 1rem;margin:0.25rem;';
    const dismiss = () => {
      dialog.close();
      dialog.remove();
    };
    const cancelled = () => {
      dismiss();
      resolve(result('cancelled', method, fileName, ''));
    };
    save.addEventListener(
      'click',
      () => {
        // Invoke synchronously in the click handler; no asynchronous work precedes the picker.
        const saving = saveWithGesture(blob, fileName, preferFileSystem, false);
        dismiss();
        void saving.then(resolve, reject);
      },
      { once: true },
    );
    cancel.addEventListener('click', cancelled, { once: true });
    dialog.addEventListener(
      'cancel',
      (event) => {
        event.preventDefault();
        cancelled();
      },
      { once: true },
    );
    dialog.append(label, save, cancel);
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

/** Legacy callers may ignore the returned promise, so report failures without unhandled rejections. */
export async function downloadFile(blob: Blob, fileName: string): Promise<FileSaveResult | null> {
  const toast = (globalThis as unknown as FileSaveHost).toastr;
  try {
    const saved = await saveFile(blob, fileName);
    if (saved.status === 'saved')
      toast?.success(`文件已保存：${saved.fileName}；${saved.location}`);
    if (saved.status === 'handed-off')
      toast?.info(
        `已将文件交给系统处理，页面无法确认是否写入：${saved.fileName}；${saved.location}`,
      );
    return saved;
  } catch (error) {
    toast?.error(error instanceof Error ? error.message : String(error));
    console.error('[PureTavern file save]', error);
    return null;
  }
}

export function installFileSaveBridge(): void {
  globalThis.__PURE_TAVERN_SAVE_FILE__ = saveFile;
  globalThis.__PURE_TAVERN_DOWNLOAD_FILE__ = downloadFile;
}
