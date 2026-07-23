import {
  InvalidSettingsSnapshotNameError,
  SettingsSnapshotNotFoundError,
  type SettingsSnapshotService,
} from '../../features/settings/application/settings-snapshot-service';
import type { SettingsService } from '../../features/settings/application/settings-service';
import type { UpstreamMetadata } from '../upstream-metadata';
import {
  type CompatibilityRouter,
  emptyResponse,
  jsonResponse,
  textResponse,
} from '../transport/compatibility-fetch';

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

export function registerBootstrapRoutes(
  router: CompatibilityRouter,
  upstreamMetadata: Promise<UpstreamMetadata>,
  settingsService: SettingsService,
  settingsSnapshots: SettingsSnapshotService,
) {
  router.register('GET', '/csrf-token', () => jsonResponse({ token: 'pure-tavern-local' }));
  router.register('GET', '/version', async () => {
    const metadata = await upstreamMetadata;
    return jsonResponse({
      agent: `PureTavern-LegacyHook/${metadata.version}`,
      pkgVersion: metadata.version,
      gitBranch: 'legacy-hook',
      gitRevision: 'local',
    });
  });
  router.register('POST', '/api/ping', () => emptyResponse());

  router.register('GET', '/api/users/me', () =>
    jsonResponse({
      handle: 'default-user',
      name: 'User',
      avatar: '/User Avatars/user-default.png',
      admin: true,
      password: false,
      created: 0,
    }),
  );
  router.register('POST', '/api/users/get', () =>
    jsonResponse([
      {
        handle: 'default-user',
        name: 'User',
        avatar: '/User Avatars/user-default.png',
        admin: true,
        password: false,
        created: 0,
      },
    ]),
  );

  router.register('POST', '/api/settings/get', async () =>
    jsonResponse({
      settings: JSON.stringify(await settingsService.getSettings()),
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
      await settingsService.saveSettings(await request.json());
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
    jsonResponse(await settingsSnapshots.listSnapshots()),
  );
  router.register('POST', '/api/settings/load-snapshot', async (request) => {
    try {
      const { name } = (await request.json()) as { name?: unknown };
      return textResponse(await settingsSnapshots.loadSnapshotContent(name));
    } catch (error) {
      return settingsSnapshotErrorResponse(error);
    }
  });
  router.register('POST', '/api/settings/make-snapshot', async () => {
    try {
      await settingsSnapshots.createSnapshot();
      return emptyResponse();
    } catch (error) {
      return settingsSnapshotErrorResponse(error);
    }
  });
  router.register('POST', '/api/settings/restore-snapshot', async (request) => {
    try {
      const { name } = (await request.json()) as { name?: unknown };
      await settingsSnapshots.restoreSnapshot(name);
      return emptyResponse();
    } catch (error) {
      return settingsSnapshotErrorResponse(error);
    }
  });

  router.register('POST', '/api/secrets/settings', () =>
    jsonResponse({ allowKeysExposure: false }),
  );
  router.register('POST', '/api/secrets/read', () => jsonResponse({}));

  router.register('GET', '/api/extensions/discover', () => jsonResponse([]));
  router.register('POST', '/api/horde/status', () => jsonResponse({ ok: false }));
  router.register('POST', '/api/horde/text-models', () => jsonResponse([]));
  router.register('POST', '/api/chats/recent', () => jsonResponse([]));
  router.register('POST', '/api/characters/all', () => jsonResponse([]));
  router.register('POST', '/api/groups/all', () => jsonResponse([]));
  router.register('POST', '/api/avatars/get', () => jsonResponse(['user-default.png']));
  router.register('POST', '/api/worldinfo/list', () => jsonResponse([]));
  router.register('POST', '/api/backgrounds/all', () => jsonResponse({ images: [], config: {} }));
  router.register('POST', '/api/backgrounds/folders', () =>
    jsonResponse({ folders: [], imageFolderMap: {} }),
  );
  router.register('POST', '/api/image-metadata/all', () => jsonResponse({ images: {} }));
  router.register('POST', '/api/stats/get', () => jsonResponse({}));
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
