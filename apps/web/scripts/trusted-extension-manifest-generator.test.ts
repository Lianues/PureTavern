import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateTrustedExtensionManifest } from './trusted-extension-manifest-generator.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('generateTrustedExtensionManifest', () => {
  it('derives trusted built-ins from the selected upstream snapshot', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pure-tavern-extensions-'));
    temporaryRoots.push(root);
    const extensionRoot = path.join(root, 'scripts', 'extensions', 'browser-probe');
    await mkdir(extensionRoot, { recursive: true });
    await writeFile(path.join(extensionRoot, 'index.js'), 'export const ready = true;\n', 'utf8');
    await writeFile(
      path.join(extensionRoot, 'manifest.json'),
      JSON.stringify({
        display_name: 'Browser Probe',
        js: 'index.js',
        version: '1.2.3',
        author: 'PureTavern',
      }),
      'utf8',
    );

    const manifest = await generateTrustedExtensionManifest(root);

    expect(manifest).toEqual({
      version: 1,
      extensions: [
        expect.objectContaining({
          extensionId: 'legacy.builtin.browser-probe',
          legacyName: 'browser-probe',
          displayName: 'Browser Probe',
          version: '1.2.3',
          author: 'PureTavern',
          scriptPath: '/scripts/extensions/browser-probe/index.js',
          sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ],
    });
  });

  it('rejects a trusted manifest that changes the audited entry path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pure-tavern-extensions-'));
    temporaryRoots.push(root);
    const extensionRoot = path.join(root, 'scripts', 'extensions', 'unsafe-probe');
    await mkdir(extensionRoot, { recursive: true });
    await writeFile(
      path.join(extensionRoot, 'manifest.json'),
      JSON.stringify({ display_name: 'Unsafe', js: 'other.js' }),
      'utf8',
    );

    await expect(generateTrustedExtensionManifest(root)).rejects.toThrow('audited index.js entry');
  });
});
