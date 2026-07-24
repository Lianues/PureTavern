import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXTENSION_PACKAGE_LIMITS,
  ExtensionPackageValidationError,
  extractExtensionZip,
  validateLegacyExtensionPackage,
} from '../application/package-validator';
import { makeLegacyPackage } from './test-helpers';

describe('Legacy extension package validation', () => {
  it('accepts the original SillyTavern manifest shape and preserves opaque fields', async () => {
    const result = await validateLegacyExtensionPackage(makeLegacyPackage());

    expect(result.manifest).toMatchObject({
      display_name: 'Cocktail Test',
      js: 'index.js',
      css: 'style.css',
      dependencies: ['regex'],
      future_manifest_field: { kept: true },
    });
    expect(result.packageHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.files).toHaveLength(3);
  });

  it('rejects missing entry files and unsafe duplicate paths', async () => {
    const missing = makeLegacyPackage().filter((file) => file.path !== 'index.js');
    await expect(validateLegacyExtensionPackage(missing)).rejects.toMatchObject({
      code: 'missing-entrypoint',
    });

    await expect(
      validateLegacyExtensionPackage([
        ...makeLegacyPackage(),
        { path: 'INDEX.JS', data: new Blob(['duplicate']) },
      ]),
    ).rejects.toMatchObject({ code: 'duplicate-path' });
  });

  it('strips one archive root and validates the extracted package', async () => {
    const zip = zipSync({
      'cocktail-main/manifest.json': stringBytes(
        JSON.stringify({
          display_name: 'Cocktail',
          version: '1.0.0',
          author: 'Test',
          js: 'index.js',
        }),
      ),
      'cocktail-main/index.js': stringBytes('globalThis.__cocktail = true;'),
    });
    const files = await extractExtensionZip(bytesBlob(zip));
    const result = await validateLegacyExtensionPackage(files);

    expect(files.map((file) => file.path)).toEqual(['manifest.json', 'index.js']);
    expect(result.manifest.display_name).toBe('Cocktail');
  });

  it('rejects zip-slip entries before extraction', async () => {
    const zip = zipSync({
      'cocktail-main/manifest.json': stringBytes('{}'),
      'cocktail-main/../evil.js': stringBytes('evil'),
    });
    await expect(extractExtensionZip(bytesBlob(zip))).rejects.toBeInstanceOf(
      ExtensionPackageValidationError,
    );
  });

  it('rejects declared expansion ratios beyond the configured limit', async () => {
    const zip = zipSync({
      'cocktail-main/manifest.json': stringBytes(
        JSON.stringify({ display_name: 'Cocktail', js: 'index.js' }),
      ),
      'cocktail-main/index.js': new Uint8Array(512 * 1024),
    });
    await expect(
      extractExtensionZip(bytesBlob(zip), {
        ...DEFAULT_EXTENSION_PACKAGE_LIMITS,
        maxCompressionRatio: 5,
      }),
    ).rejects.toMatchObject({ code: 'compression-ratio' });
  });
});

function stringBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesBlob(value: Uint8Array): Blob {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return new Blob([copy.buffer], { type: 'application/zip' });
}
