import {
  assertExtensionId,
  createVersionMetadata,
  type ExtensionCapability,
  type ExtensionRecord,
  type TrustedLegacyBuiltInDefinition,
} from '../domain/extension';
import type { ExtensionPackageAssets } from '../ports/extension-package-assets';
import type { ExtensionRegistry } from '../ports/extension-registry';
import { ExtensionConflictError, ExtensionNotFoundError } from '../ports/extension-registry';
import type { PluginPermissionBroker } from '../ports/plugin-permission-broker';
import type { PluginStorage } from '../ports/plugin-storage';
import {
  validateLocalExtensionPackage,
  type ExtensionPackageFile,
  type ExtensionPackageLimits,
} from './package-validator';

export interface ExtensionExecutionPlan {
  extensionId: string;
  mode: 'same-context' | 'iframe' | 'worker';
  entryUrl: string;
  expectedMessageOrigin: string | null;
  iframeSandbox: readonly string[];
}

export interface LegacyDiscoveredExtension {
  name: string;
  type: 'system';
}

export interface LegacyExtensionVersionDto {
  currentBranchName: string;
  currentCommitHash: string;
  isUpToDate: true;
  remoteUrl: string;
}

export class ExtensionPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionPermissionError';
  }
}

export class ExtensionService {
  readonly #registry: ExtensionRegistry;
  readonly #pluginStorage: PluginStorage;
  readonly #permissions: PluginPermissionBroker;
  readonly #assets: ExtensionPackageAssets;
  readonly #clock: () => Date;

  constructor(
    registry: ExtensionRegistry,
    pluginStorage: PluginStorage,
    permissions: PluginPermissionBroker,
    assets: ExtensionPackageAssets,
    clock: () => Date = () => new Date(),
  ) {
    this.#registry = registry;
    this.#pluginStorage = pluginStorage;
    this.#permissions = permissions;
    this.#assets = assets;
    this.#clock = clock;
  }

  async registerTrustedBuiltIns(
    definitions: readonly TrustedLegacyBuiltInDefinition[],
  ): Promise<void> {
    for (const definition of definitions) {
      assertExtensionId(definition.extensionId);
      assertLegacyBuiltInName(definition.legacyName);
      if (definition.scriptPath !== `/scripts/extensions/${definition.legacyName}/index.js`) {
        throw new TypeError(
          'Trusted built-in script path must be the audited /scripts/extensions/<name>/index.js path.',
        );
      }
      const now = this.#clock().toISOString();
      const record: ExtensionRecord = {
        extensionId: definition.extensionId,
        legacyName: definition.legacyName,
        trust: 'trusted-builtin',
        enabled: true,
        manifest: {
          schemaVersion: 1,
          id: definition.extensionId,
          displayName: definition.displayName,
          version: definition.version,
          author: definition.author,
          description:
            definition.description ?? 'Trusted extension shipped in the audited upstream snapshot.',
          entrypoint: { type: 'same-context', path: definition.scriptPath },
          requestedCapabilities: ['dom:legacy'],
        },
        source: {
          kind: 'upstream-snapshot',
          snapshotPath: `/scripts/extensions/${definition.legacyName}/`,
        },
        installedAt: now,
        updatedAt: now,
        version: createVersionMetadata({
          extensionId: definition.extensionId,
          manifestVersion: definition.version,
          source: {
            kind: 'upstream-snapshot',
            snapshotPath: `/scripts/extensions/${definition.legacyName}/`,
          },
          installedAt: now,
          updatedAt: now,
        }),
      };
      await this.#registry.upsertTrusted(record);
    }
  }

