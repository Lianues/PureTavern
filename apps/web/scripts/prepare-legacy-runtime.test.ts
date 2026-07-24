import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { generateHookedIndex } from './legacy-index-generator.mjs';

const hookMarker = 'data-pure-tavern-hook="bootstrap"';

function countOccurrences(source: string, target: string) {
  return source.split(target).length - 1;
}

describe('generateHookedIndex', () => {
  it('injects one Hook before the Legacy polyfill without changing the upstream input', () => {
    const upstream = `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="style.css">
    <link rel="stylesheet" href="https://cdn.example/external.css">
    <script defer src="lib/polyfill.js"></script>
    <script src="scripts/app.js?mode=test#entry"></script>
    <script src="https://cdn.example/external.js"></script>
  </head>
</html>`;

    const generated = generateHookedIndex(upstream, '0123456789abcdef');

    expect(countOccurrences(generated, hookMarker)).toBe(1);
    expect(generated.indexOf(hookMarker)).toBeLessThan(generated.indexOf('lib/polyfill.js'));
    expect(generated).toContain('GENERATED FROM legacy/upstream/public/index.html');
    expect(generated).toContain('/__pure_tavern/legacy-hook.js?v=0123456789abcdef');
    expect(generated).toContain('/__pure_tavern/runtime-marker.js?__pt_build=0123456789abcdef');
    expect(generated.indexOf('runtime-marker.js')).toBeLessThan(generated.indexOf('style.css'));
    expect(generated).toContain('href="style.css"');
    expect(generated).toContain('src="lib/polyfill.js"');
    expect(generated).toContain('src="scripts/app.js?mode=test#entry"');
    expect(generated).toContain('href="https://cdn.example/external.css"');
    expect(generated).toContain('src="https://cdn.example/external.js"');
    expect(upstream).not.toContain(hookMarker);
  });

  it('rejects an upstream index when the stable injection anchor is absent', () => {
    expect(() =>
      generateHookedIndex('<!doctype html><html><head></head></html>', '0123456789abcdef'),
    ).toThrow('Expected exactly one Legacy script anchor, found 0.');
  });

  it('rejects an upstream index when the injection anchor is ambiguous', () => {
    const upstream = `<!doctype html>
<head></head>
<script src="lib/polyfill.js"></script>
<script src="/lib/polyfill.js"></script>`;

    expect(() => generateHookedIndex(upstream, '0123456789abcdef')).toThrow(
      'Expected exactly one Legacy script anchor, found 2.',
    );
  });

  it('restores the historical lodash global through the generated lib entry', async () => {
    const [entry, prepare] = await Promise.all([
      readFile('scripts/legacy-lib-entry.mjs', 'utf8'),
      readFile('scripts/prepare-legacy-runtime.mjs', 'utf8'),
    ]);

    expect(entry).toContain('globalThis._ = lodash');
    expect(entry).toContain("export * from '../legacy/upstream/public/lib.js'");
    expect(prepare).toContain("'legacy-lib-entry.mjs'");
    expect(prepare).toContain('/assets/modern-*');
    expect(prepare).toContain('Cache-Control: public, max-age=31536000, immutable');
    expect(prepare).toContain('Cache-Control: no-cache, no-store, must-revalidate');
  });

  it('rejects unsafe build identifiers before generating executable HTML', () => {
    expect(() =>
      generateHookedIndex(
        '<!doctype html><head></head><script src="lib/polyfill.js"></script>',
        '../unsafe',
      ),
    ).toThrow('build ID');
  });
});
