import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateDefaultAssetManifest } from './default-asset-manifest-generator.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('generateDefaultAssetManifest', () => {
  it('indexes only supported default backgrounds with stable source hashes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pure-tavern-assets-'));
    temporaryRoots.push(root);
    const backgrounds = path.join(root, 'backgrounds');
    await mkdir(backgrounds, { recursive: true });
    await writeFile(path.join(backgrounds, 'b.png'), Uint8Array.from([1, 2, 3]));
    await writeFile(path.join(backgrounds, 'a.jpg'), Uint8Array.from([4, 5, 6]));
    await writeFile(path.join(backgrounds, 'ignored.txt'), 'not an image', 'utf8');

    await expect(generateDefaultAssetManifest(root)).resolves.toEqual({
      version: 1,
      backgrounds: [
        { name: 'a.jpg', sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
        { name: 'b.png', sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      ],
    });
  });
});
