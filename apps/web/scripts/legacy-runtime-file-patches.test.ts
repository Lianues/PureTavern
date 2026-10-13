import { readFile } from 'node:fs/promises';
import { Blob as NodeBlob } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { patchLegacyChatExport, patchLegacyDownload } from './legacy-runtime-file-patches.mjs';

describe('generated Legacy file-save adaptation', () => {
  it('sends the actual exported bytes and filename to the platform bridge', async () => {
    const source = await readFile('legacy/upstream/public/scripts/utils.js', 'utf8');
    const patched = patchLegacyDownload(source);
    const download = patched.match(
      /export function download\(content, fileName, contentType\) \{[\s\S]*?\n\}/,
    )?.[0];
    expect(download).toBeDefined();
    const bridge = vi.fn(async (blob: Blob, name: string) => ({ text: await blob.text(), name }));
    const invoke = new Function(
      'globalThis',
      'Blob',
      `${download?.replace('export ', '')}; return download;`,
    )({ __PURE_TAVERN_DOWNLOAD_FILE__: bridge }, NodeBlob);
    expect(await invoke('你好🙂', '聊天.jsonl', 'application/octet-stream')).toEqual({
      text: '你好🙂',
      name: '聊天.jsonl',
    });
    expect(bridge).toHaveBeenCalledOnce();
    expect(source).not.toContain('__PURE_TAVERN_DOWNLOAD_FILE__');
  });

  it('awaits the chat download without the premature saved toast', async () => {
    const source = await readFile('legacy/upstream/public/script.js', 'utf8');
    const patched = patchLegacyChatExport(source);
    expect(patched).toContain('await download(data.result, body.exportfilename, mimeType);');
    expect(patched).not.toContain('toastr.success(data.message);');
    expect(source).toContain('toastr.success(data.message);');
  });

  it('fails closed when an upstream update removes or duplicates a patch anchor', async () => {
    const source = await readFile('legacy/upstream/public/scripts/utils.js', 'utf8');
    expect(() => patchLegacyDownload('')).toThrow('exactly one anchor');
    expect(() => patchLegacyDownload(source + source)).toThrow('found 2');
    expect(() => patchLegacyChatExport('')).toThrow('exactly one anchor');
  });
});
