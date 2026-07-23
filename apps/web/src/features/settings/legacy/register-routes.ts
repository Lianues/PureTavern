import type { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { emptyResponse, jsonResponse, textResponse } from '@/platform/legacy/compatibility-router';

import {
  InvalidSettingsSnapshotNameError,
  SettingsSnapshotNotFoundError,
  type SettingsSnapshotService,
} from '../application/settings-snapshot-service';
import type { SettingsService } from '../application/settings-service';

const EMPTY_PRESET_DATA = {
  koboldai_settings: [],
  koboldai_setting_names: [],
  world_names: [],
  novelai_settings: [],
  novelai_setting_names: [],
  openai_settings: [],
  openai_setting_names: [],
  textgenerationwebui_presets: [],
  textgenerationwebui_preset_names: [],
  themes: [],
  movingUIPresets: [],
  quickReplyPresets: [],
  instruct: [],
  context: [],
  sysprompt: [],
  reasoning: [],
};

export function registerSettingsLegacyRoutes(
  router: CompatibilityRouter,
  settings: SettingsService,
  snapshots: SettingsSnapshotService,
) {
  router.register('POST', '/api/settings/get', async () =>
    jsonResponse({
      settings: JSON.stringify(await settings.getSettings()),
      ...EMPTY_PRESET_DATA,
      enable_extensions: false,
      enable_extensions_auto_update: false,
      enable_accounts: false,
      request_compression: {
        enabled: false,
        minPayloadSize: 0,
        maxPayloadSize: 0,
        timeout: 0,
      },
    }),
  );

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
