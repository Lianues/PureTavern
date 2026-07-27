import { describe, expect, it } from 'vitest';

import { CompatibilityRouter } from '@/platform/legacy/compatibility-router';

import { PresetSeedService } from '../application/preset-seed-service';
import { PresetService } from '../application/preset-service';
import { cloneJson, type PresetDocument, type PresetSeedManifest } from '../domain/preset';
import { MemoryPresetRepository } from '../infrastructure/resilient-preset-repository';
import { PresetLegacyBootstrapProvider } from '../legacy/bootstrap-data';
import { legacyApiIdToPresetType, registerPresetsLegacyRoutes } from '../legacy/register-routes';
import type { PresetSeedLoader } from '../ports/preset-seed-loader';

function createHarness(manifest: PresetSeedManifest<PresetDocument> = { version: 1, presets: [] }) {
  let nextId = 0;
  const repository = new MemoryPresetRepository(undefined, () => `route-${++nextId}`);
  const loader = new FixtureSeedLoader(manifest);
  const service = new PresetService(repository, new PresetSeedService(repository, loader));
  const router = new CompatibilityRouter();
  registerPresetsLegacyRoutes(router, service);
  return { router, service, loader };
}

async function dispatch(router: CompatibilityRouter, request: Request): Promise<Response> {
  const response = await router.dispatch(request, new URL(request.url));
  if (!response) throw new Error(`Route was not handled: ${request.method} ${request.url}`);
  return response;
}

