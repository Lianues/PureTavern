import type { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { jsonResponse } from '@/platform/legacy/compatibility-router';

import {
  ChatConflictError,
  ChatIntegrityError,
  ChatNotFoundError,
  ChatService,
  ChatValidationError,
} from '../application/chat-service';
import { ChatImportError } from '../infrastructure/chat-import-export-adapter';

export function registerChatsLegacyRoutes(router: CompatibilityRouter, chats: ChatService): void {
  router.register('POST', '/api/chats/save', async (request) => {
    try {
      const body = await readJsonBody(request);
      await chats.saveChat({
        avatarUrl: body.avatar_url,
        characterName: body.ch_name,
        fileName: body.file_name,
        chat: body.chat,
        force: body.force,
      });
      return jsonResponse({ ok: true });
    } catch (error) {
      if (error instanceof ChatIntegrityError) return jsonResponse({ error: 'integrity' }, 400);
      return chatErrorResponse(error);
    }
  });

  router.register('POST', '/api/chats/get', async (request) => {
    try {
      const body = await readJsonBody(request);
      return jsonResponse(await chats.getChat(body.avatar_url, body.file_name));
    } catch (error) {
      return chatErrorResponse(error);
    }
  });

  router.register('POST', '/api/chats/rename', async (request) => {
    try {
      const body = await readJsonBody(request);
      if (body.is_group === true) return notMigratedGroupResponse();
      const result = await chats.renameChat(body.avatar_url, body.original_file, body.renamed_file);
      return jsonResponse({ ok: true, sanitizedFileName: result.sanitizedFileName });
    } catch (error) {
      return chatErrorResponse(error);
    }
  });

  router.register('POST', '/api/chats/delete', async (request) => {
    try {
      const body = await readJsonBody(request);
      await chats.deleteChat(body.avatar_url, body.chatfile);
      return jsonResponse({ ok: true });
    } catch (error) {
      return chatErrorResponse(error);
    }
  });

  router.register('POST', '/api/chats/export', async (request) => {
    try {
      const body = await readJsonBody(request);
      if (body.is_group === true) return notMigratedGroupResponse();
      return jsonResponse(
        await chats.exportChat({
          avatarUrl: body.avatar_url,
          fileName: body.file,
          exportFileName: body.exportfilename,
          format: body.format,
        }),
      );
    } catch (error) {
      return chatErrorResponse(error);
    }
  });

  router.register('POST', '/api/chats/import', async (request) => {
    try {
      const { fields, file } = await readFormBody(request);
      if (!file) throw new ChatValidationError('A chat import file is required.');
      const fileNames = await chats.importChats({
        avatarUrl: fields.avatar_url,
        characterName: fields.character_name,
        userName: fields.user_name,
        fileType: fields.file_type,
        file,
      });
      return jsonResponse({ res: true, fileNames });
    } catch (error) {
      return chatErrorResponse(error);
    }
  });

  router.register('POST', '/api/chats/search', async (request) => {
    try {
      const body = await readJsonBody(request);
      if (body.group_id !== null && body.group_id !== undefined) {
        return notMigratedGroupResponse();
      }
      return jsonResponse(await chats.searchChats(body.avatar_url, body.query));
    } catch (error) {
      return chatErrorResponse(error);
    }
  });

  router.register('POST', '/api/chats/recent', async (request) => {
    try {
      const body = await readJsonBody(request);
      return jsonResponse(await chats.recentChats(body.max, body.pinned, body.metadata === true));
    } catch (error) {
      return chatErrorResponse(error);
    }
  });

  router.register('POST', '/api/characters/chats', async (request) => {
    try {
      const body = await readJsonBody(request);
      return jsonResponse(
        await chats.listOwnerChats(body.avatar_url, {
          simple: body.simple === true,
          metadata: body.metadata === true,
        }),
      );
    } catch (error) {
      return chatErrorResponse(error);
    }
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readRequestText(request);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ChatValidationError(`Request body must be valid JSON: ${String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChatValidationError('Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

async function readRequestText(request: Request): Promise<string> {
  if (request.headers.get('content-encoding')?.toLocaleLowerCase() !== 'gzip') {
    return request.text();
  }
  if (!request.body || typeof DecompressionStream === 'undefined') {
    throw new ChatValidationError('Gzip request bodies are not supported in this browser.');
  }
  try {
    const stream = request.body.pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  } catch (error) {
    throw new ChatValidationError(`Could not decompress request body: ${String(error)}`);
  }
}

async function readFormBody(
  request: Request,
): Promise<{ fields: Record<string, string>; file: Blob | null }> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    throw new ChatValidationError(`Request body must be form data: ${String(error)}`);
  }
  const fields: Record<string, string> = {};
  let file: Blob | null = null;
  for (const [key, value] of formData.entries()) {
    if (value instanceof Blob) {
      if (!file && value.size > 0) file = value;
    } else {
      fields[key] = value;
    }
  }
  return { fields, file };
}

function chatErrorResponse(error: unknown): Response {
  const status =
    error instanceof ChatNotFoundError
      ? 404
      : error instanceof ChatConflictError ||
          error instanceof ChatValidationError ||
          error instanceof ChatImportError ||
          error instanceof TypeError
        ? 400
        : 500;
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse(
    error instanceof ChatNotFoundError ? { message } : { error: true, message, pureTavern: true },
    status,
  );
}

function notMigratedGroupResponse(): Response {
  return jsonResponse(
    {
      error: 'Group chats are not migrated by M05.',
      pureTavern: true,
    },
    501,
  );
}
