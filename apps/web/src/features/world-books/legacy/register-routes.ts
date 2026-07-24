import type { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { jsonResponse, textResponse } from '@/platform/legacy/compatibility-router';

import type { WorldBookService } from '../application/world-book-service';
import {
  WorldBookNotFoundError,
  WorldBookValidationError,
} from '../application/world-book-validation';

export function registerWorldBooksLegacyRoutes(
  router: CompatibilityRouter,
  worldBooks: WorldBookService,
) {
  router.register('POST', '/api/worldinfo/list', async () =>
    jsonResponse(await worldBooks.listWorldBooks()),
  );

  router.register('POST', '/api/worldinfo/get', async (request) => {
    try {
      const body = await readJsonBody(request);
      return jsonResponse(await worldBooks.getWorldBook(body.name));
    } catch (error) {
      return worldBookErrorResponse(error);
    }
  });

  router.register('POST', '/api/worldinfo/edit', async (request) => {
    try {
      const body = await readJsonBody(request);
      await worldBooks.editWorldBook(body.name, body.data);
      return jsonResponse({ ok: true });
    } catch (error) {
      return worldBookErrorResponse(error);
    }
  });

  router.register('POST', '/api/worldinfo/delete', async (request) => {
    try {
      const body = await readJsonBody(request);
      await worldBooks.deleteWorldBook(body.name);
      return textResponse('OK', 200);
    } catch (error) {
      return worldBookErrorResponse(error);
    }
  });

  router.register('POST', '/api/worldinfo/import', async (request) => {
    try {
      const formData = await request.formData();
      const avatar = formData.get('avatar');
      if (!avatar || typeof avatar === 'string') {
        throw new WorldBookValidationError('World Book import requires an avatar file.');
      }
      const name = await worldBooks.importWorldBook(avatar, formData.get('convertedData'));
      return jsonResponse({ name });
    } catch (error) {
      return worldBookErrorResponse(error);
    }
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = (await request.json()) as unknown;
  } catch {
    throw new WorldBookValidationError('Request body must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorldBookValidationError('Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function worldBookErrorResponse(error: unknown): Response {
  const status =
    error instanceof WorldBookNotFoundError
      ? 404
      : error instanceof WorldBookValidationError
        ? 400
        : 500;
  return jsonResponse(
    {
      error: error instanceof Error ? error.message : String(error),
      pureTavern: true,
    },
    status,
  );
}
