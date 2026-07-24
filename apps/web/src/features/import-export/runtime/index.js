/* global fetch, document, console, URL, setTimeout, confirm, location, FormData */

const API = '/api/backups/archive';
const state = { inspection: null, selectedFile: null, preview: null };

function headers() {
  return { 'Content-Type': 'application/json' };
}

async function postJson(path, body = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    cache: 'no-cache',
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : { ok: true };
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: HTTP ${response.status}`);
  }
  return payload;
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = bytes / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[index]}`;
}

function selectedModules() {
  return [...document.querySelectorAll('#ptdm-modules input[data-module]:checked')].map(
    (input) => input.dataset.module,
  );
}

function includeSecrets() {
  return document.querySelector('#ptdm-include-secrets')?.checked === true;
}

function notify(type, message) {
  globalThis.toastr?.[type]?.(message);
}

async function refresh() {
  state.inspection = await postJson(`${API}/inspect`);
  renderInspection();
  renderBackups();
}

function renderInspection() {
  const inspection = state.inspection;
  if (!inspection) return;
  const usage = inspection.quota?.usage ?? 0;
  const quota = inspection.quota?.quota ?? 0;
  const percent = quota ? Math.min(100, (usage / quota) * 100) : 0;
  document.querySelector('#ptdm-summary').innerHTML = `
    <div class="ptdm-card"><strong>${inspection.modules.length}</strong><div>数据模块</div></div>
    <div class="ptdm-card"><strong>${formatBytes(usage)}</strong><div>浏览器用量</div></div>
    <div class="ptdm-card"><strong>${formatBytes(quota)}</strong><div>浏览器配额</div></div>
    <div class="ptdm-card"><strong>${inspection.backups.length}</strong><div>本地恢复点</div></div>`;
  const progress = document.querySelector('#ptdm-quota');
  progress.value = percent;
  progress.title = `${percent.toFixed(1)}%`;

  const modules = document.querySelector('#ptdm-modules');
  modules.replaceChildren();
  for (const module of inspection.modules) {
    const row = document.createElement('label');
    row.className = 'ptdm-module-row';
    const checked = !module.sensitive;
    row.innerHTML = `
      <span><input type="checkbox" data-module="${module.moduleId}" ${checked ? 'checked' : ''}>
        <strong></strong>${module.sensitive ? ' ⚠️' : ''}</span>
      <span class="ptdm-module-meta">${module.recordCount} records · ${module.blobCount} blobs · ${formatBytes(module.totalBytes)}</span>`;
    row.querySelector('strong').textContent = module.displayName;
    modules.appendChild(row);
  }
}

function renderBackups() {
  const list = document.querySelector('#ptdm-backups');
  list.replaceChildren();
  for (const backup of state.inspection?.backups ?? []) {
    const row = document.createElement('div');
    row.className = 'ptdm-backup-row';
    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = backup.label;
    const meta = document.createElement('div');
    meta.className = 'ptdm-module-meta';
    meta.textContent = `${new Date(backup.createdAt).toLocaleString()} · ${formatBytes(backup.size)} · ${backup.moduleIds.length} modules`;
    info.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'ptdm-toolbar';
    actions.append(
      actionButton('下载', () => downloadBackup(backup.id)),
      actionButton('恢复', () => restoreBackup(backup.id), 'menu_button'),
      actionButton('删除', () => deleteBackup(backup.id), 'menu_button ptdm-danger'),
    );
    row.append(info, actions);
    list.appendChild(row);
  }
  if (!list.children.length) list.textContent = '暂无本地恢复点。';
}

function actionButton(label, handler, className = 'menu_button') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', () => void handler());
  return button;
}

