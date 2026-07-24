import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

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
    <title>SillyTavern</title>
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
    expect(generated).toContain('<title>PureTavern</title>');
    expect(generated).not.toContain('<title>SillyTavern</title>');
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

  it('rejects missing or ambiguous Legacy title elements', () => {
    const withoutTitle = '<!doctype html><head></head><script src="lib/polyfill.js"></script>';
    const duplicateTitle =
      '<!doctype html><head><title>One</title><title>Two</title></head><script src="lib/polyfill.js"></script>';

    expect(() => generateHookedIndex(withoutTitle, '0123456789abcdef')).toThrow(
      'Expected exactly one Legacy title element, found 0.',
    );
    expect(() => generateHookedIndex(duplicateTitle, '0123456789abcdef')).toThrow(
      'Expected exactly one Legacy title element, found 2.',
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
    expect(prepare).toContain('copyBrandingAssets');
    expect(prepare).toContain('pure-tavern-favicon.ico');
  });

  it('contains optimized branding PNGs and a multi-resolution favicon', async () => {
    for (const size of [57, 72, 114, 144, 192, 512]) {
      const png = await readFile(`src/branding/apple-icon-${size}x${size}.png`);
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }

    const logo = await readFile('src/branding/pure-tavern-logo-330.png');
    expect(logo.readUInt32BE(16)).toBe(330);
    expect(logo.readUInt32BE(20)).toBe(330);

    const systemAvatar = decodeRgbaPng(
      await readFile('src/branding/pure-tavern-system-avatar.png'),
    );
    expect([systemAvatar.width, systemAvatar.height]).toEqual([400, 600]);
    expect(systemAvatar.alphaAt(0, 0)).toBe(0);
    expect(systemAvatar.alphaAt(399, 599)).toBe(0);
    expect(systemAvatar.alphaAt(200, 300)).toBe(255);

    const favicon = await readFile('src/branding/pure-tavern-favicon.ico');
    expect(favicon.readUInt16LE(0)).toBe(0);
    expect(favicon.readUInt16LE(2)).toBe(1);
    const count = favicon.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, index) => {
      const width = favicon[6 + index * 16] ?? 0;
      return width === 0 ? 256 : width;
    });
    expect(sizes).toEqual([16, 32, 48, 64, 128, 256]);
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

function decodeRgbaPng(png: Buffer): {
  width: number;
  height: number;
  alphaAt(x: number, y: number): number;
} {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(png[24]).toBe(8);
  expect(png[25]).toBe(6);
  expect(png[28]).toBe(0);

  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const source = raw[rowStart + 1 + x] ?? 0;
      const target = y * stride + x;
      const left = x >= bytesPerPixel ? (pixels[target - bytesPerPixel] ?? 0) : 0;
      const up = y > 0 ? (pixels[target - stride] ?? 0) : 0;
      const upLeft =
        y > 0 && x >= bytesPerPixel ? (pixels[target - stride - bytesPerPixel] ?? 0) : 0;
      pixels[target] = unfilterPngByte(filter, source, left, up, upLeft);
    }
  }
  return {
    width,
    height,
    alphaAt: (x, y) => pixels[y * stride + x * bytesPerPixel + 3] ?? 0,
  };
}

function unfilterPngByte(
  filter: number,
  value: number,
  left: number,
  up: number,
  upLeft: number,
): number {
  if (filter === 0) return value;
  if (filter === 1) return (value + left) & 0xff;
  if (filter === 2) return (value + up) & 0xff;
  if (filter === 3) return (value + Math.floor((left + up) / 2)) & 0xff;
  if (filter === 4) return (value + paethPredictor(left, up, upLeft)) & 0xff;
  throw new Error(`Unsupported PNG filter: ${filter}`);
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
  return upDistance <= diagonalDistance ? up : upLeft;
}
