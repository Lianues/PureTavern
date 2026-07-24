import type { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { emptyResponse, jsonResponse, textResponse } from '@/platform/legacy/compatibility-router';

import type { SecretService } from '../application/secret-service';
import { SecretValidationError } from '../domain/secret';

export function registerSecretsLegacyRoutes(
  router: CompatibilityRouter,
  secrets: SecretService,
): void {
  router.register('POST', '/api/secrets/write', async (request) => {
    try {
      const body = await readJsonBody(request);
      const key = requiredString(body.key, 'Credential key is required.');
      if (typeof body.value !== 'string') {
        throw new SecretValidationError('Credential value must be a string.');
      }
      const label =
        body.label === undefined ? 'Unlabeled' : requiredString(body.label, 'Label is required.');
      return jsonResponse({ id: await secrets.writeSecret(key, body.value, label) });
    } catch (error) {
      return secretErrorResponse(error);
    }
  });

  router.register('POST', '/api/secrets/read', async () =>
    jsonResponse(await secrets.getLegacyState()),
  );

  router.register('POST', '/api/secrets/view', async () =>
    jsonResponse(await secrets.viewActiveSecrets()),
  );

  router.register('POST', '/api/secrets/find', async (request) => {
    try {
      const body = await readJsonBody(request);
      const key = requiredString(body.key, 'Credential key is required.');
      const id = optionalString(body.id, 'Credential ID must be a string.');
      const value = await secrets.resolveCredential(key, id);
      return value === null ? textResponse('Not Found', 404) : jsonResponse({ value });
    } catch (error) {
      return secretErrorResponse(error);
    }
  });

  router.register('POST', '/api/secrets/delete', async (request) => {
    try {
      const body = await readJsonBody(request);
      const key = requiredString(body.key, 'Credential key is required.');
      const id = optionalString(body.id, 'Credential ID must be a string.');
      await secrets.deleteSecret(key, id);
      return emptyResponse();
    } catch (error) {
      return secretErrorResponse(error);
    }
  });

  router.register('POST', '/api/secrets/rotate', async (request) => {
    try {
      const body = await readJsonBody(request);
      const key = requiredString(body.key, 'Credential key is required.');
      const id = requiredString(body.id, 'Credential ID is required.');
      await secrets.rotateSecret(key, id);
      return emptyResponse();
    } catch (error) {
      return secretErrorResponse(error);
    }
  });

  router.register('POST', '/api/secrets/rename', async (request) => {
    try {
      const body = await readJsonBody(request);
      const key = requiredString(body.key, 'Credential key is required.');
      const id = requiredString(body.id, 'Credential ID is required.');
      const label = requiredString(body.label, 'Credential label is required.');
      await secrets.renameSecret(key, id, label);
      return emptyResponse();
    } catch (error) {
      return secretErrorResponse(error);
    }
  });

  router.register('POST', '/api/secrets/settings', () => jsonResponse({ allowKeysExposure: true }));
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = (await request.json()) as unknown;
  } catch {
    throw new SecretValidationError('Request body must be valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SecretValidationError('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new SecretValidationError(message);
  return value;
}

function optionalString(value: unknown, message: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new SecretValidationError(message);
  return value;
}

function secretErrorResponse(error: unknown): Response {
  if (error instanceof SecretValidationError) {
    return jsonResponse({ error: error.message, pureTavern: true }, 400);
  }
  return jsonResponse(
    {
      error: 'Local credential operation failed.',
      pureTavern: true,
    },
    500,
  );
}
