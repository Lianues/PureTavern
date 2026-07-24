import type { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { jsonResponse, textResponse } from '@/platform/legacy/compatibility-router';

import type { PresetService } from '../application/preset-service';
import {
  PresetConflictError,
  PresetNotFoundError,
  PresetValidationError,
} from '../application/preset-validation';
import type { PresetType } from '../domain/preset';

const API_ID_TO_TYPE: Readonly<Record<string, PresetType>> = {
  kobold: 'kobold',
  koboldhorde: 'kobold',
  novel: 'novel',
  textgenerationwebui: 'textgenerationwebui',
  openai: 'openai',
  instruct: 'instruct',
  context: 'context',
  sysprompt: 'sysprompt',
  reasoning: 'reasoning',
};

export function registerPresetsLegacyRoutes(
  router: CompatibilityRouter,
  presets: PresetService,
): void {
  router.register('POST', '/api/presets/save', async (request) => {
    try {
      const body = await readJsonObject(request);
      const type = legacyApiIdToPresetType(body.apiId);
      const name = await presets.save(type, body.name as string, body.preset);
      return jsonResponse({ name });
    } catch (error) {
      return presetErrorResponse(error);
    }
  });

  router.register('POST', '/api/presets/delete', async (request) => {
    try {
      const body = await readJsonObject(request);
      await presets.delete(legacyApiIdToPresetType(body.apiId), body.name as string);
      return textResponse('OK', 200);
    } catch (error) {
      return presetErrorResponse(error);
    }
  });

  router.register('POST', '/api/presets/restore', async (request) => {
    try {
      const body = await readJsonObject(request);
      return jsonResponse(
        await presets.restore(legacyApiIdToPresetType(body.apiId), body.name as string),
      );
    } catch (error) {
      return presetErrorResponse(error);
    }
  });

  router.register('POST', '/api/themes/save', async (request) => {
    try {
      const theme = await readJsonObject(request);
      await presets.save('theme', theme.name as string, theme);
      return textResponse('OK', 200);
    } catch (error) {
      return presetErrorResponse(error);
    }
  });

  router.register('POST', '/api/themes/delete', async (request) => {
    try {
      const body = await readJsonObject(request);
      await presets.delete('theme', body.name as string);
      return textResponse('OK', 200);
    } catch (error) {
      return presetErrorResponse(error);
    }
  });

  router.register('POST', '/api/quick-replies/save', async (request) => {
    try {
      const quickReply = await readJsonObject(request);
      await presets.save('quick-reply', quickReply.name as string, quickReply);
      return textResponse('OK', 200);
    } catch (error) {
      return presetErrorResponse(error);
    }
  });

  router.register('POST', '/api/quick-replies/delete', async (request) => {
    try {
      const body = await readJsonObject(request);
      await presets.delete('quick-reply', body.name as string, { requireExisting: false });
      return textResponse('OK', 200);
    } catch (error) {
      return presetErrorResponse(error);
    }
  });

  router.register('POST', '/api/moving-ui/save', async (request) => {
    try {
      const movingUi = await readJsonObject(request);
      await presets.save('moving-ui', movingUi.name as string, movingUi);
      return textResponse('OK', 200);
    } catch (error) {
      return presetErrorResponse(error);
    }
  });
}

export function legacyApiIdToPresetType(value: unknown): PresetType {
  if (typeof value !== 'string' || !API_ID_TO_TYPE[value]) {
    throw new PresetValidationError(`Unknown preset API ID: ${String(value)}`);
  }
  return API_ID_TO_TYPE[value];
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = (await request.json()) as unknown;
  } catch {
    throw new PresetValidationError('Request body must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PresetValidationError('Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function presetErrorResponse(error: unknown): Response {
  const status =
    error instanceof PresetNotFoundError
      ? 404
      : error instanceof PresetValidationError || error instanceof PresetConflictError
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
