import { afterEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '@/platform/features/capability-registry';
import { legacyExtensionSettingsCapability } from '@/platform/features/standard-capabilities';
import { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { AppDatabase } from '@/platform/storage/app-database';
import { AppStorage } from '@/platform/storage/app-storage';

import { createExtensionsFeature, extensionsRuntimeCapability } from '../module';
import { MemoryExtensionPackageAssets } from '../ports/extension-package-assets';
import { FakeExtensionSourceGateway } from './test-helpers';

const databases: AppDatabase[] = [];

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('M11 Legacy routes and module composition', () => {
  it('implements install/update/version/branches/switch/move/delete with original DTOs', async () => {
    const source = new FakeExtensionSourceGateway();
    source.set('next', '2.0.0', 'next');
    const { router } = installFeature(source);

    const install = await postJson(router, '/api/extensions/install', {
      url: 'https://example.test/cocktail.zip',
      global: false,
      branch: '',
    });
    expect(install.status).toBe(200);
    await expect(install.json()).resolves.toMatchObject({
      display_name: 'Cocktail Test',
      extensionPath: '/scripts/extensions/third-party/cocktail',
      folderName: 'cocktail',
    });

    const discover = await dispatch(router, 'GET', '/api/extensions/discover');
    await expect(discover.json()).resolves.toContainEqual({
      name: 'third-party/cocktail',
      type: 'local',
    });

    const version = await postJson(router, '/api/extensions/version', {
      extensionName: 'cocktail',
      global: false,
    });
    await expect(version.json()).resolves.toMatchObject({
      currentBranchName: 'main',
      isUpToDate: true,
      remoteUrl: 'https://example.test/cocktail.zip',
    });

    const branches = await postJson(router, '/api/extensions/branches', {
      extensionName: 'cocktail',
      global: false,
    });
    await expect(branches.json()).resolves.toHaveLength(2);

    const switched = await postJson(router, '/api/extensions/switch', {
      extensionName: 'cocktail',
      branch: 'next',
      global: false,
    });
    expect(switched.status).toBe(204);

    source.set('next', '2.1.0', 'updated');
    const updated = await postJson(router, '/api/extensions/update', {
      extensionName: 'cocktail',
      global: false,
    });
    await expect(updated.json()).resolves.toMatchObject({ isUpToDate: false });

    const moved = await postJson(router, '/api/extensions/move', {
      extensionName: 'cocktail',
      source: 'local',
      destination: 'global',
    });
    expect(moved.status).toBe(204);

    const deleted = await postJson(router, '/api/extensions/delete', {
      extensionName: 'cocktail',
      global: true,
    });
    expect(deleted.status).toBe(200);
    const afterDelete = await dispatch(router, 'GET', '/api/extensions/discover');
    await expect(afterDelete.json()).resolves.not.toContainEqual(
      expect.objectContaining({ name: 'third-party/cocktail' }),
    );
  });

  it('keeps original Settings disabledExtensions synchronized with registry state', async () => {
    const source = new FakeExtensionSourceGateway();
    const { router, capabilities } = installFeature(source);
    await postJson(router, '/api/extensions/install', {
      url: 'https://example.test/cocktail.zip',
      global: false,
    });
    const settings = capabilities.get(legacyExtensionSettingsCapability)!;

    await settings.applyDisabledLegacyNames(['third-party/cocktail', 'third-party/unknown']);
    await expect(settings.getDisabledLegacyNames()).resolves.toEqual([
      'third-party/cocktail',
      'third-party/unknown',
    ]);

    await settings.applyDisabledLegacyNames([]);
    await expect(settings.getDisabledLegacyNames()).resolves.toEqual([]);
  });

  it('registers a narrow runtime capability without a second plugin ecosystem', async () => {
    const source = new FakeExtensionSourceGateway();
    const { capabilities, diagnostics } = installFeature(source);
    const runtime = capabilities.get(extensionsRuntimeCapability)!;
    await runtime.ready;

    expect(runtime.service).toBeDefined();
    expect(runtime.registry).toBeDefined();
    expect(diagnostics).toMatchObject({
      executionModel: 'legacy-same-context-user-approved',
      originalRiskWarningOwnedByLegacyUi: true,
    });
    expect(diagnostics).not.toHaveProperty('permissions');
    expect(diagnostics).not.toHaveProperty('pluginStorage');
  });
});

function installFeature(source: FakeExtensionSourceGateway): {
  router: CompatibilityRouter;
  capabilities: CapabilityRegistry;
  diagnostics: Record<string, unknown>;
} {
  const database = new AppDatabase(`pure-tavern-extensions-${crypto.randomUUID()}`);
  databases.push(database);
  const storage = new AppStorage(database);
  const router = new CompatibilityRouter();
  const capabilities = new CapabilityRegistry();
  const feature = createExtensionsFeature({
    sourceGateway: source,
    packageAssets: new MemoryExtensionPackageAssets(),
    trustedBuiltIns: [],
  });
  const result = feature.install({
    router,
    nativeFetch: fetch,
    records: storage.records.forModule('extensions'),
    blobs: storage.blobs.forModule('extensions'),
    capabilities,
  });
  return { router, capabilities, diagnostics: result.diagnostics ?? {} };
}

async function postJson(
  router: CompatibilityRouter,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return dispatch(router, 'POST', path, JSON.stringify(body));
}

async function dispatch(
  router: CompatibilityRouter,
  method: string,
  path: string,
  body?: BodyInit,
): Promise<Response> {
  const request = new Request(`https://app.example${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body,
        }),
  });
  const response = await router.dispatch(request, new URL(request.url));
  if (!response) throw new Error(`Route was not handled: ${method} ${path}`);
  return response;
}
