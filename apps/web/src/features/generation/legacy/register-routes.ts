import type { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { jsonResponse } from '@/platform/legacy/compatibility-router';

import type { GenerationService } from '../application/generation-service';
import { GenerationProviderError, type LegacyGenerationRequest } from '../domain/provider';

export function registerGenerationLegacyRoutes(
  router: CompatibilityRouter,
  generation: GenerationService,
): void {
  router.register('POST', '/api/backends/chat-completions/status', async (request) => {
    try {
      const body = await readJsonBody(request);
      return jsonResponse(await generation.listModels(body, request.signal));
    } catch (error) {
      return generationErrorResponse(error);
    }
  });

  router.register('POST', '/api/backends/chat-completions/generate', async (request) => {
    try {
      const body = await readJsonBody(request);
      return await generation.generate(body, request.signal);
    } catch (error) {
      return generationErrorResponse(error);
    }
  });

  router.register('POST', '/api/backends/chat-completions/bias', async (request) => {
    try {
      return jsonResponse(generation.createBiasMap(await request.json()));
    } catch (error) {
      return generationErrorResponse(error);
    }
  });
}

async function readJsonBody(request: Request): Promise<LegacyGenerationRequest> {
  let body: unknown;
  try {
    body = (await request.json()) as unknown;
  } catch (error) {
    throw new GenerationProviderError('invalid-request', 'Request body must be valid JSON.', 400, {
      cause: error,
    });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GenerationProviderError(
      'invalid-request',
      'Request body must be a JSON object.',
      400,
    );
  }
  return body as LegacyGenerationRequest;
}

function generationErrorResponse(error: unknown): Response {
  const providerError =
    error instanceof GenerationProviderError
      ? error
      : new GenerationProviderError('provider-error', 'Direct provider operation failed.', 502);
  return jsonResponse(
    {
      error: {
        message: providerError.message,
        code: providerError.code,
      },
      pureTavern: true,
    },
    providerError.status,
  );
}
