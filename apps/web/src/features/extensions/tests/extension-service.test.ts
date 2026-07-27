import { describe, expect, it } from 'vitest';

import { ExtensionService, ExtensionPermissionError } from '../application/extension-service';
import { MemoryExtensionRegistry } from '../infrastructure/extension-registry';
import { MemoryExtensionPackageAssets } from '../ports/extension-package-assets';
import { FakeExtensionSourceGateway } from './test-helpers';

describe('ExtensionService browser Legacy lifecycle', () => {
  it('installs original manifests, discovers third-party packages and preserves opaque fields', async () => {
    const { service, assets } = harness();

    const installed = await service.installRemote('https://example.test/cocktail.zip', 'local');
    const [record] = (await service.list()).filter(
      (entry) => entry.trust === 'user-approved-legacy',
    );

    expect(installed).toMatchObject({
      version: '1.0.0',
      display_name: 'Cocktail Test',
      extensionPath: '/scripts/extensions/third-party/cocktail',
      folderName: 'cocktail',
    });
    expect(record?.manifest.future_manifest_field).toEqual({ kept: true });
    expect(await service.legacyDiscover()).toContainEqual({
      name: 'third-party/cocktail',
      type: 'local',
    });
    expect(assets.getPackage(record!.extensionId)).toMatchObject({
      legacyName: 'third-party/cocktail',
    });
  });

  it('checks versions, updates in place and retains stable identity', async () => {
    const { service, source } = harness();
    await service.installRemote('https://example.test/cocktail.zip', 'local');
    const before = (await service.list()).find((entry) => entry.trust === 'user-approved-legacy')!;

    await expect(service.getLegacyVersion('cocktail')).resolves.toMatchObject({
      currentBranchName: 'main',
      isUpToDate: true,
    });
    source.set('main', '1.1.0', 'updated');
    await expect(service.getLegacyVersion('cocktail')).resolves.toMatchObject({
      isUpToDate: false,
    });
    const update = await service.updateByLegacyReference('cocktail');
    const after = await service.require(before.extensionId);

    expect(update).toMatchObject({
      isUpToDate: false,
      remoteUrl: 'https://example.test/cocktail.zip',
    });
    expect(after.extensionId).toBe(before.extensionId);
    expect(after.installedAt).toBe(before.installedAt);
    expect(after.manifest.version).toBe('1.1.0');
  });

  it('lists refs, switches branches and changes the local/global compatibility scope', async () => {
    const { service, source } = harness();
    source.set('next', '2.0.0', 'next');
    await service.installRemote('https://example.test/cocktail.zip', 'local');

    await expect(service.listBranches('cocktail')).resolves.toHaveLength(2);
    await service.switchBranch('cocktail', 'next');
    let record = (await service.list()).find((entry) => entry.trust === 'user-approved-legacy')!;
    expect(record.source).toMatchObject({ resolvedRef: 'next' });
    expect(record.manifest.version).toBe('2.0.0');

    await service.moveScope('cocktail', 'global');
    record = await service.require(record.extensionId);
    expect(record.scope).toBe('global');
    expect(await service.legacyDiscover()).toContainEqual({
      name: 'third-party/cocktail',
      type: 'global',
    });
  });

  it('removes package assets and rejects deletion of trusted built-ins', async () => {
    const { service, assets } = harness();
    await service.registerTrustedBuiltIns([
      {
        extensionId: 'builtin.regex',
        legacyName: 'regex',
        displayName: 'Regex',
        version: '1.0.0',
        author: 'SillyTavern',
        scriptPath: '/scripts/extensions/regex/index.js',
      },
    ]);
    await service.installRemote('https://example.test/cocktail.zip', 'local');
    const local = (await service.list()).find((entry) => entry.trust === 'user-approved-legacy')!;

    await expect(service.removeByLegacyReference('regex')).rejects.toBeInstanceOf(
      ExtensionPermissionError,
    );
    await service.removeByLegacyReference('cocktail');
    expect(assets.getPackage(local.extensionId)).toBeNull();
    await expect(service.require(local.extensionId)).rejects.toThrow('not installed');
  });

  it('keeps disabled state when replacing a package', async () => {
    const { service, source } = harness();
    await service.installRemote('https://example.test/cocktail.zip', 'local');
    const record = (await service.list()).find((entry) => entry.trust === 'user-approved-legacy')!;
    await service.disable(record.extensionId);
    source.set('main', '1.1.0', 'updated');

    await service.updateByLegacyReference('cocktail');

    expect((await service.require(record.extensionId)).enabled).toBe(false);
  });
});

function harness() {
  const registry = new MemoryExtensionRegistry();
  const assets = new MemoryExtensionPackageAssets();
  const source = new FakeExtensionSourceGateway();
  const service = new ExtensionService(
    registry,
    assets,
    source,
    () => new Date('2026-07-24T00:00:00.000Z'),
  );
  return { registry, assets, source, service };
}
