import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateBundledExtensionManifest } from './bundled-extension-manifest.mjs';

const temporaryRoots: string[] = [];
const bundledRoot = 'src/features/extensions/bundled-packages';

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('bundled extension Release snapshots', () => {
  it('pins the requested releases, commits and validated extension manifests', async () => {
    const manifest = await validateBundledExtensionManifest(bundledRoot);

    expect(
      manifest.extensions.map(
        ({ id, releaseTag, revision, folderName, manifestVersion, archiveSha256 }) => ({
          id,
          releaseTag,
          revision,
          folderName,
          manifestVersion,
          archiveSha256,
        }),
      ),
    ).toEqual([
      {
        id: 'js-slash-runner-4.8.19',
        releaseTag: '4.8.19',
        revision: '0e965f2f6be878031dbbfd0c2171fa49de10ecca',
        folderName: 'JS-Slash-Runner',
        manifestVersion: '4.8.19',
        archiveSha256: '03c905748a1fdf469fe48246f499aec4b6000866ce0fc4b3dac16151e98d277f',
      },
      {
        id: 'st-prompt-template-1.16',
        releaseTag: '1.16',
        revision: '191ba3bbe0cf47771c3fd2632a9e45730ef92121',
        folderName: 'ST-Prompt-Template',
        manifestVersion: '1.16.3.0',
        archiveSha256: '2d08ada234f1a7884e5d556ddcf28b9a88620600fa4694575ec79f06e979a943',
      },
    ]);
  });

  it('publishes exactly the pinned manifest and two archives as private runtime assets', async () => {
    const runtimeAssets = JSON.parse(
      await readFile('src/features/extensions/runtime-assets.json', 'utf8'),
    ) as { assets: Array<{ source: string; publicPath: string }> };

    expect(runtimeAssets.assets).toEqual([
      {
        source: 'bundled-packages/manifest.json',
        publicPath: '__pure_tavern/bundled-extensions/manifest.json',
      },
      {
        source: 'bundled-packages/js-slash-runner-4.8.19.zip',
        publicPath: '__pure_tavern/bundled-extensions/js-slash-runner-4.8.19.zip',
      },
      {
        source: 'bundled-packages/st-prompt-template-1.16.zip',
        publicPath: '__pure_tavern/bundled-extensions/st-prompt-template-1.16.zip',
      },
    ]);
  });

  it('rejects an archive whose bytes no longer match the committed manifest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pure-tavern-bundled-extensions-'));
    temporaryRoots.push(root);
    const source = JSON.parse(await readFile(path.join(bundledRoot, 'manifest.json'), 'utf8')) as {
      version: 1;
      extensions: Array<Record<string, unknown>>;
    };
    const entry = { ...source.extensions[1]!, archiveSha256: '0'.repeat(64) };
    await cp(
      path.join(bundledRoot, String(entry.archiveFile)),
      path.join(root, String(entry.archiveFile)),
    );
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({ version: 1, extensions: [entry] }),
      'utf8',
    );

    await expect(validateBundledExtensionManifest(root)).rejects.toThrow('SHA-256 mismatch');
  });
});
