import type { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { jsonResponse, textResponse } from '@/platform/legacy/compatibility-router';

import { ExtensionPermissionError, type ExtensionService } from '../application/extension-service';
import { ExtensionPackageValidationError } from '../application/package-validator';
import { ExtensionConflictError, ExtensionNotFoundError } from '../ports/extension-registry';

const REMOTE_OPERATIONS = [
  ['POST', '/api/extensions/install', 'remote-git-install'],
  ['POST', '/api/extensions/update', 'remote-git-update'],
  ['POST', '/api/extensions/branches', 'remote-git-branches'],
  ['POST', '/api/extensions/switch', 'remote-git-switch'],
  ['POST', '/api/extensions/move', 'server-filesystem-move'],
] as const;

export function registerExtensionsLegacyRoutes(
  router: CompatibilityRouter,
  extensions: ExtensionService,
  ready: Promise<void> = Promise.resolve(),
): void {
  router.register('GET', '/api/extensions/discover', async () => {
    await ready;
    return jsonResponse(await extensions.legacyDiscover());
  });

  router.register('POST', '/api/extensions/version', async (request) => {
    try {
      await ready;
      const body = await readJsonBody(request);
      if (body.global === true) return unsupported('server-global-extension-version');
      return jsonResponse(await extensions.getLegacyVersion(requiredExtensionName(body)));
    } catch (error) {
      return extensionErrorResponse(error);
    }
  });

  router.register('POST', '/api/sd/comfy/workflows', () => jsonResponse([]));

  router.register('POST', '/api/extensions/delete', async (request) => {
    try {
      await ready;
      const body = await readJsonBody(request);
      if (body.global === true) return unsupported('server-global-extension-delete');
      const reference = requiredExtensionName(body);
      await extensions.removeByLegacyReference(reference);
      return textResponse(`Extension has been deleted: ${reference}`);
    } catch (error) {
      return extensionErrorResponse(error);
    }
  });

  for (const [method, path, operation] of REMOTE_OPERATIONS) {
    router.register(method, path, () => unsupported(operation));
  }
}

function unsupported(operation: string): Response {
  return jsonResponse(
    {
      error: 'unsupported',
      operation,
      reason:
        'This operation requires server-side Git, filesystem, process, or multi-user privileges that a browser-only app does not have.',
      pureTavern: true,
    },
    501,
  );
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const value = (await request.json()) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function requiredExtensionName(body: Record<string, unknown>): string {
  if (typeof body.extensionName !== 'string' || !body.extensionName.trim()) {
    throw new TypeError('A non-empty extensionName is required.');
  }
  return body.extensionName;
}

function extensionErrorResponse(error: unknown): Response {
  const status =
    error instanceof ExtensionNotFoundError
      ? 404
      : error instanceof ExtensionPermissionError
        ? 403
        : error instanceof ExtensionConflictError ||
            error instanceof ExtensionPackageValidationError ||
            error instanceof TypeError
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
