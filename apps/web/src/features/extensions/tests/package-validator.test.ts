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

  it('passes manifest script and style references through without requiring package entries', async () => {
    const manifest = {
      display_name: 'BaiBai Book',
      version: '1.1.6',
      js: 'dist/index.js?ver=1.1.6',
      css: 'dist/index.css#theme',
    };
    const result = await validateLegacyExtensionPackage([
      {
        path: 'manifest.json',
        data: new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
      },
    ]);

    expect(result.manifest.js).toBe('dist/index.js?ver=1.1.6');
    expect(result.manifest.css).toBe('dist/index.css#theme');
  });

  it('still rejects unsafe duplicate package paths', async () => {
    await expect(
      validateLegacyExtensionPackage([
        ...makeLegacyPackage(),
        { path: 'INDEX.JS', data: new Blob(['duplicate']) },
      ]),
    ).rejects.toMatchObject({ code: 'duplicate-path' });
  });

  it('accepts safe dotfiles, dot-directories and repeated dots inside names', async () => {
    const result = await validateLegacyExtensionPackage([
      ...makeLegacyPackage(),
      { path: '.gitignore', data: new Blob(['dist/']) },
      { path: '.github/workflows/ci.yml', data: new Blob(['name: CI']) },
      { path: 'src/file..name.js', data: new Blob(['export default true']) },
    ]);

    expect(result.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['.gitignore', '.github/workflows/ci.yml', 'src/file..name.js']),
    );
  });

  it.each([
    '../evil.js',
    'nested/../evil.js',
    'nested\\evil.js',
    'nested/%2e%2e/evil.js',
    'dist/index.js?ver=1.1.6',
  ])('rejects truly unsafe package path %s', async (path) => {
    await expect(
      validateLegacyExtensionPackage([...makeLegacyPackage(), { path, data: new Blob(['evil']) }]),
    ).rejects.toMatchObject({ code: 'unsafe-path' });
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