async function fetchArchive(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Archive request failed: HTTP ${response.status}`);
  const disposition = response.headers.get('Content-Disposition') || '';
  const fileName = disposition.match(/filename="([^"]+)"/i)?.[1] || 'pure-tavern-backup.zip';
  return { blob: await response.blob(), fileName };
}

const NATIVE_SAVE_CHUNK_SIZE = 512 * 1024;

function encodeBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const blocks = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    blocks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return globalThis.btoa(blocks.join(''));
}

async function saveWithNativeFilePicker(blob, fileName) {
  const saver = globalThis.Capacitor?.Plugins?.PureTavernFileSaver;
  if (
    typeof saver?.beginSave !== 'function' ||
    typeof saver?.writeChunk !== 'function' ||
    typeof saver?.finishSave !== 'function'
  ) {
    return null;
  }

  const target = await saver.beginSave({
    fileName,
    mimeType: blob.type || 'application/zip',
  });
  if (target.cancelled) return { cancelled: true, confirmed: false, fileName, location: '' };
  if (!target.sessionId) throw new Error('系统文件选择器未创建保存会话。');

  try {
    for (let offset = 0; offset < blob.size; offset += NATIVE_SAVE_CHUNK_SIZE) {
      const data = encodeBase64(
        await blob.slice(offset, offset + NATIVE_SAVE_CHUNK_SIZE).arrayBuffer(),
      );
      await saver.writeChunk({ sessionId: target.sessionId, data });
    }
    await saver.finishSave({ sessionId: target.sessionId });
  } catch (error) {
    try {
      await saver.abortSave?.({ sessionId: target.sessionId });
    } catch (abortError) {
      console.warn(abortError);
    }
    throw error;
  }

  return {
    cancelled: false,
    confirmed: true,
    fileName: target.fileName || fileName,
    location: '你在 Android 系统文件选择器中选择的位置',
  };
}

async function saveBlob(blob, fileName) {
  const nativeResult = await saveWithNativeFilePicker(blob, fileName);
  if (nativeResult) return nativeResult;

  if (globalThis.showSaveFilePicker) {
    try {
      const handle = await globalThis.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: 'PureTavern backup', accept: { 'application/zip': ['.zip'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return {
        cancelled: false,
        confirmed: true,
        fileName: handle.name || fileName,
        location: '你在系统文件选择器中选择的位置',
      };
    } catch (error) {
      if (error?.name !== 'AbortError') console.warn(error);
      if (error?.name === 'AbortError') {
        return { cancelled: true, confirmed: false, fileName, location: '' };
      }
    }
  }
  if (typeof globalThis.File === 'function' && typeof globalThis.navigator?.share === 'function') {
    const file = new globalThis.File([blob], fileName, { type: 'application/zip' });
    const shareData = { files: [file], title: 'PureTavern 数据归档' };
    let canShare;
    try {
      canShare = !globalThis.navigator.canShare || globalThis.navigator.canShare(shareData);
    } catch (error) {
      canShare = false;
      console.warn(error);
    }
    if (canShare) {
      try {
        await globalThis.navigator.share(shareData);
        return {
          cancelled: false,
          confirmed: false,
          fileName,
          location: '你在系统文件/分享面板中选择的位置',
        };
      } catch (error) {
        if (error?.name === 'AbortError') {
          return { cancelled: true, confirmed: false, fileName, location: '' };
        }
        console.warn(error);
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return {
    cancelled: false,
    confirmed: false,
    fileName,
    location: '浏览器/系统默认下载目录（通常是 Download/下载）',
  };
}

function notifySavedFile(prefix, result) {
  if (result.cancelled) return;
  const details = `文件：${result.fileName}；位置：${result.location}`;
  if (result.confirmed) {
    notify('success', `${prefix}。${details}`);
    return;
  }
  notify('info', `已将下载请求交给系统处理，Web 页面无法确认文件是否写入。${details}`);
}

async function exportArchive() {
  try {
    const result = await fetchArchive(`${API}/export`, {
      moduleIds: selectedModules(),
      includeSecrets: includeSecrets(),
    });
    const saved = await saveBlob(result.blob, result.fileName);
    notifySavedFile('数据归档已导出', saved);
  } catch (error) {
    notify('error', error.message);
  }
}

async function createBackup() {
  try {
    const descriptor = await postJson(`${API}/local/create`, {
      label: `Manual backup ${new Date().toLocaleString()}`,
      moduleIds: selectedModules(),
      includeSecrets: includeSecrets(),
    });
    notify('success', `恢复点已创建：${descriptor.label}`);
    await refresh();
  } catch (error) {
    notify('error', error.message);
  }
}

async function downloadBackup(id) {
  try {
    const result = await fetchArchive(`${API}/local/download`, { id });
    const saved = await saveBlob(result.blob, result.fileName);
    notifySavedFile('恢复点已导出', saved);
  } catch (error) {
    notify('error', error.message);
  }
}

async function deleteBackup(id) {
  if (!confirm('确定删除这个本地恢复点吗？')) return;
  try {
    await postJson(`${API}/local/delete`, { id });
    await refresh();
  } catch (error) {
    notify('error', error.message);
  }
}

async function restoreBackup(id) {
  if (!confirm('恢复会修改当前数据，并自动创建恢复前快照。是否继续？')) return;
  try {
    const report = await postJson(`${API}/local/restore`, {
      id,
      strategy: document.querySelector('#ptdm-strategy').value,
      includeSecrets: includeSecrets(),
    });
    showReport(report);
    notify('success', '恢复完成，页面即将刷新。');
    setTimeout(() => location.reload(), 500);
  } catch (error) {
    notify('error', error.message);
  }
}

async function previewImport(file) {
  state.selectedFile = file;
  const form = new FormData();
  form.set('file', file);
  form.set('includeSecrets', String(includeSecrets()));
  form.set('strategy', document.querySelector('#ptdm-strategy').value);
  const response = await fetch(`${API}/import/preview`, { method: 'POST', body: form });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Preview failed: HTTP ${response.status}`);
  state.preview = payload;
  const target = document.querySelector('#ptdm-preview');
  target.classList.remove('ptdm-hidden');
  target.textContent = [
    `Archive: ${payload.manifest.archiveId}`,
    `Created: ${payload.manifest.createdAt}`,
    `Modules: ${payload.modules.length}`,
    `Payload: ${formatBytes(payload.totalBytes)}`,
    ...payload.modules.map(
      (module) =>
        `${module.selected ? '✓' : '–'} ${module.displayName}: ${module.incomingRecords} records, ${module.incomingBlobs} blobs, ${module.conflicts} conflicts${module.warnings.length ? ` (${module.warnings.join('; ')})` : ''}`,
    ),
  ].join('\n');
  document.querySelector('#ptdm-import-confirm').disabled = false;
}

