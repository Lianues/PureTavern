import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadFile, saveFile } from './file-save';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('navigator', { userActivation: { isActive: true } });
  vi.stubGlobal('Capacitor', undefined);
  vi.stubGlobal('showSaveFilePicker', undefined);
  vi.stubGlobal('toastr', { success: vi.fn(), info: vi.fn(), error: vi.fn() });
  URL.createObjectURL = vi.fn(() => 'blob:export');
  URL.revokeObjectURL = vi.fn();
  document.body.replaceChildren();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function nativeSaver() {
  const saver = {
    beginSave: vi.fn(async () => ({ sessionId: 'session', fileName: '聊天.jsonl' })),
    writeChunk: vi
      .fn<(options: { sessionId: string; data: string }) => Promise<void>>()
      .mockResolvedValue(undefined),
    finishSave: vi.fn(async () => undefined),
    abortSave: vi.fn(async () => undefined),
  };
  vi.stubGlobal('Capacitor', { Plugins: { PureTavernFileSaver: saver } });
  return saver;
}

describe('platform file saving', () => {
  it('writes Unicode chat bytes in bounded native chunks and reports success only after finishing', async () => {
    const saver = nativeSaver();
    const blob = new Blob(['你好🙂'.repeat(80_000)], { type: 'application/octet-stream' });
    const saved = await saveFile(blob, '聊天.jsonl');
    const chunks = saver.writeChunk.mock.calls.map(([chunk]) => Buffer.from(chunk.data, 'base64'));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 512 * 1024)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(await blob.arrayBuffer()));
    expect(saver.beginSave).toHaveBeenCalledWith({
      fileName: '聊天.jsonl',
      mimeType: 'application/octet-stream',
    });
    expect(saver.finishSave).toHaveBeenCalledWith({ sessionId: 'session' });
    expect(saved.status).toBe('saved');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('aborts a failed native write and never starts a fallback download', async () => {
    const saver = nativeSaver();
    saver.writeChunk.mockRejectedValueOnce(new Error('Disk full'));
    await expect(saveFile(new Blob(['chat']), 'chat.jsonl')).rejects.toThrow('Disk full');
    expect(saver.abortSave).toHaveBeenCalledWith({ sessionId: 'session' });
    expect(saver.finishSave).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('does not claim success when the native file picker is cancelled', async () => {
    const saver = nativeSaver();
    saver.beginSave.mockResolvedValueOnce({ cancelled: true } as never);
    expect(await downloadFile(new Blob(['chat']), 'chat.jsonl')).toMatchObject({
      status: 'cancelled',
    });
    expect(saver.writeChunk).not.toHaveBeenCalled();
    expect(
      (globalThis as unknown as { toastr: { success: ReturnType<typeof vi.fn> } }).toastr.success,
    ).not.toHaveBeenCalled();
  });

  it('keeps an attached download URL alive and labels browser handoff as unconfirmed', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.isConnected).toBe(true);
      expect(this.download).toBe('聊天.jsonl');
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    });
    expect(await saveFile(new Blob(['chat']), '聊天.jsonl')).toMatchObject({
      status: 'handed-off',
      method: 'download',
    });
    expect(document.querySelector('a')).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:export');
  });

  it('cleans up the object URL even if clicking the download fails', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('Download blocked');
    });
    await expect(saveFile(new Blob(['chat']), 'chat.txt')).rejects.toThrow('Download blocked');
    expect(document.querySelector('a')).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:export');
  });

  it('reacquires a click after a slow export before calling the browser picker', async () => {
    const activation = { isActive: false };
    vi.stubGlobal('navigator', { userActivation: activation });
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const picker = vi.fn(async () => ({
      name: 'chosen.jsonl',
      createWritable: async () => ({ write, close }),
    }));
    vi.stubGlobal('showSaveFilePicker', picker);
    const blob = new Blob(['chat']);
    const saving = saveFile(blob, 'chat.jsonl');
    expect(picker).not.toHaveBeenCalled();
    activation.isActive = true;
    (document.querySelector('dialog button') as HTMLButtonElement).click();
    expect(await saving).toMatchObject({ status: 'saved', fileName: 'chosen.jsonl' });
    expect(write).toHaveBeenCalledWith(blob);
    expect(close).toHaveBeenCalledOnce();
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('returns cancellation from the save-ready dialog without opening a picker', async () => {
    vi.stubGlobal('navigator', { userActivation: { isActive: false } });
    const picker = vi.fn();
    vi.stubGlobal('showSaveFilePicker', picker);
    const saving = saveFile(new Blob(['chat']), 'chat.jsonl');
    (document.querySelectorAll('dialog button')[1] as HTMLButtonElement).click();
    expect(await saving).toMatchObject({ status: 'cancelled' });
    expect(picker).not.toHaveBeenCalled();
  });

  it('aborts a failed writable and preserves the write error instead of reporting handoff', async () => {
    const abort = vi.fn(async () => undefined);
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn(async () => ({
        name: 'chat.txt',
        createWritable: async () => ({
          write: async () => {
            throw new Error('Disk full');
          },
          close: vi.fn(),
          abort,
        }),
      })),
    );
    await expect(saveFile(new Blob(['chat']), 'chat.txt')).rejects.toThrow('Disk full');
    expect(abort).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('falls back once when a fresh gesture cannot overcome a picker security restriction', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const picker = vi.fn(async () => {
      throw new DOMException('Cross-origin picker blocked', 'SecurityError');
    });
    vi.stubGlobal('showSaveFilePicker', picker);
    expect(await saveFile(new Blob(['chat']), 'chat.txt')).toMatchObject({
      status: 'handed-off',
      method: 'download',
    });
    expect(picker).toHaveBeenCalledOnce();
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('keeps a writable SecurityError as a failure instead of opening another picker', async () => {
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn(async () => ({
        name: 'chat.txt',
        createWritable: async () => ({
          write: async () => {
            throw new DOMException('Write denied', 'SecurityError');
          },
          close: vi.fn(),
        }),
      })),
    );
    await expect(saveFile(new Blob(['chat']), 'chat.txt')).rejects.toThrow('Write denied');
    expect(document.querySelector('dialog')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
