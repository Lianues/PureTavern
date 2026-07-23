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
    <script defer src="lib/polyfill.js"></script>
  </head>
</html>`;

    const generated = generateHookedIndex(upstream);

    expect(countOccurrences(generated, hookMarker)).toBe(1);
    expect(generated.indexOf(hookMarker)).toBeLessThan(generated.indexOf('lib/polyfill.js'));
    expect(generated).toContain('GENERATED FROM legacy/upstream/public/index.html');
    expect(upstream).not.toContain(hookMarker);
  });

  it('rejects an upstream index when the stable injection anchor is absent', () => {
    expect(() => generateHookedIndex('<!doctype html><html></html>')).toThrow(
      'Expected exactly one Legacy script anchor, found 0.',
    );
  });

  it('rejects an upstream index when the injection anchor is ambiguous', () => {
    const upstream = `<!doctype html>
<script src="lib/polyfill.js"></script>
<script src="/lib/polyfill.js"></script>`;

    expect(() => generateHookedIndex(upstream)).toThrow(
      'Expected exactly one Legacy script anchor, found 2.',
    );
  });
});
