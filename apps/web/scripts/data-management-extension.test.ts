import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('PureTavern data management first-party extension', () => {
  it('is declared as a separate first-party trusted Legacy extension with runtime assets', async () => {
    const [assets, manifestText, script, prepareScript] = await Promise.all([
      readFile('src/features/import-export/runtime-assets.json', 'utf8'),
      readFile('src/features/import-export/runtime/manifest.json', 'utf8'),
      readFile('src/features/import-export/runtime/index.js', 'utf8'),
      readFile('scripts/prepare-legacy-runtime.mjs', 'utf8'),
    ]);
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      display_name: 'PureTavern Data Management',
      js: 'index.js',
      css: 'style.css',
    });
    expect(assets).toContain('scripts/extensions/pure-tavern-data-management/index.js');
    expect(script).toContain('pure-tavern-data-management-dialog');
    expect(script).toContain('inline-drawer-toggle inline-drawer-header');
    expect(script).toContain('inline-drawer-content');
    expect(script).toContain('打开数据管理');
    expect(script).toContain('/api/backups/archive');
    expect(script).toContain('PureTavernFileSaver');
    expect(script).toContain('NATIVE_SAVE_CHUNK_SIZE');
    expect(script).toContain('你在 Android 系统文件选择器中选择的位置');
    expect(script).toContain('你在系统文件/分享面板中选择的位置');
    expect(script).toContain('浏览器/系统默认下载目录（通常是 Download/下载）');
    expect(script).toContain('globalThis.navigator.share(shareData)');
    expect(script).toContain('Web 页面无法确认文件是否写入');
    expect(script).toContain("notifySavedFile('数据归档已导出', saved)");
    expect(script).toContain("notifySavedFile('恢复点已导出', saved)");
    expect(script).toContain('function confirmAction');
    expect(script).toContain('ptdm-confirm-dialog');
    expect(script).not.toContain('confirm(');
    expect(prepareScript).toContain("extensionId: 'pure-tavern.data-management'");
    expect(prepareScript).toContain("sourceKind: 'pure-tavern-first-party'");
  });

  it('offers TauriTavern interop in the export, import and recovery point sections', async () => {
    const script = await readFile('src/features/import-export/runtime/index.js', 'utf8');

    expect(script).toContain('/api/backups/tauritavern');
    expect(script).toContain('导出为 TauriTavern 格式');
    expect(script).toContain('导入 TauriTavern 数据');
    expect(script).toContain('下载为 TauriTavern 格式');
    // 三个入口必须各自接到自己的处理函数上，而不是共用原生归档那一套。
    expect(script).toContain("dialog.querySelector('#ptdm-tt-export')");
    expect(script).toContain("bindConfirm(dialog, '#ptdm-tt-import-confirm', importTauriTavern)");
    expect(script).toContain('downloadBackupAsTauriTavern(backup.id)');
  });
});
