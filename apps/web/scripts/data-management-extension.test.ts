import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Pure Tavern data management first-party extension', () => {
  it('is declared as a separate first-party trusted Legacy extension with runtime assets', async () => {
    const [assets, manifestText, script, prepareScript] = await Promise.all([
      readFile('src/features/import-export/runtime-assets.json', 'utf8'),
      readFile('src/features/import-export/runtime/manifest.json', 'utf8'),
      readFile('src/features/import-export/runtime/index.js', 'utf8'),
      readFile('scripts/prepare-legacy-runtime.mjs', 'utf8'),
    ]);
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      display_name: 'Pure Tavern Data Management',
      js: 'index.js',
      css: 'style.css',
    });
    expect(assets).toContain('scripts/extensions/pure-tavern-data-management/index.js');
    expect(script).toContain('pure-tavern-data-management-dialog');
    expect(script).toContain('/api/backups/archive');
    expect(prepareScript).toContain("extensionId: 'pure-tavern.data-management'");
    expect(prepareScript).toContain("sourceKind: 'pure-tavern-first-party'");
  });
});
