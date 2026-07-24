import type { CapabilityRegistry } from '@/platform/features/capability-registry';
import {
  legacyPresetBootstrapCapability,
  worldNamesCapability,
} from '@/platform/features/standard-capabilities';
import type { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { emptyResponse, jsonResponse, textResponse } from '@/platform/legacy/compatibility-router';

import {
  InvalidSettingsSnapshotNameError,
  SettingsSnapshotNotFoundError,
  type SettingsSnapshotService,
} from '../application/settings-snapshot-service';
import type { SettingsService } from '../application/settings-service';

export function registerSettingsLegacyRoutes(
  router: CompatibilityRouter,
  settings: SettingsService,
  snapshots: SettingsSnapshotService,
  capabilities: CapabilityRegistry,
) {
  router.register('POST', '/api/settings/get', async () => {
    const [presetData, worldNames] = await Promise.all([
      loadPresetBootstrapData(capabilities),
      loadWorldNames(capabilities),
    ]);
    return jsonResponse({
      settings: JSON.stringify(await settings.getSettings()),
      ...presetData,
      world_names: worldNames,
      enable_extensions: false,
      enable_extensions_auto_update: false,
      enable_accounts: false,
      request_compression: {
        enabled: false,
        minPayloadSize: 0,
        maxPayloadSize: 0,
        timeout: 0,
      },
    });
  });

  router.register('POST', '/api/settings/save', async (request) => {
    try {
      await settings.saveSettings(await request.json());
      return jsonResponse({ result: 'ok' });
    } catch (error) {
      return jsonResponse(
        {
          error: error instanceof Error ? error.message : String(error),
          pureTavern: true,
        },
        400,
      );
    }
  });

  router.register('POST', '/api/settings/get-snapshots', async () =>
    jsonResponse(await snapshots.listSnapshots()),
  );
  router.register('POST', '/api/settings/load-snapshot', async (request) => {
    try {
      const { name } = (await request.json()) as { name?: unknown };
      return textResponse(await snapshots.loadSnapshotContent(name));
    } catch (error) {
      return settingsSnapshotErrorResponse(error);
    }
  });
  router.register('POST', '/api/settings/make-snapshot', async () => {
    try {
      await snapshots.createSnapshot();
      return emptyResponse();
    } catch (error) {
      return settingsSnapshotErrorResponse(error);
    }
  });
  router.register('POST', '/api/settings/restore-snapshot', async (request) => {
    try {
      const { name } = (await request.json()) as { name?: unknown };
      await snapshots.restoreSnapshot(name);
      return emptyResponse();
    } catch (error) {
      return settingsSnapshotErrorResponse(error);
    }
  });
}

async function loadPresetBootstrapData(
  capabilities: CapabilityRegistry,
): Promise<Record<string, unknown>> {
  const provider = capabilities.get(legacyPresetBootstrapCapability);
  if (!provider) return {};
  try {
    return await provider.getLegacyBootstrapData();
  } catch (error) {
    console.warn('[PureTavern Settings] Preset bootstrap data is unavailable.', error);
    return {};
  }
}

async function loadWorldNames(capabilities: CapabilityRegistry): Promise<string[]> {
  const provider = capabilities.get(worldNamesCapability);
  if (!provider) return [];
  try {
    return await provider.listWorldNames();
  } catch (error) {
    console.warn('[PureTavern Settings] World Book names are unavailable.', error);
    return [];
  }
}

function settingsSnapshotErrorResponse(error: unknown): Response {
  const status =
    error instanceof InvalidSettingsSnapshotNameError
      ? 400
      : error instanceof SettingsSnapshotNotFoundError
        ? 404
        : 500;
  return jsonResponse(
    {
      error: error instanceof Error ? error.message : String(error),
      pureTavern: true,
    },
    status,
  );
}
