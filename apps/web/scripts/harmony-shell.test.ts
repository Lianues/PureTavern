import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverHarmonyTools } from '../../harmony/scripts/harmony-toolchain.mjs';
import { harmonyReleaseAssetName, stageHarmonyHap } from '../../harmony/scripts/stage-hap.mjs';
import { syncWebAssets } from '../../harmony/scripts/sync-web-assets.mjs';

async function temporaryRoot() {
  return mkdtemp(path.join(tmpdir(), 'pure-tavern-harmony-'));
}

describe('HarmonyOS NEXT shell tooling', () => {
  it('copies a production web build and emits deterministic rawfile manifests', async () => {
    const root = await temporaryRoot();
    try {
      const sourceRoot = path.join(root, 'dist');
      const targetRoot = path.join(root, 'rawfile', 'web');
      const manifestSource = path.join(root, 'generated', 'WebAssetManifest.ets');
      await mkdir(path.join(sourceRoot, 'scripts'), { recursive: true });
      await writeFile(path.join(sourceRoot, 'index.html'), '<title>PureTavern</title>');
      await writeFile(
        path.join(sourceRoot, 'pure-tavern-assets-service-worker.js'),
        'self.ready=1',
      );
      await writeFile(path.join(sourceRoot, 'scripts', 'app.js'), 'export const ready=true;');

      await expect(
        syncWebAssets({ sourceRoot, targetRoot, manifestSource }),
      ).resolves.toMatchObject({
        fileCount: 3,
        paths: ['index.html', 'pure-tavern-assets-service-worker.js', 'scripts/app.js'],
      });
      await expect(readFile(path.join(targetRoot, 'scripts', 'app.js'), 'utf8')).resolves.toContain(
        'ready=true',
      );
      await expect(readFile(manifestSource, 'utf8')).resolves.toContain('scripts/app.js');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('discovers the pinned Linux CLI layout and stages one normalized unsigned HAP', async () => {
    const root = await temporaryRoot();
    try {
      const bin = path.join(root, 'command-line-tools', 'bin');
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, 'hmos-lite'), '#!/bin/sh\n');
      await writeFile(path.join(bin, 'ohpm'), '#!/bin/sh\n');
      const tools = await discoverHarmonyTools([root]);
      expect(path.basename(tools.hvigor)).toBe('hmos-lite');
      expect(path.basename(tools.ohpm)).toBe('ohpm');

      const buildRoot = path.join(root, 'entry', 'build');
      const outputRoot = path.join(root, 'release');
      await mkdir(path.join(buildRoot, 'default', 'outputs', 'default'), { recursive: true });
      await writeFile(
        path.join(buildRoot, 'default', 'outputs', 'default', 'entry-default-unsigned.hap'),
        'hap',
      );
      const output = await stageHarmonyHap({ buildRoot, outputRoot, version: '1.2.3' });
      expect(path.basename(output)).toBe('PureTavern-1.2.3-harmonyos-next-arm64-unsigned.hap');
      expect(harmonyReleaseAssetName('0.1.0')).toBe(
        'PureTavern-0.1.0-harmonyos-next-arm64-unsigned.hap',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
