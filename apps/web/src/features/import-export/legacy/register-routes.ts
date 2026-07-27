import type { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { emptyResponse, jsonResponse } from '@/platform/legacy/compatibility-router';

import type { ArchiveService } from '../application/archive-service';
import {
  ArchiveValidationError,
  normalizeStrategy,
  type ArchiveExportOptions,
  type ArchiveImportOptions,
} from '../domain/archive';
import { TauriTavernFormatError } from '../tauri-tavern/domain/data-tree';
import type { TauriTavernMigrationService } from '../tauri-tavern/application/tauri-tavern-service';

export function registerImportExportLegacyRoutes(
  router: CompatibilityRouter,
  service: ArchiveService,
  tauriTavern: TauriTavernMigrationService,
): void {
  router.register('POST', '/api/backups/archive/inspect', async () =>
    jsonResponse(await service.inspect()),
  );

  router.register('POST', '/api/backups/archive/export', async (request) => {
    try {
      const options = readExportOptions(await readOptionalJson(request));
      const exported = await service.exportArchive(options);
      return archiveResponse(exported.blob, exported.fileName);
    } catch (error) {
      return archiveErrorResponse(error);
    }
  });

  router.register('POST', '/api/backups/archive/import/preview', async (request) => {
    try {
      const { archive, options } = await readImportForm(request);
      return jsonResponse(await service.previewArchive(archive, options));
    } catch (error) {
      return archiveErrorResponse(error);
    }
  });

  router.register('POST', '/api/backups/archive/import', async (request) => {
    try {
      const { archive, options } = await readImportForm(request);
      return jsonResponse(await service.importArchive(archive, options));
    } catch (error) {
      return archiveErrorResponse(error);
    }
  });

  router.register('POST', '/api/backups/archive/local/create', async (request) => {
    try {
      const body = await readJsonObject(request);
      const label = typeof body.label === 'string' ? body.label : 'Manual backup';
      return jsonResponse(await service.createBackup(label, readExportOptions(body)));
    } catch (error) {
      return archiveErrorResponse(error);
    }
  });

  router.register('POST', '/api/backups/archive/local/list', async () =>
    jsonResponse(await service.listBackups()),
  );

  router.register('POST', '/api/backups/archive/local/download', async (request) => {
    try {
      const body = await readJsonObject(request);
      const id = requiredId(body.id);
      const archive = await service.downloadBackup(id);
      return archive
        ? archiveResponse(archive, `pure-tavern-backup-${id}.zip`)
        : emptyResponse(404);
    } catch (error) {
      return archiveErrorResponse(error);
    }
  });

  router.register('POST', '/api/backups/archive/local/restore', async (request) => {
    try {
      const body = await readJsonObject(request);
      const id = requiredId(body.id);
      const options = readImportOptions(body);
      return jsonResponse(await service.restoreBackup(id, options));
    } catch (error) {
      return archiveErrorResponse(error);
    }
  });

  router.register('POST', '/api/backups/archive/local/delete', async (request) => {
    try {
      const body = await readJsonObject(request);
      await service.deleteBackup(requiredId(body.id));
      return emptyResponse(200);
    } catch (error) {
      return archiveErrorResponse(error);
    }
  });

  // TauriTavern（= SillyTavern 的 data 目录）互通。导入方向刻意复用同一条归档流水线，
  // 所以冲突预览、导入前恢复点和全部冲突策略在这里和原生归档完全一致。
  router.register('POST', '/api/backups/tauritavern/export', async (request) => {
    try {
      const options = readExportOptions(await readOptionalJson(request));
      const exported = await tauriTavern.exportPackage(options);
      return archiveResponse(exported.blob, exported.fileName, exported.migration);
    } catch (error) {
      return archiveErrorResponse(error);
    }
  });

  router.register('POST', '/api/backups/tauritavern/local/download', async (request) => {
    try {
      const body = await readJsonObject(request);
      const exported = await tauriTavern.exportBackupPackage(requiredId(body.id));
      return exported
        ? archiveResponse(exported.blob, exported.fileName, exported.migration)
        : emptyResponse(404);
    } catch (error) {
      return archiveErrorResponse(error);
    }
  });

  router.register('POST', '/api/backups/tauritavern/import/preview', async (request) => {
    try {
      const { archive, options } = await readImportForm(request);
      return jsonResponse(await tauriTavern.previewPackage(archive, options));
    } catch (error) {
      return archiveErrorResponse(error);
    }
  });

  router.register('POST', '/api/backups/tauritavern/import', async (request) => {
    try {
      const { archive, options } = await readImportForm(request);
      return jsonResponse(await tauriTavern.importPackage(archive, options));
    } catch (error) {
      return archiveErrorResponse(error);
    }
  });

  // Automatic per-chat JSONL backups are intentionally removable in M21. Keep the original
  // browser UI safe and empty while the complete manual archive remains the core capability.
  router.register('POST', '/api/backups/chat/get', () => jsonResponse([]));
  router.register('POST', '/api/backups/chat/download', () => emptyResponse(404));
  router.register('POST', '/api/backups/chat/delete', () => emptyResponse(404));
}

async function archiveResponse(
  archive: Blob,
  fileName: string,
  summary?: unknown,
): Promise<Response> {
  const bytes = await archive.arrayBuffer();
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(archive.size),
      'Content-Disposition': `attachment; filename="${fileName.replace(/["\\]/gu, '_')}"`,
      // 响应体就是 zip 本身，转换报告只能走 header。角色名带中文，必须先百分号编码。
      ...(summary === undefined
        ? {}
        : { 'X-PureTavern-Migration': encodeURIComponent(JSON.stringify(summary)) }),
    },
  });
}

