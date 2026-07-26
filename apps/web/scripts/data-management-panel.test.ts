import { readFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface RecordedRequest {
  url: string;
  body: unknown;
}

const requests: RecordedRequest[] = [];

const INSPECTION = {
  modules: [
    {
      moduleId: 'characters',
      displayName: 'Characters',
      dataVersion: 1,
      sensitive: false,
      recordCount: 1,
      blobCount: 1,
      totalBytes: 10,
    },
  ],
  backups: [
    {
      id: 'backup-1',
      label: 'Manual backup',
      createdAt: '2026-07-26T00:00:00.000Z',
      size: 120,
      moduleIds: ['characters'],
    },
  ],
  quota: { usage: 10, quota: 100 },
  persistence: {
    mode: 'best-effort',
    container: 'browser',
    supported: true,
    requested: true,
    message: 'declined',
  },
  backupTransport: { kind: 'browser-local' },
};

const BEST_EFFORT = { ...INSPECTION.persistence };

const PREVIEW = {
  manifest: { archiveId: 'tauri-tavern-1', createdAt: '2026-07-26T00:00:00.000Z' },
  modules: [
    {
      moduleId: 'characters',
      displayName: 'Characters',
      selected: true,
      incomingRecords: 1,
      incomingBlobs: 1,
      conflicts: 0,
      warnings: [],
    },
  ],
  totalBytes: 42,
  warnings: [],
  migration: { files: 1, modules: [{ moduleId: 'characters', files: 1 }], warnings: [] },
};

function respond(url: string): Response {
  if (url.endsWith('/archive/inspect')) return jsonResponse(INSPECTION);
  if (url.endsWith('/tauritavern/import/preview')) return jsonResponse(PREVIEW);
  if (url.includes('/tauritavern/')) return zipResponse();
  return jsonResponse({ ok: true });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function zipResponse(): Response {
  return new Response(new Blob([new Uint8Array([1, 2, 3])]), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="tauritavern-data-20260726-000000.zip"',
      'X-PureTavern-Migration': encodeURIComponent(
        JSON.stringify({ files: 2, modules: [{ moduleId: 'characters', files: 2 }], warnings: [] }),
      ),
    },
  });
}

async function loadPanel(): Promise<void> {
  const source = await readFile('src/features/import-export/runtime/index.js', 'utf8');
  // 这个文件在真实环境里是被 Legacy 扩展加载器当普通脚本注入的，所以这里也照原样执行。
  new Function(source)();
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

function buttonLabelled(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

/** 等待面板里那些 fire-and-forget 的点击处理跑完。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

beforeEach(async () => {
  requests.length = 0;
  document.body.replaceChildren();
  delete (globalThis as { __PURE_TAVERN_DATA_MANAGEMENT__?: unknown })
    .__PURE_TAVERN_DATA_MANAGEMENT__;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body });
      return respond(url);
    }),
  );
  // jsdom 没有实现这几个浏览器 API，面板的下载路径会用到。
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  URL.createObjectURL = () => 'blob:stub';
  URL.revokeObjectURL = () => undefined;

  await loadPanel();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PureTavern data management panel', () => {
  it('mounts the drawer entry and exposes the TauriTavern controls', async () => {
    expect(query('#pure-tavern-data-management-entry b').textContent).toBe('PureTavern 数据管理');
    buttonLabelled('打开数据管理').click();
    await settle();

    expect(requests[0]?.url).toBe('/api/backups/archive/inspect');
    expect(query('#ptdm-tt-export').textContent).toBe('导出为 TauriTavern 格式');
    expect(query('label[for="ptdm-tt-import-file"]').textContent).toBe('导入 TauriTavern 数据');
    expect(query<HTMLButtonElement>('#ptdm-tt-import-confirm').disabled).toBe(true);
    // 恢复点每一行都要有自己的 TauriTavern 导出入口。
    expect(query('#ptdm-backups').textContent).toContain('下载为 TauriTavern 格式');
  });

  it('warns when the browser has not granted persistent storage', async () => {
    buttonLabelled('打开数据管理').click();
    await settle();

    expect(query('#ptdm-summary').textContent).toContain('尽力而为');
    const notice = query('#ptdm-persistence');
    expect(notice.classList.contains('ptdm-hidden')).toBe(false);
    expect(notice.classList.contains('ptdm-danger')).toBe(true);
    expect(notice.textContent).toContain('可能在不通知的情况下清除本站的全部数据');
  });

  it('does not raise an un-actionable alarm inside the native shell', async () => {
    INSPECTION.persistence = {
      mode: 'best-effort',
      container: 'native-app',
      supported: true,
      requested: true,
      message: 'declined',
    };
    try {
      buttonLabelled('打开数据管理').click();
      await settle();

      // WebView 永远拿不到持久化授权，标红只会训练用户无视警告。
      expect(query('#ptdm-summary').textContent).toContain('应用私有存储');
      expect(query('#ptdm-summary').querySelector('.ptdm-danger')).toBeNull();
      const notice = query('#ptdm-persistence');
      expect(notice.classList.contains('ptdm-danger')).toBe(false);
      expect(notice.textContent).toContain('清除应用数据');
    } finally {
      INSPECTION.persistence = { ...BEST_EFFORT };
    }
  });

  it('stays quiet once storage is persistent', async () => {
    INSPECTION.persistence = {
      mode: 'persistent',
      container: 'browser',
      supported: true,
      requested: true,
      message: null,
    };
    try {
      buttonLabelled('打开数据管理').click();
      await settle();

      expect(query('#ptdm-summary').textContent).toContain('持久化');
      expect(query('#ptdm-persistence').classList.contains('ptdm-hidden')).toBe(true);
    } finally {
      INSPECTION.persistence = { ...BEST_EFFORT };
    }
  });

  it('exports the current data as a TauriTavern package', async () => {
    buttonLabelled('打开数据管理').click();
    await settle();
    requests.length = 0;

    query<HTMLButtonElement>('#ptdm-tt-export').click();
    await settle();

    expect(requests[0]?.url).toBe('/api/backups/tauritavern/export');
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({ moduleIds: ['characters'] });
    expect(query('#ptdm-report').textContent).toContain('共 2 个文件');
  });

  it('converts a stored recovery point into a TauriTavern package', async () => {
    buttonLabelled('打开数据管理').click();
    await settle();
    requests.length = 0;

    buttonLabelled('下载为 TauriTavern 格式').click();
    await settle();

    expect(requests[0]?.url).toBe('/api/backups/tauritavern/local/download');
    expect(JSON.parse(String(requests[0]?.body))).toEqual({ id: 'backup-1' });
  });

  it('previews a selected TauriTavern package before enabling the import', async () => {
    buttonLabelled('打开数据管理').click();
    await settle();
    requests.length = 0;

    const input = query<HTMLInputElement>('#ptdm-tt-import-file');
    const file = new File([new Uint8Array([1, 2, 3])], 'tauritavern-data.zip', {
      type: 'application/zip',
    });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle();

    expect(requests[0]?.url).toBe('/api/backups/tauritavern/import/preview');
    expect(query('#ptdm-tt-import-file-name').textContent).toBe('tauritavern-data.zip');
    expect(query<HTMLButtonElement>('#ptdm-tt-import-confirm').disabled).toBe(false);
    expect(query('#ptdm-tt-preview').textContent).toContain('TauriTavern 数据包：1 个文件');
    // 原生归档的确认按钮不能被这次预览连带打开。
    expect(query<HTMLButtonElement>('#ptdm-import-confirm').disabled).toBe(true);
  });
});
