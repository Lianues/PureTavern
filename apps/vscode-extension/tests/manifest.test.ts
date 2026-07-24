import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('PureTavern VS Code extension manifest', () => {
  it('uses one PT SVG for the Activity Bar and a singleton PureTavern editor tab', async () => {
    const [manifestText, svg, tabLightSvg, tabDarkSvg, source] = await Promise.all([
      readFile('package.json', 'utf8'),
      readFile('media/pt.svg', 'utf8'),
      readFile('media/pt-tab-light.svg', 'utf8'),
      readFile('media/pt-tab-dark.svg', 'utf8'),
      readFile('src/extension.ts', 'utf8'),
    ]);
    const manifest = JSON.parse(manifestText);

    expect(manifest).toMatchObject({
      name: 'pure-tavern',
      displayName: 'PureTavern',
      publisher: 'Lianues',
      author: { name: 'Limerence' },
      license: 'AGPL-3.0-only',
      repository: { url: 'https://github.com/Lianues/PureTavern.git' },
      categories: ['Other'],
    });
    expect(manifest.keywords).toContain('AI Chat');
    expect(manifest.contributes.viewsContainers.activitybar).toContainEqual(
      expect.objectContaining({ id: 'pureTavern', icon: 'media/pt.svg' }),
    );
    expect(manifest.contributes.views.pureTavern).toContainEqual(
      expect.objectContaining({ id: 'pureTavern.launcher' }),
    );
    expect(svg).toContain('fill="currentColor"');
    expect(tabLightSvg).toContain('fill="#4a4a4a"');
    expect(tabDarkSvg).toContain('fill="#c8c8c8"');
    expect(source).toContain("'PureTavern'");
    expect(source).toContain('this.#panel.reveal');
    expect(source).toContain("'media', 'pt-tab-light.svg'");
    expect(source).toContain("'media', 'pt-tab-dark.svg'");
    expect(source).toContain('portMapping');
  });
});
