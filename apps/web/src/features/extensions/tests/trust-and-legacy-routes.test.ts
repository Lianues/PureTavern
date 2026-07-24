import { describe, expect, it } from 'vitest';

import { CompatibilityRouter } from '@/platform/legacy/compatibility-router';

import { ExtensionService } from '../application/extension-service';
import { MemoryExtensionRegistry } from '../infrastructure/extension-registry';
import { MemoryPluginPermissionBroker } from '../infrastructure/plugin-permission-broker';
import { MemoryPluginStorage } from '../infrastructure/plugin-storage';
import { registerExtensionsLegacyRoutes } from '../legacy/register-routes';
import type {
  ExtensionPackageAssets,
  ValidatedExtensionPackageAsset,
} from '../ports/extension-package-assets';
import { makeExtensionRecord, makeWorkerPackage } from './test-helpers';

describe('trusted/untrusted execution split', () => {
  it('allows only snapshot built-ins into same-context and legacy discover', async () => {
    const { service, registry } = createHarness();
    await service.registerTrustedBuiltIns([
      {
        extensionId: 'legacy.builtin.demo',
        legacyName: 'demo',
        displayName: 'Demo Built-in',
        version: '1.0.0',
        author: 'Upstream',
        scriptPath: '/scripts/extensions/demo/index.js',
      },
    ]);
    const local = await service.installLocalPackage(
      await makeWorkerPackage('org.example.isolated', {
        capabilities: ['storage:plugin'],
      }),
    );
    await service.enable(local.extensionId);

    await expect(service.getExecutionPlan('legacy.builtin.demo')).resolves.toMatchObject({
      mode: 'same-context',
      entryUrl: '/scripts/extensions/demo/index.js',
    });
    await expect(service.getExecutionPlan(local.extensionId)).resolves.toMatchObject({
      mode: 'worker',
      entryUrl: 'blob:test/org.example.isolated/worker.js',
      expectedMessageOrigin: '',
    });
    await expect(service.legacyDiscover()).resolves.toEqual([{ name: 'demo', type: 'system' }]);

    const forged = makeExtensionRecord('org.example.forged', {
      entryType: 'same-context',
      trust: 'untrusted-user',
    });
    await registry.install(forged);
    await expect(service.getExecutionPlan(forged.extensionId)).rejects.toThrow(
      'reserved for trusted upstream built-ins',
    );
  });

  it('grants only capabilities explicitly requested by the manifest', async () => {
    const { service } = createHarness();
    const local = await service.installLocalPackage(
      await makeWorkerPackage('org.example.permission-request', {
        capabilities: ['storage:plugin'],
      }),
    );

    await expect(service.checkPermission(local.extensionId, 'storage:plugin')).resolves.toBe(false);
    await service.grantPermission(local.extensionId, 'storage:plugin');
    await expect(service.checkPermission(local.extensionId, 'storage:plugin')).resolves.toBe(true);
    await expect(service.grantPermission(local.extensionId, 'secrets:read')).rejects.toThrow(
      'did not request capability',
    );
    await service.revokePermission(local.extensionId, 'storage:plugin');
    await expect(service.checkPermission(local.extensionId, 'storage:plugin')).resolves.toBe(false);
  });
});

describe('browser-truthful Legacy extension routes', () => {
  it('returns real discover/version/delete DTOs and rejects server-only operations', async () => {
    const { service } = createHarness();
    await service.registerTrustedBuiltIns([
      {
        extensionId: 'legacy.builtin.demo',
        legacyName: 'demo',
        displayName: 'Demo Built-in',
        version: '1.0.0',
        author: 'Upstream',
        scriptPath: '/scripts/extensions/demo/index.js',
      },
    ]);
    const local = await service.installLocalPackage(await makeWorkerPackage('org.example.routes'));
    const router = new CompatibilityRouter();
    registerExtensionsLegacyRoutes(router, service);

    const discover = await dispatch(router, 'GET', '/api/extensions/discover');
    await expect(discover.json()).resolves.toEqual([{ name: 'demo', type: 'system' }]);
    const comfyWorkflows = await postJson(router, '/api/sd/comfy/workflows', { url: '' });
    await expect(comfyWorkflows.json()).resolves.toEqual([]);

    const version = await postJson(router, '/api/extensions/version', {
      extensionName: local.legacyName.replace('third-party', ''),
      global: false,
    });
    await expect(version.json()).resolves.toEqual({
      currentBranchName: '',
      currentCommitHash: local.source.kind === 'local-package' ? local.source.packageHash : '',
      isUpToDate: true,
      remoteUrl: '',
    });

    for (const path of [
      '/api/extensions/install',
      '/api/extensions/update',
      '/api/extensions/branches',
      '/api/extensions/switch',
      '/api/extensions/move',
    ]) {
      const response = await postJson(router, path, { url: 'https://example.invalid/repo.git' });
      expect(response.status).toBe(501);
      await expect(response.json()).resolves.toMatchObject({
        error: 'unsupported',
        pureTavern: true,
      });
    }

    const deniedBuiltInDelete = await postJson(router, '/api/extensions/delete', {
      extensionName: 'demo',
      global: false,
    });
    expect(deniedBuiltInDelete.status).toBe(403);

    const deleted = await postJson(router, '/api/extensions/delete', {
      extensionName: local.legacyName,
      global: false,
    });
    expect(deleted.status).toBe(200);
    await expect(service.require(local.extensionId)).rejects.toThrow('not installed');
  });
});

function createHarness(): {
  service: ExtensionService;
  registry: MemoryExtensionRegistry;
} {
  const registry = new MemoryExtensionRegistry();
  const service = new ExtensionService(
    registry,
    new MemoryPluginStorage(),
    new MemoryPluginPermissionBroker(),
    new TestPackageAssets(),
    () => new Date('2026-07-24T00:00:00.000Z'),
  );
  return { service, registry };
}

class TestPackageAssets implements ExtensionPackageAssets {
  readonly #packages = new Map<string, ValidatedExtensionPackageAsset>();

  async savePackage(asset: ValidatedExtensionPackageAsset): Promise<void> {
    this.#packages.set(asset.extensionId, asset);
  }

  async removePackage(extensionId: string): Promise<void> {
    this.#packages.delete(extensionId);
  }

  async resolveAssetUrl(extensionId: string, path: string): Promise<string | null> {
    const file = this.#packages
      .get(extensionId)
      ?.files.find((candidate) => candidate.path === path);
    return file ? `blob:test/${extensionId}/${path}` : null;
  }
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
