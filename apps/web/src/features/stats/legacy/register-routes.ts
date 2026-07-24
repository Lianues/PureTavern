import type { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { emptyResponse, jsonResponse } from '@/platform/legacy/compatibility-router';

import type { StatsService } from '../application/stats-service';
import { StatsValidationError } from '../domain/stats';

export function registerStatsLegacyRoutes(router: CompatibilityRouter, stats: StatsService): void {
  router.register('POST', '/api/stats/get', async () => jsonResponse(await stats.get()));

  router.register('POST', '/api/stats/update', async (request) => {
    try {
      await stats.update(await readJsonBody(request));
      return emptyResponse(200);
    } catch (error) {
      return statsErrorResponse(error);
    }
  });

  router.register('POST', '/api/stats/recreate', async () => {
    try {
      await stats.recreate();
      return emptyResponse(200);
    } catch (error) {
      return statsErrorResponse(error);
    }
  });
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new StatsValidationError('Request body must be valid JSON.');
  }
}

function statsErrorResponse(error: unknown): Response {
  if (error instanceof StatsValidationError) {
    return jsonResponse({ error: error.message, pureTavern: true }, 400);
  }
  return jsonResponse(
    {
      error: 'Local stats operation failed.',
      pureTavern: true,
    },
    500,
  );
}
