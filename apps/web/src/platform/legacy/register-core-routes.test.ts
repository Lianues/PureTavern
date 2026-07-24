import { describe, expect, it } from 'vitest';

import { CompatibilityRouter } from './compatibility-router';
import { registerCoreLegacyRoutes } from './register-core-routes';

const metadata = {
  project: 'SillyTavern',
  version: '1.18.0',
  upstreamRepository: 'https://github.com/SillyTavern/SillyTavern',
  syncedAt: '2026-07-23T00:00:00.000Z',
  fileCount: 591,
};

describe('core Legacy routes', () => {
  it('returns the colon-delimited agent expected by Legacy client version parsing', async () => {
    const router = new CompatibilityRouter();
    registerCoreLegacyRoutes(router, Promise.resolve(metadata));
    const request = new Request('https://pure-tavern.test/version');
    const response = await router.dispatch(request, new URL(request.url));
    const payload = (await response?.json()) as { agent?: string; pkgVersion?: string };

    expect(payload).toMatchObject({
      agent: 'SillyTavern:1.18.0:PureTavern',
      pkgVersion: '1.18.0',
    });
    expect(payload.agent?.split(':')[1]).toBe('1.18.0');
  });
});
