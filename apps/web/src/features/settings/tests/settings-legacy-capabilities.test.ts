import { describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '@/platform/features/capability-registry';
import {
  legacyExtensionSettingsCapability,
  legacyPersonaStateCapability,
} from '@/platform/features/standard-capabilities';
import { CompatibilityRouter } from '@/platform/legacy/compatibility-router';

import { SettingsService } from '../application/settings-service';
import { SettingsSnapshotService } from '../application/settings-snapshot-service';
import { MemorySettingsRepository } from '../infrastructure/resilient-settings-repository';
import { MemorySettingsSnapshotRepository } from '../infrastructure/resilient-settings-snapshot-repository';
import { registerSettingsLegacyRoutes } from '../legacy/register-routes';

describe('Settings Legacy feature composition', () => {
  it('hydrates Personas once and serializes Persona/Extension state through get and save', async () => {
    const settings = new SettingsService(new MemorySettingsRepository(), async () => ({
      username: 'User',
      user_avatar: 'user-default.png',
      extension_settings: { disabledExtensions: ['memory'] },
      power_user: { personas: {}, persona_descriptions: {}, unrelated: true },
    }));
    const snapshots = new SettingsSnapshotService(settings, new MemorySettingsSnapshotRepository());
    const capabilities = new CapabilityRegistry();
    let personaImports = 0;
    let disabledNames: string[] = [];

    capabilities.register(legacyPersonaStateCapability, {
      async importLegacyPersonaState() {
        personaImports += 1;
        return {};
      },
      async composeLegacyPersonaState(document) {
        return { ...(document as Record<string, unknown>), personaComposed: true };
      },
      async getLegacyPersonaState() {
        return { username: 'User', user_avatar: 'user-default.png', power_user: {} };
      },
      async getActiveLocalIdentity() {
        return {
          name: 'User',
          avatarAlias: 'user-default.png',
          personaId: null,
          fallback: true,
        };
      },
    });
    capabilities.register(legacyExtensionSettingsCapability, {
      async getDisabledLegacyNames() {
        return [...disabledNames];
      },
      async applyDisabledLegacyNames(names) {
        disabledNames = [...names];
      },
    });

    const router = new CompatibilityRouter();
    registerSettingsLegacyRoutes(router, settings, snapshots, capabilities);

    const first = await post(router, '/api/settings/get', {});
    const firstPayload = (await first.json()) as {
      settings: string;
      enable_extensions: boolean;
    };
    expect(firstPayload.enable_extensions).toBe(true);
    expect(JSON.parse(firstPayload.settings)).toMatchObject({
      personaComposed: true,
      extension_settings: { disabledExtensions: ['memory'] },
    });
    expect(personaImports).toBe(1);

    await post(router, '/api/settings/get', {});
    expect(personaImports).toBe(1);

    const save = await post(router, '/api/settings/save', {
      username: 'Browser Persona',
      user_avatar: 'browser-persona.png',
      extension_settings: { disabledExtensions: ['regex'] },
      power_user: {
        personas: { 'browser-persona.png': 'Browser Persona' },
        persona_descriptions: { 'browser-persona.png': { description: 'kept' } },
        unrelated: true,
      },
    });
    expect(save.ok).toBe(true);
    expect(personaImports).toBe(2);
    expect(disabledNames).toEqual(['regex']);
    await expect(settings.getSettings()).resolves.toMatchObject({
      personaComposed: true,
      extension_settings: { disabledExtensions: ['regex'] },
      power_user: { unrelated: true },
    });
  });
});

async function post(
  router: CompatibilityRouter,
  pathname: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const request = new Request(`https://app.example${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await router.dispatch(request, new URL(request.url));
  if (!response) throw new Error(`Route was not handled: ${pathname}`);
  return response;
}
