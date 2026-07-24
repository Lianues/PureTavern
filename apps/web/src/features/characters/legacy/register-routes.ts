import type { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { jsonResponse, textResponse } from '@/platform/legacy/compatibility-router';

import {
  CharacterNotFoundError,
  CharacterValidationError,
} from '../application/character-validation';
import type { CharacterService } from '../application/character-service';

export function registerCharactersLegacyRoutes(
  router: CompatibilityRouter,
  characters: CharacterService,
) {
  router.register('POST', '/api/characters/all', async () =>
    jsonResponse(await characters.listCharacters()),
  );

  router.register('POST', '/api/characters/get', async (request) => {
    try {
      const body = await readJsonBody(request);
      return jsonResponse(await characters.getCharacter(body.avatar_url));
    } catch (error) {
      return characterErrorResponse(error, 400);
    }
  });

  router.register('POST', '/api/characters/chats', async () =>
    jsonResponse(await characters.listChats()),
  );

  router.register('POST', '/api/characters/create', async (request) => {
    try {
      const { fields, file } = await readLegacyBodyWithOptionalFile(request);
      const avatar = await characters.createCharacter(fields, file);
      return textResponse(avatar, 200);
    } catch (error) {
      return characterErrorResponse(error, 400);
    }
  });

  router.register('POST', '/api/characters/rename', async (request) => {
    try {
      const body = await readJsonBody(request);
      const avatar = await characters.renameCharacter(body.avatar_url, body.new_name);
      return jsonResponse({ avatar });
    } catch (error) {
      return characterErrorResponse(error, 400);
    }
  });

  router.register('POST', '/api/characters/edit', async (request) => {
    try {
      const { fields, file } = await readLegacyBodyWithOptionalFile(request);
      await characters.editCharacter(fields, file);
      return textResponse('OK', 200);
    } catch (error) {
      return characterErrorResponse(error, 400);
    }
  });

  router.register('POST', '/api/characters/edit-avatar', async (request) => {
    try {
      const { fields, file } = await readLegacyBodyWithOptionalFile(request);
      await characters.editAvatar(fields.avatar_url, file);
      return textResponse('OK', 200);
    } catch (error) {
      return characterErrorResponse(error, 400);
    }
  });

  router.register('POST', '/api/characters/edit-attribute', async (request) => {
    try {
      await characters.editAttribute(await readJsonBody(request));
      return textResponse('OK', 200);
    } catch (error) {
      return characterErrorResponse(error, 400);
    }
  });

  router.register('POST', '/api/characters/merge-attributes', async (request) => {
    try {
      const body = await readJsonBody(request);
      if (Array.isArray(body.avatars))
        return jsonResponse(await characters.mergeAttributesBulk(body));
      await characters.mergeAttributes(body);
      return textResponse('OK', 200);
    } catch (error) {
      return characterErrorResponse(error, 400);
    }
  });

  router.register('POST', '/api/characters/delete', async (request) => {
    try {
      const body = await readJsonBody(request);
      await characters.deleteCharacter(body.avatar_url, body.delete_chats === true);
      return textResponse('OK', 200);
    } catch (error) {
      return characterErrorResponse(error, 400);
    }
  });

  router.register('POST', '/api/characters/duplicate', async (request) => {
    try {
      const body = await readJsonBody(request);
      const path = await characters.duplicateCharacter(body.avatar_url);
      return jsonResponse({ path });
    } catch (error) {
      return characterErrorResponse(error, 400);
    }
  });

  router.register('POST', '/api/characters/import', async (request) => {
    try {
      const { fields, file } = await readLegacyBodyWithOptionalFile(request);
      if (!file) return jsonResponse({ error: true }, 400);
      const fileName = await characters.importCharacter(
        file,
        fields.file_type,
        fields.preserved_name,
      );
      return jsonResponse({ file_name: fileName });
    } catch (error) {
      console.error('Character import failed', error);
      return jsonResponse({ error: true });
    }
  });

  router.register('POST', '/api/characters/export', async (request) => {
    try {
      const body = await readJsonBody(request);
      const file = await characters.exportCharacter(body.avatar_url, body.format);
      return new Response(file.data, {
        status: 200,
        headers: {
          'Content-Type': file.contentType,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(file.fileName)}"`,
          'X-Pure-Tavern-Hook': '1',
        },
      });
    } catch (error) {
      return characterErrorResponse(error, 400);
    }
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const value = (await request.json()) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CharacterValidationError('Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

async function readLegacyBodyWithOptionalFile(
  request: Request,
): Promise<{ fields: Record<string, unknown>; file: Blob | null }> {
  const contentType = request.headers.get('content-type') ?? '';
  if (
    contentType.includes('multipart/form-data') ||
    contentType.includes('application/x-www-form-urlencoded')
  ) {
    const formData = await request.formData();
    return formDataToFields(formData);
  }
  const fields = await readJsonBody(request);
  return { fields, file: null };
}

function formDataToFields(formData: FormData): {
  fields: Record<string, unknown>;
  file: Blob | null;
} {
  const fields: Record<string, unknown> = {};
  let file: Blob | null = null;

  for (const [key, value] of formData.entries()) {
    if (value instanceof Blob) {
      if (key === 'avatar' && value.size > 0) file = value;
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      const current = fields[key];
      fields[key] = Array.isArray(current) ? [...current, value] : [current, value];
    } else {
      fields[key] = value;
    }
  }

  return { fields, file };
}

function characterErrorResponse(error: unknown, fallbackStatus: number): Response {
  const status =
    error instanceof CharacterNotFoundError
      ? 404
      : error instanceof CharacterValidationError
        ? 400
        : fallbackStatus;
  return jsonResponse(
    {
      error: error instanceof Error ? error.message : String(error),
      pureTavern: true,
    },
    status,
  );
}