  async installLocalPackage(
    files: readonly ExtensionPackageFile[],
    limits?: ExtensionPackageLimits,
  ): Promise<ExtensionRecord> {
    const validated = await validateLocalExtensionPackage(files, limits);
    if (await this.#registry.get(validated.manifest.id)) {
      throw new ExtensionConflictError(
        `Extension id is already installed: ${validated.manifest.id}`,
      );
    }
    const now = this.#clock().toISOString();
    const source = {
      kind: 'local-package' as const,
      packageHash: validated.packageHash,
      fileCount: validated.fileCount,
      totalBytes: validated.totalBytes,
    };
    const record: ExtensionRecord = {
      extensionId: validated.manifest.id,
      legacyName: `third-party/local-${validated.packageHash.slice(0, 16)}`,
      trust: 'untrusted-user',
      enabled: false,
      manifest: validated.manifest,
      source,
      installedAt: now,
      updatedAt: now,
      version: createVersionMetadata({
        extensionId: validated.manifest.id,
        manifestVersion: validated.manifest.version,
        source,
        installedAt: now,
        updatedAt: now,
      }),
    };

    await this.#assets.savePackage({
      extensionId: record.extensionId,
      packageHash: validated.packageHash,
      files: validated.files,
      installedAt: now,
    });
    try {
      await this.#registry.install(record);
    } catch (error) {
      await this.#assets.removePackage(record.extensionId).catch(() => undefined);
      throw error;
    }
    return record;
  }

  async list(): Promise<ExtensionRecord[]> {
    return this.#registry.list();
  }

  async enable(extensionId: string): Promise<void> {
    await this.#registry.enable(extensionId);
  }

  async disable(extensionId: string): Promise<void> {
    await this.#registry.disable(extensionId);
  }

  async remove(extensionId: string): Promise<void> {
    const record = await this.require(extensionId);
    if (record.trust === 'trusted-builtin') {
      throw new ExtensionPermissionError(
        'Trusted built-ins ship with the app and cannot be removed.',
      );
    }
    await this.#registry.remove(extensionId);
    await Promise.all([
      this.#pluginStorage.clear(extensionId),
      this.#permissions.revokeAll(extensionId),
      this.#assets.removePackage(extensionId),
    ]);
  }

  async grantPermission(extensionId: string, capability: ExtensionCapability): Promise<void> {
    const record = await this.require(extensionId);
    if (!record.manifest.requestedCapabilities.includes(capability)) {
      throw new ExtensionPermissionError(
        `Extension ${extensionId} did not request capability ${capability}.`,
      );
    }
    await this.#permissions.grant(extensionId, capability);
  }

  async revokePermission(extensionId: string, capability: ExtensionCapability): Promise<void> {
    await this.require(extensionId);
    await this.#permissions.revoke(extensionId, capability);
  }

  async checkPermission(extensionId: string, capability: ExtensionCapability): Promise<boolean> {
    const record = await this.#registry.get(extensionId);
    if (!record || !record.manifest.requestedCapabilities.includes(capability)) return false;
    return this.#permissions.check(extensionId, capability);
  }

  async getExecutionPlan(extensionId: string): Promise<ExtensionExecutionPlan> {
    const record = await this.require(extensionId);
    if (!record.enabled)
      throw new ExtensionPermissionError(`Extension is disabled: ${extensionId}`);
    const { entrypoint } = record.manifest;
    if (entrypoint.type === 'same-context') {
      if (record.trust !== 'trusted-builtin' || record.source.kind !== 'upstream-snapshot') {
        throw new ExtensionPermissionError(
          'Same-context compatibility is reserved for trusted upstream built-ins.',
        );
      }
      return {
        extensionId,
        mode: 'same-context',
        entryUrl: entrypoint.path,
        expectedMessageOrigin: null,
        iframeSandbox: [],
      };
    }
    if (record.trust !== 'untrusted-user' || record.source.kind !== 'local-package') {
      throw new ExtensionPermissionError(
        'Non-built-in code must use an isolated package entrypoint.',
      );
    }
    const entryUrl = await this.#assets.resolveAssetUrl(extensionId, entrypoint.path);
    if (!entryUrl) throw new Error(`Extension entry asset is unavailable: ${entrypoint.path}`);
    return {
      extensionId,
      mode: entrypoint.type,
      entryUrl,
      expectedMessageOrigin: entrypoint.type === 'iframe' ? 'null' : '',
      iframeSandbox: entrypoint.type === 'iframe' ? ['allow-scripts'] : [],
    };
  }

  /** Only trusted built-ins are returned because upstream discover injects every result into the page. */
  async legacyDiscover(): Promise<LegacyDiscoveredExtension[]> {
    return (await this.#registry.discover())
      .filter(
        (record) =>
          record.trust === 'trusted-builtin' && record.manifest.entrypoint.type === 'same-context',
      )
      .map((record) => ({ name: record.legacyName, type: 'system' as const }));
  }

  async findByLegacyReference(reference: string): Promise<ExtensionRecord | null> {
    const direct = await this.#registry.get(reference);
    return direct ?? this.#registry.findByLegacyName(reference);
  }

  async getLegacyVersion(reference: string): Promise<LegacyExtensionVersionDto> {
    const record = await this.findByLegacyReference(reference);
    if (!record) throw new ExtensionNotFoundError(reference);
    return {
      currentBranchName: '',
      currentCommitHash: record.source.kind === 'local-package' ? record.source.packageHash : '',
      isUpToDate: true,
      remoteUrl: '',
    };
  }

  async removeByLegacyReference(reference: string): Promise<void> {
    const record = await this.findByLegacyReference(reference);
    if (!record) throw new ExtensionNotFoundError(reference);
    await this.remove(record.extensionId);
  }

  async require(extensionId: string): Promise<ExtensionRecord> {
    const record = await this.#registry.get(extensionId);
    if (!record) throw new ExtensionNotFoundError(extensionId);
    return record;
  }
}

function assertLegacyBuiltInName(value: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new TypeError(`Invalid trusted legacy built-in name: ${value}`);
  }
}
