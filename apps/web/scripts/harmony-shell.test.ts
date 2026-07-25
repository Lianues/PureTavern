import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  discoverHarmonyTools,
  patchOptionalImageTranscoder,
  sanitizeHarmonyTools,
} from '../../harmony/scripts/harmony-toolchain.mjs';
import { harmonyReleaseAssetName, stageHarmonyHap } from '../../harmony/scripts/stage-hap.mjs';
import { syncWebAssets } from '../../harmony/scripts/sync-web-assets.mjs';
import { verifyHarmonySdk } from '../../harmony/scripts/verify-sdk.mjs';

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
      const signingPart = path.join(
        root,
        'command-line-tools',
        'hvigor',
        'res',
        'material',
        'fd',
        '0',
      );
      await mkdir(signingPart, { recursive: true });
      await writeFile(path.join(signingPart, 'key'), 'valid signing material');
      await writeFile(path.join(signingPart, '._key'), 'AppleDouble metadata');
      await writeFile(path.join(root, '.DS_Store'), 'Finder metadata');
      await expect(sanitizeHarmonyTools([root])).resolves.toBe(2);
      await expect(readdir(signingPart)).resolves.toEqual(['key']);

      const processResource = path.join(
        root,
        'command-line-tools',
        'hvigor',
        'hvigor-ohos-plugin',
        'src',
        'tasks',
        'process-resource.js',
      );
      await mkdir(path.dirname(processResource), { recursive: true });
      await writeFile(
        processResource,
        'const i={setExtensionPath(){}};const o=false;if(i.setExtensionPath(this.sdkInfo.getLibimageTranscoderShared()),o){run();}',
      );
      await expect(patchOptionalImageTranscoder([root])).resolves.toMatchObject({ patched: 1 });
      await expect(readFile(processResource, 'utf8')).resolves.toContain(
        'if(o){i.setExtensionPath(this.sdkInfo.getLibimageTranscoderShared());',
      );
      await expect(patchOptionalImageTranscoder([root])).resolves.toMatchObject({ patched: 0 });

      const tools = await discoverHarmonyTools([root]);
      expect(path.basename(tools.hvigor)).toBe('hmos-lite');
      expect(path.basename(tools.ohpm)).toBe('ohpm');

      const sdkRoot = path.join(root, 'command-line-tools', 'sdk', 'default');
      const projectRoot = path.join(root, 'project');
      await mkdir(sdkRoot, { recursive: true });
      await mkdir(projectRoot, { recursive: true });
      await writeFile(
        path.join(sdkRoot, 'sdk-pkg.json'),
        JSON.stringify({ data: { apiVersion: '23', platformVersion: '6.1.0' } }),
      );
      await writeFile(
        path.join(projectRoot, 'build-profile.json5'),
        "{ app: { products: [{ compileSdkVersion: '6.1.0(23)', compatibleSdkVersion: '6.1.0(23)', targetSdkVersion: '6.1.0(23)' }] } }",
      );
      await expect(
        verifyHarmonySdk({ hvigorPath: tools.hvigor, projectRoot }),
      ).resolves.toMatchObject({ installedTarget: '6.1.0(23)' });
      await writeFile(
        path.join(projectRoot, 'build-profile.json5'),
        "{ app: { products: [{ compileSdkVersion: '6.0.2(22)', compatibleSdkVersion: '6.0.2(22)', targetSdkVersion: '6.0.2(22)' }] } }",
      );
      await expect(verifyHarmonySdk({ hvigorPath: tools.hvigor, projectRoot })).rejects.toThrow(
        /CLI provides 6\.1\.0\(23\).*compile=6\.0\.2\(22\)/u,
      );

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
