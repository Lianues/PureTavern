import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  extractExtensionZip,
  sha256Hex,
  validateLegacyExtensionPackage,
} from '../src/features/extensions/application/package-validator';
import type { BundledExtensionManifestEntry } from '../src/features/extensions/infrastructure/bundled-extension-seeder';

const bundledRoot = 'src/features/extensions/bundled-packages';

describe('bundled extension packages through the browser validator', () => {
  it('accepts every pinned Release archive with its original manifest and all files', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(bundledRoot, 'manifest.json'), 'utf8'),
    ) as {
      version: 1;
      extensions: BundledExtensionManifestEntry[];
    };
    const results: Array<{
      id: string;
      version: string;
      fileCount: number;
      archiveSha256: string;
    }> = [];

    for (const entry of manifest.extensions) {
      const bytes = await readFile(path.join(bundledRoot, entry.archiveFile));
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const archive = new Blob([copy.buffer], { type: 'application/zip' });
      const validated = await validateLegacyExtensionPackage(await extractExtensionZip(archive));
      results.push({
        id: entry.id,
        version: validated.manifest.version,
        fileCount: validated.fileCount,
        archiveSha256: await sha256Hex(archive),
      });
    }

    expect(results).toEqual([
      {
        id: 'js-slash-runner-4.8.19',
        version: '4.8.19',
        fileCount: 253,
        archiveSha256: '03c905748a1fdf469fe48246f499aec4b6000866ce0fc4b3dac16151e98d277f',
      },
      {
        id: 'st-prompt-template-1.16',
        version: '1.16.3.0',
        fileCount: 53,
        archiveSha256: '2d08ada234f1a7884e5d556ddcf28b9a88620600fa4694575ec79f06e979a943',
      },
    ]);
  });
});