function postJson(pathname: string, body: unknown): Request {
  return new Request(`https://example.test${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Presets Legacy routes', () => {
  it('maps all supported API IDs and aliases', () => {
    expect(legacyApiIdToPresetType('kobold')).toBe('kobold');
    expect(legacyApiIdToPresetType('koboldhorde')).toBe('kobold');
    expect(legacyApiIdToPresetType('novel')).toBe('novel');
    expect(legacyApiIdToPresetType('textgenerationwebui')).toBe('textgenerationwebui');
    expect(legacyApiIdToPresetType('openai')).toBe('openai');
    expect(legacyApiIdToPresetType('instruct')).toBe('instruct');
    expect(legacyApiIdToPresetType('context')).toBe('context');
    expect(legacyApiIdToPresetType('sysprompt')).toBe('sysprompt');
    expect(legacyApiIdToPresetType('reasoning')).toBe('reasoning');
    expect(() => legacyApiIdToPresetType('unknown')).toThrow('Unknown preset API ID');
  });

  it('implements generic save/delete/restore DTOs and current-default restore semantics', async () => {
    const { router, service, loader } = createHarness({
      version: 1,
      presets: [
        {
          type: 'kobold',
          name: 'Default Kobold',
          value: { temperature: 0.7, upstream: 1 },
          sourceHash: 'kobold-v1',
        },
      ],
    });

    const saved = await dispatch(
      router,
      postJson('/api/presets/save', {
        apiId: 'koboldhorde',
        name: '用户预设',
        preset: { temperature: 1.25, unknownSampler: { kept: true } },
      }),
    );
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual({ name: '用户预设' });
    await expect(service.get('kobold', '用户预设')).resolves.toMatchObject({
      value: { temperature: 1.25, unknownSampler: { kept: true } },
    });

    const restored = await dispatch(
      router,
      postJson('/api/presets/restore', { apiId: 'kobold', name: 'Default Kobold' }),
    );
    await expect(restored.json()).resolves.toEqual({
      isDefault: true,
      preset: { temperature: 0.7, upstream: 1 },
    });

    loader.manifest.presets[0] = {
      type: 'kobold',
      name: 'Default Kobold',
      value: { temperature: 0.8, upstream: 2 },
      sourceHash: 'kobold-v2',
    };
    const currentDefault = await dispatch(
      router,
      postJson('/api/presets/restore', { apiId: 'kobold', name: 'Default Kobold' }),
    );
    await expect(currentDefault.json()).resolves.toEqual({
      isDefault: true,
      preset: { temperature: 0.8, upstream: 2 },
    });

    const deleted = await dispatch(
      router,
      postJson('/api/presets/delete', { apiId: 'kobold', name: '用户预设' }),
    );
    expect(deleted.status).toBe(200);
    const missing = await dispatch(
      router,
      postJson('/api/presets/delete', { apiId: 'kobold', name: '用户预设' }),
    );
    expect(missing.status).toBe(404);

    const notDefault = await dispatch(
      router,
      postJson('/api/presets/restore', { apiId: 'kobold', name: 'Custom' }),
    );
    await expect(notDefault.json()).resolves.toEqual({ isDefault: false, preset: {} });
  });

  it('implements theme, quick-reply and moving UI routes with their Legacy delete behavior', async () => {
    const { router, service } = createHarness();

    const theme = {
      name: 'Midnight',
      custom_css: '.future { color: rebeccapurple; }',
      futureThemeField: [1, 2, 3],
    };
    expect((await dispatch(router, postJson('/api/themes/save', theme))).status).toBe(200);
    await expect(service.get('theme', 'Midnight')).resolves.toMatchObject({ value: theme });
    expect(
      (await dispatch(router, postJson('/api/themes/delete', { name: 'Midnight' }))).status,
    ).toBe(200);
    expect(
      (await dispatch(router, postJson('/api/themes/delete', { name: 'Midnight' }))).status,
    ).toBe(404);

    const quickReply = {
      version: 2,
      name: 'Roleplay Set',
      qrList: [{ id: 1, label: 'Wave', message: '*waves*', extension: true }],
      unknownRoot: { kept: true },
    };
    expect((await dispatch(router, postJson('/api/quick-replies/save', quickReply))).status).toBe(
      200,
    );
    await expect(service.get('quick-reply', 'Roleplay Set')).resolves.toMatchObject({
      value: quickReply,
    });
    expect(
      (await dispatch(router, postJson('/api/quick-replies/delete', { name: 'Roleplay Set' })))
        .status,
    ).toBe(200);
    expect(
      (await dispatch(router, postJson('/api/quick-replies/delete', { name: 'Roleplay Set' })))
        .status,
    ).toBe(200);

    const movingUi = {
      name: 'Desktop Layout',
      movingUIState: { drawer: { top: 1, left: 2 }, pluginPanel: { x: 99 } },
    };
    expect((await dispatch(router, postJson('/api/moving-ui/save', movingUi))).status).toBe(200);
    await expect(service.get('moving-ui', 'Desktop Layout')).resolves.toMatchObject({
      value: movingUi,
    });
  });

  it('accepts OpenAI presets larger than the former frontend-only 2 MiB quota', async () => {
    const { router, service } = createHarness();
    const largeExtensions = { payload: '狐'.repeat(1_100_000) };
    const preset = {
      prompts: [{ identifier: 'main', name: 'Main', content: 'Test' }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
      extensions: largeExtensions,
    };

    const saved = await dispatch(
      router,
      postJson('/api/presets/save', {
        apiId: 'openai',
        name: '[主预设] V16.1 狐神抚 · 毓忻',
        preset,
      }),
    );

    expect(saved.status).toBe(200);
    await expect(service.get('openai', '[主预设] V16.1 狐神抚 · 毓忻')).resolves.toMatchObject({
      value: preset,
    });
  });

  it('returns 400 for malformed JSON, missing names, invalid documents and unknown API IDs', async () => {
    const { router } = createHarness();
    const malformed = await dispatch(
      router,
      new Request('https://example.test/api/presets/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
    );
    expect(malformed.status).toBe(400);
    expect(
      (
        await dispatch(
          router,
          postJson('/api/presets/save', { apiId: 'unknown', name: 'X', preset: {} }),
        )
      ).status,
    ).toBe(400);
    expect((await dispatch(router, postJson('/api/themes/save', { custom_css: '' }))).status).toBe(
      400,
    );
    expect(
      (
        await dispatch(
          router,
          postJson('/api/presets/save', {
            apiId: 'openai',
            name: 'Array',
            preset: [],
          }),
        )
      ).status,
    ).toBe(400);
  });
});

describe('Preset Legacy bootstrap provider', () => {
  it('returns completion presets as JSON strings and named presets as parsed objects', async () => {
    const service = new PresetService(
      new MemoryPresetRepository(
        undefined,
        (() => {
          let index = 0;
          return () => `bootstrap-${++index}`;
        })(),
      ),
    );
    await service.save('kobold', 'Zulu', { temperature: 1, opaque: 'z' });
    await service.save('kobold', 'Alpha', { temperature: 0, opaque: 'a' });
    await service.save('novel', 'Novel', { phrase_rep_pen: 2 });
    await service.save('openai', 'OpenAI', { prompts: [{ identifier: 'main' }] });
    await service.save('textgenerationwebui', 'TextGen', { temperature: 0.9 });
    await service.save('instruct', 'Instruct', { name: 'Instruct', system_sequence: 'SYS' });
    await service.save('context', 'Context', { name: 'Context', story_string: '{{story}}' });
    await service.save('sysprompt', 'System', { name: 'System', content: 'Act' });
    await service.save('reasoning', 'Reasoning', { name: 'Reasoning', prefix: '<think>' });
    await service.save('theme', 'Theme', { name: 'Theme', custom_css: '' });
    await service.save('moving-ui', 'Layout', { name: 'Layout', movingUIState: {} });
    await service.save('quick-reply', 'Quick', { name: 'Quick', qrList: [] });

    const data = await new PresetLegacyBootstrapProvider(service).getLegacyBootstrapData();
    expect(data.koboldai_setting_names).toEqual(['Alpha', 'Zulu']);
    expect(data.koboldai_settings).toEqual([
      JSON.stringify({ temperature: 0, opaque: 'a' }),
      JSON.stringify({ temperature: 1, opaque: 'z' }),
    ]);
    expect(data.novelai_setting_names).toEqual(['Novel']);
    expect(data.novelai_settings[0]).toBe(JSON.stringify({ phrase_rep_pen: 2 }));
    expect(data.openai_setting_names).toEqual(['OpenAI']);
    expect(typeof data.openai_settings[0]).toBe('string');
    expect(data.textgenerationwebui_preset_names).toEqual(['TextGen']);
    expect(typeof data.textgenerationwebui_presets[0]).toBe('string');

    expect(data.instruct).toEqual([{ name: 'Instruct', system_sequence: 'SYS' }]);
    expect(data.context).toEqual([{ name: 'Context', story_string: '{{story}}' }]);
    expect(data.sysprompt).toEqual([{ name: 'System', content: 'Act' }]);
    expect(data.reasoning).toEqual([{ name: 'Reasoning', prefix: '<think>' }]);
    expect(data.themes).toEqual([{ name: 'Theme', custom_css: '' }]);
    expect(data.movingUIPresets).toEqual([{ name: 'Layout', movingUIState: {} }]);
    expect(data.quickReplyPresets).toEqual([{ name: 'Quick', qrList: [] }]);
    expect(JSON.stringify(data)).not.toContain('userModified');
  });
});

class FixtureSeedLoader implements PresetSeedLoader {
  manifest: PresetSeedManifest<PresetDocument>;

  constructor(manifest: PresetSeedManifest<PresetDocument>) {
    this.manifest = cloneJson(manifest);
  }

  async load(): Promise<PresetSeedManifest<PresetDocument>> {
    return cloneJson(this.manifest);
  }
}
