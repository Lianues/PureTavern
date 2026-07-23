import type { UpstreamMetadata } from './upstream-metadata';
import { type CompatibilityRouter, emptyResponse, jsonResponse } from './compatibility-router';

export function registerCoreLegacyRoutes(
  router: CompatibilityRouter,
  upstreamMetadata: Promise<UpstreamMetadata>,
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