async function readImportForm(
  request: Request,
): Promise<{ archive: Blob; options: ArchiveImportOptions }> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ArchiveValidationError(
      'invalid-form',
      'Archive import must use multipart form data.',
    );
  }
  const file = form.get('file');
  if (!(file instanceof Blob)) {
    throw new ArchiveValidationError('missing-file', 'Archive ZIP file is required.');
  }
  const moduleIds = parseModuleIds(form.get('modules'));
  return {
    archive: file,
    options: {
      ...(moduleIds ? { moduleIds } : {}),
      includeSecrets: form.get('includeSecrets') === 'true',
      strategy: normalizeStrategy(form.get('strategy')),
      createRecoveryPoint: form.get('createRecoveryPoint') !== 'false',
    },
  };
}

function readExportOptions(body: Record<string, unknown>): ArchiveExportOptions {
  const moduleIds = parseModuleIds(body.moduleIds);
  return {
    ...(moduleIds ? { moduleIds } : {}),
    includeSecrets: body.includeSecrets === true,
  };
}

function readImportOptions(body: Record<string, unknown>): ArchiveImportOptions {
  const moduleIds = parseModuleIds(body.moduleIds);
  return {
    ...(moduleIds ? { moduleIds } : {}),
    includeSecrets: body.includeSecrets === true,
    strategy: normalizeStrategy(body.strategy),
    createRecoveryPoint: body.createRecoveryPoint !== false,
  };
}

function parseModuleIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new ArchiveValidationError('invalid-modules', 'Module selection must be a JSON array.');
    }
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new ArchiveValidationError('invalid-modules', 'Module selection must be a string array.');
  }
  return [...new Set(parsed)];
}

async function readOptionalJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
    return value as Record<string, unknown>;
  } catch {
    throw new ArchiveValidationError('invalid-json', 'Request body must be a JSON object.');
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const body = await readOptionalJson(request);
  return body;
}

function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200) {
    throw new ArchiveValidationError('invalid-id', 'Backup id is required.');
  }
  return value;
}

function archiveErrorResponse(error: unknown): Response {
  if (error instanceof ArchiveValidationError || error instanceof TauriTavernFormatError) {
    return jsonResponse({ error: error.message, code: error.code, pureTavern: true }, 400);
  }
  return jsonResponse({ error: 'Archive operation failed.', pureTavern: true }, 500);
}
