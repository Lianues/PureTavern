import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installLegacyFileAccept,
  relaxFileAccept,
  usesMimeOnlyFilePicker,
} from './legacy-file-accept';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.innerHTML = '';
});

function install(): void {
  disposers.push(installLegacyFileAccept({ enabled: true }));
}

describe('relaxFileAccept', () => {
  it('relaxes accept lists that filter by extension', () => {
    expect(relaxFileAccept('.json, .jsonl')).toBe('*/*');
    expect(relaxFileAccept('.json, image/png, .yaml, .yml, .charx, .byaf')).toBe('*/*');
    expect(relaxFileAccept('.json,.lorebook,.png')).toBe('*/*');
  });

  it('leaves MIME-only and already relaxed filters untouched', () => {
    expect(relaxFileAccept('image/*')).toBeNull();
    expect(relaxFileAccept('image/png, image/jpeg')).toBeNull();
    expect(relaxFileAccept('image/*,video/*')).toBeNull();
    expect(relaxFileAccept('*/*')).toBeNull();
    expect(relaxFileAccept('  ')).toBeNull();
    // 上游正则扩展写法本来就不是合法 token，浏览器已经不过滤了。
    expect(relaxFileAccept('*.json')).toBeNull();
  });
});

describe('usesMimeOnlyFilePicker', () => {
  it('detects mobile shells and browsers', () => {
    expect(
      usesMimeOnlyFilePicker({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' } as Navigator),
    ).toBe(true);
    expect(
      usesMimeOnlyFilePicker({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
      } as Navigator),
    ).toBe(true);
    expect(
      usesMimeOnlyFilePicker({
        userAgent: 'Mozilla/5.0 (Macintosh)',
        maxTouchPoints: 5,
      } as Navigator),
    ).toBe(true);
  });

  it('keeps desktop filters intact', () => {
    expect(
      usesMimeOnlyFilePicker({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      } as Navigator),
    ).toBe(false);
    expect(
      usesMimeOnlyFilePicker({
        userAgent: 'Mozilla/5.0 (Macintosh)',
        maxTouchPoints: 0,
      } as Navigator),
    ).toBe(false);
    expect(usesMimeOnlyFilePicker(undefined)).toBe(false);
  });
});

describe('installLegacyFileAccept', () => {
  it('relaxes existing Legacy import inputs and records the upstream value', () => {
    document.body.innerHTML = `
      <input type="file" id="chat_import_file" accept=".json, .jsonl" multiple>
      <input type="file" id="avatar_upload_file" accept="image/*">
      <input type="text" id="not_a_file" accept=".json">
    `;
    install();

    const chatImport = document.querySelector<HTMLInputElement>('#chat_import_file');
    expect(chatImport?.getAttribute('accept')).toBe('*/*');
    expect(chatImport?.dataset.pureTavernUpstreamAccept).toBe('.json, .jsonl');
    expect(document.querySelector('#avatar_upload_file')?.getAttribute('accept')).toBe('image/*');
    expect(document.querySelector('#not_a_file')?.getAttribute('accept')).toBe('.json');
  });

  it('relaxes inputs rendered after installation', async () => {
    install();
    const popup = document.createElement('div');
    popup.innerHTML = '<input type="file" id="world_import_file" accept=".json,.lorebook,.png">';
    document.body.append(popup);
    await flushMutationObserver();

    expect(popup.querySelector('#world_import_file')?.getAttribute('accept')).toBe('*/*');
  });

  it('relaxes detached inputs that are clicked without entering the DOM', () => {
    install();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.jsonl';
    const opened = vi.fn();
    input.addEventListener('click', opened);
    input.click();

    expect(input.getAttribute('accept')).toBe('*/*');
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('does nothing on desktop and restores the patched click on dispose', () => {
    const nativeClick = HTMLInputElement.prototype.click;
    const dispose = installLegacyFileAccept({ enabled: false });
    document.body.innerHTML = '<input type="file" id="chat_import_file" accept=".json, .jsonl">';

    expect(document.querySelector('#chat_import_file')?.getAttribute('accept')).toBe(
      '.json, .jsonl',
    );
    expect(HTMLInputElement.prototype.click).toBe(nativeClick);
    dispose();

    const restore = installLegacyFileAccept({ enabled: true });
    expect(HTMLInputElement.prototype.click).not.toBe(nativeClick);
    restore();
    expect(HTMLInputElement.prototype.click).toBe(nativeClick);
  });
});

async function flushMutationObserver(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
