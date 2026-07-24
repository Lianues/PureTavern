import type { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { jsonResponse, textResponse } from '@/platform/legacy/compatibility-router';

import { ExtensionPermissionError, type ExtensionService } from '../application/extension-service';
import { ExtensionPackageValidationError } from '../application/package-validator';
import { ExtensionSourceError } from '../infrastructure/cors-extension-source';
import { ExtensionConflictError, ExtensionNotFoundError } from '../ports/extension-registry';

export function registerExtensionsLegacyRoutes(
  router: CompatibilityRouter,
  extensions: ExtensionService,
  ready: Promise<void> = Promise.resolve(),
): void {
  router.register('GET', '/api/extensions/discover', async () => {
    await ready;
    return jsonResponse(await extensions.legacyDiscover());
  });

  router.register('POST', '/api/extensions/install', async (request) => {
    try {
      await ready;
      const body = await readJsonBody(request);
      const result = await extensions.installRemote(
        requiredString(body.url, 'url'),
        body.global === true ? 'global' : 'local',
        optionalString(body.branch),
        request.signal,
      );
      return jsonResponse(result);
    } catch (error) {
      return extensionErrorResponse(error);
    }
  });

  router.register('POST', '/api/extensions/version', async (request) => {
    try {
      await ready;
      const body = await readJsonBody(request);
      return jsonResponse(
        await extensions.getLegacyVersion(requiredExtensionName(body), request.signal),
      );
    } catch (error) {
      return extensionErrorResponse(error);
    }
  });

  router.register('POST', '/api/extensions/update', async (request) => {
    try {
      await ready;
      const body = await readJsonBody(request);
      return jsonResponse(
        await extensions.updateByLegacyReference(requiredExtensionName(body), request.signal),
      );
    } catch (error) {
      return extensionErrorResponse(error);
    }
  });

  router.register('POST', '/api/extensions/branches', async (request) => {
    try {
      await ready;
      const body = await readJsonBody(request);
      return jsonResponse(
        await extensions.listBranches(requiredExtensionName(body), request.signal),
      );
    } catch (error) {
      return extensionErrorResponse(error);
    }
  });

  router.register('POST', '/api/extensions/switch', async (request) => {
    try {
      await ready;
      const body = await readJsonBody(request);
      await extensions.switchBranch(
        requiredExtensionName(body),
        requiredString(body.branch, 'branch'),
        request.signal,
      );
      return new Response(null, { status: 204 });
    } catch (error) {
      return extensionErrorResponse(error);
    }
  });

  router.register('POST', '/api/extensions/move', async (request) => {
    try {
      await ready;
      const body = await readJsonBody(request);
      await extensions.moveScope(
        requiredExtensionName(body),
        requiredString(body.destination, 'destination'),
      );
      return new Response(null, { status: 204 });
    } catch (error) {
      return extensionErrorResponse(error);
    }
  });

  router.register('POST', '/api/extensions/delete', async (request) => {
    try {
      await ready;
      const body = await readJsonBody(request);
      const reference = requiredExtensionName(body);
      await extensions.removeByLegacyReference(reference);
      return textResponse(`Extension has been deleted: ${reference}`);
    } catch (error) {
      return extensionErrorResponse(error);
    }
  });

  router.register('POST', '/api/sd/comfy/workflows', () => jsonResponse([]));
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const value = (await request.json()) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function requiredExtensionName(body: Record<string, unknown>): string {
  return requiredString(body.extensionName, 'extensionName');
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`A non-empty ${field} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function extensionErrorResponse(error: unknown): Response {
  const status =
    error instanceof ExtensionNotFoundError
      ? 404
      : error instanceof ExtensionPermissionError
        ? 403
        : error instanceof ExtensionConflictError
          ? 409
          : error instanceof ExtensionPackageValidationError || error instanceof TypeError
            ? 400
            : error instanceof ExtensionSourceError
              ? error.code === 'rate-limit'
                ? 429
                : 502
              : 500;
  return jsonResponse(
    {
      error: error instanceof Error ? error.message : String(error),
      code:
        error instanceof ExtensionPackageValidationError || error instanceof ExtensionSourceError
          ? error.code
          : undefined,
      pureTavern: true,
    },
    status,
  );
}
