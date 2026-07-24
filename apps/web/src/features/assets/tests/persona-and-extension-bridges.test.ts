import { describe, expect, it } from 'vitest';

import { blobFromBytes, createMemoryHarness, pngBlob } from './test-helpers';

function textBlob(value: string, type: string): Blob {
  return blobFromBytes(new TextEncoder().encode(value), type);
}

describe('Assets cross-feature bridges', () => {
  it('owns Persona avatar aliases without copying storage into M08', async () => {
    const { service } = createMemoryHarness();

    expect(await service.hasAvatar('user-default.png')).toBe(true);
    const created = await service.uploadAvatar(pngBlob(), 'persona-a.png');
    expect(created).toBe('persona-a.png');
    expect(await service.hasAvatar(created)).toBe(true);

    const moved = await service.renameAvatar(created, 'persona-b.png');
    expect(moved).toBe('persona-b.png');
    expect(await service.hasAvatar('persona-a.png')).toBe(false);
    expect(await service.hasAvatar(moved)).toBe(true);

    await service.uploadAvatar(pngBlob(), moved, moved);
    await service.deleteAvatar(moved);
    expect(await service.hasAvatar(moved)).toBe(false);
  });

  it('stores validated extension package files behind M13 aliases', async () => {
    const { service } = createMemoryHarness();
    const extensionId = 'local.browser-probe';

    await service.saveExtensionPackage({
      extensionId,
      legacyName: 'third-party/browser-probe',
      packageHash: 'a'.repeat(64),
      installedAt: new Date().toISOString(),
      files: [
        {
          path: 'index.html',
          data: textBlob('<!doctype html><title>probe</title>', 'text/html'),
          sha256: 'b'.repeat(64),
        },
        {
          path: 'worker/index.js',
          data: textBlob('self.postMessage("ready")', 'text/javascript'),
          sha256: 'c'.repeat(64),
        },
        {
          path: '.github/workflows/ci.yml',
          data: textBlob('name: CI', 'text/yaml'),
          sha256: 'd'.repeat(64),
        },
        {
          path: '.gitignore',
          data: textBlob('dist/', 'text/plain'),
          sha256: 'e'.repeat(64),
        },
        {
          path: 'src/file..name.js',
          data: textBlob('export default true;', 'text/javascript'),
          sha256: 'f'.repeat(64),
        },
      ],
    });

    const htmlUrl = await service.resolveExtensionPackageAssetUrl(extensionId, 'index.html');
    const workerUrl = await service.resolveExtensionPackageAssetUrl(extensionId, 'worker/index.js');
    expect(htmlUrl).toBe('/scripts/extensions/third-party/browser-probe/index.html');
    expect(workerUrl).toBe('/scripts/extensions/third-party/browser-probe/worker/index.js');
    expect((await service.getAssetByPath(workerUrl!))?.blob.data.size).toBeGreaterThan(0);
    expect(
      await service.resolveExtensionPackageAssetUrl(extensionId, '.github/workflows/ci.yml'),
    ).toBe('/scripts/extensions/third-party/browser-probe/.github/workflows/ci.yml');
    expect(await service.resolveExtensionPackageAssetUrl(extensionId, '.gitignore')).toBe(
      '/scripts/extensions/third-party/browser-probe/.gitignore',
    );
    expect(await service.resolveExtensionPackageAssetUrl(extensionId, 'src/file..name.js')).toBe(
      '/scripts/extensions/third-party/browser-probe/src/file..name.js',
    );

    await service.saveExtensionPackage({
      extensionId,
      legacyName: 'third-party/browser-probe',
      packageHash: 'd'.repeat(64),
      installedAt: new Date().toISOString(),
      files: [
        {
          path: 'index.html',
          data: textBlob('<!doctype html><title>updated</title>', 'text/html'),
          sha256: 'e'.repeat(64),
        },
      ],
    });
    expect(
      await service.resolveExtensionPackageAssetUrl(extensionId, 'worker/index.js'),
    ).toBeNull();

    await service.removeExtensionPackage(extensionId);
    expect(await service.resolveExtensionPackageAssetUrl(extensionId, 'index.html')).toBeNull();
  });
});