async function importArchive() {
  if (!state.selectedFile) return;
  if (!confirm('导入前会自动创建恢复点。确定继续吗？')) return;
  const form = new FormData();
  form.set('file', state.selectedFile);
  form.set('includeSecrets', String(includeSecrets()));
  form.set('strategy', document.querySelector('#ptdm-strategy').value);
  form.set('createRecoveryPoint', 'true');
  const response = await fetch(`${API}/import`, { method: 'POST', body: form });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Import failed: HTTP ${response.status}`);
  showReport(payload);
  notify('success', '数据导入完成，页面即将刷新。');
  setTimeout(() => location.reload(), 500);
}

function showReport(report) {
  const target = document.querySelector('#ptdm-report');
  target.classList.remove('ptdm-hidden');
  target.textContent = JSON.stringify(report, null, 2);
}

function createUi() {
  if (document.querySelector('#pure-tavern-data-management-entry')) return;
  const entry = document.createElement('section');
  entry.id = 'pure-tavern-data-management-entry';
  entry.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>PureTavern 数据管理</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <button type="button" class="menu_button">打开数据管理</button>
      </div>
    </div>`;
  (document.querySelector('#extensions_settings2') || document.body).prepend(entry);

  const dialog = document.createElement('dialog');
  dialog.id = 'pure-tavern-data-management-dialog';
  dialog.innerHTML = `
    <div class="ptdm-header"><div><h2>PureTavern 数据管理</h2><div class="ptdm-muted">本地归档与灾难恢复中心</div></div><button type="button" class="menu_button" id="ptdm-close">关闭</button></div>
    <div class="ptdm-body">
      <div id="ptdm-summary" class="ptdm-grid"></div>
      <progress id="ptdm-quota" class="ptdm-progress" max="100" value="0"></progress>
      <section class="ptdm-section"><h3>模块</h3><div id="ptdm-modules"></div><label class="ptdm-danger"><input id="ptdm-include-secrets" type="checkbox"> 包含明文 Secrets（危险，不加密）</label></section>
      <section class="ptdm-section"><h3>手动导出</h3><div class="ptdm-toolbar"><button id="ptdm-export" class="menu_button">导出 ZIP</button><button id="ptdm-create-backup" class="menu_button">创建本地恢复点</button></div></section>
      <section class="ptdm-section"><h3>导入与恢复</h3><div class="ptdm-toolbar"><input id="ptdm-import-file" class="ptdm-hidden" type="file" accept=".zip,application/zip,application/x-zip-compressed"><label for="ptdm-import-file" class="menu_button ptdm-file-picker">选择数据 ZIP</label><span id="ptdm-import-file-name" class="ptdm-muted" title="尚未选择文件">尚未选择文件</span><select id="ptdm-strategy"><option value="merge">合并并覆盖冲突</option><option value="skip">跳过冲突</option><option value="replace-module">替换选中模块</option><option value="replace-all">替换归档模块</option></select><button id="ptdm-import-confirm" class="menu_button" disabled>执行导入</button></div><pre id="ptdm-preview" class="ptdm-report ptdm-hidden"></pre><pre id="ptdm-report" class="ptdm-report ptdm-hidden"></pre></section>
      <section class="ptdm-section"><h3>本地恢复点</h3><div id="ptdm-backups"></div></section>
    </div>`;
  document.body.appendChild(dialog);

  entry.querySelector('button').addEventListener('click', async () => {
    dialog.showModal();
    try {
      await refresh();
    } catch (error) {
      notify('error', error.message);
    }
  });
  dialog.querySelector('#ptdm-close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#ptdm-export').addEventListener('click', () => void exportArchive());
  dialog.querySelector('#ptdm-create-backup').addEventListener('click', () => void createBackup());
  dialog.querySelector('#ptdm-import-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    const fileName = dialog.querySelector('#ptdm-import-file-name');
    if (!file) {
      fileName.textContent = '尚未选择文件';
      fileName.title = '尚未选择文件';
      return;
    }
    fileName.textContent = file.name;
    fileName.title = file.name;
    try {
      await previewImport(file);
    } catch (error) {
      notify('error', error.message);
    }
  });
  dialog.querySelector('#ptdm-import-confirm').addEventListener('click', async () => {
    try {
      await importArchive();
    } catch (error) {
      notify('error', error.message);
    }
  });
  dialog.querySelector('#ptdm-include-secrets').addEventListener('change', (event) => {
    if (
      event.target.checked &&
      !confirm('Secrets 会以明文写入 ZIP。任何取得文件的人都能读取。确定吗？')
    ) {
      event.target.checked = false;
    }
  });

  globalThis.__PURE_TAVERN_DATA_MANAGEMENT__ = {
    installed: true,
    open: () => entry.querySelector('button').click(),
    refresh,
  };
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', createUi, { once: true });
else createUi();
