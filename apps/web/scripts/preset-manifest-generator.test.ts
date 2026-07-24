import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generatePresetSeedManifest, PRESET_SEED_SOURCES } from './preset-manifest-generator.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('generatePresetSeedManifest', () => {
  it('maps upstream directories to stable preset types, names and content hashes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pure-tavern-presets-'));
    temporaryRoots.push(root);

    for (const [type, relativeDirectory] of PRESET_SEED_SOURCES) {
      const directory = path.join(root, ...relativeDirectory.split('/'));
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, `${type} example.json`),
        JSON.stringify({ name: `${type} example`, nested: { enabled: true } }),
        'utf8',
      );
    }

    const manifest = await generatePresetSeedManifest(root);

    expect(manifest.version).toBe(1);
    expect(manifest.presets).toHaveLength(PRESET_SEED_SOURCES.length);
    expect(manifest.presets).toContainEqual(
      expect.objectContaining({
        type: 'textgenerationwebui',
        name: 'textgenerationwebui example',
        value: { name: 'textgenerationwebui example', nested: { enabled: true } },
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
    expect(manifest.presets).toContainEqual(
      expect.objectContaining({ type: 'quick-reply', name: 'quick-reply example' }),
    );
    expect(manifest.presets).toContainEqual(
      expect.objectContaining({ type: 'theme', name: 'theme example' }),
    );
  });
});
