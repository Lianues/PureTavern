import {
  assertExtensionId,
  type ExtensionRecord,
  type ExtensionScope,
  type RemoteExtensionSource,
  type TrustedLegacyBuiltInDefinition,
} from '../domain/extension';
import type { ExtensionPackageAssets } from '../ports/extension-package-assets';
import type { ExtensionRegistry } from '../ports/extension-registry';
import { ExtensionConflictError, ExtensionNotFoundError } from '../ports/extension-registry';
import type {
  ExtensionSourceGateway,
  ExtensionSourceRef,
  ExtensionSourceSnapshot,
} from '../ports/extension-source-gateway';
import {
  DEFAULT_EXTENSION_PACKAGE_LIMITS,
  sha256Hex,
  validateLegacyExtensionPackage,
  type ExtensionPackageLimits,
  type ValidatedLegacyExtensionPackage,
} from './package-validator';

export interface LegacyDiscoveredExtension {
  name: string;
  type: 'system' | 'local' | 'global';
}

export interface LegacyExtensionVersionDto {
  currentBranchName: string;
  currentCommitHash: string;
  isUpToDate: boolean;
  remoteUrl: string;
}

export interface LegacyInstallExtensionDto {
  version: string;
  author: string;
  display_name: string;
  extensionPath: string;
  folderName: string;
}

export interface LegacyUpdateExtensionDto {
  shortCommitHash: string;
  extensionPath: string;
  isUpToDate: boolean;
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
  readonly #assets: ExtensionPackageAssets;
  readonly #sources: ExtensionSourceGateway;
  readonly #limits: ExtensionPackageLimits;
  readonly #clock: () => Date;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(
    registry: ExtensionRegistry,
    assets: ExtensionPackageAssets,
    sources: ExtensionSourceGateway,
    limits: ExtensionPackageLimits = DEFAULT_EXTENSION_PACKAGE_LIMITS,
    clock: () => Date = () => new Date(),
  ) {
    this.#registry = registry;
    this.#assets = assets;
    this.#sources = sources;
    this.#limits = limits;
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
      await this.#registry.upsertTrusted({
        extensionId: definition.extensionId,
        legacyName: definition.legacyName,
        folderName: definition.legacyName,
        trust: 'trusted-builtin',
        scope: 'system',
        enabled: true,
        manifest: {
          display_name: definition.displayName,
          version: definition.version,
          author: definition.author,
          js: 'index.js',
          description:
            definition.description ?? 'Trusted extension shipped in the audited upstream snapshot.',
        },
        source: {
          kind: 'upstream-snapshot',
          snapshotPath: `/scripts/extensions/${definition.legacyName}/`,
        },
        installedAt: now,
        updatedAt: now,
      });
    }
  }

  async installRemote(
    url: string,
    scope: Exclude<ExtensionScope, 'system'>,
    ref = '',
    signal?: AbortSignal,
  ): Promise<LegacyInstallExtensionDto> {
    const snapshot = await this.#sources.fetchSnapshot(url, ref, this.#limits, signal);
    const extensionId = await extensionIdForRepository(snapshot.repositoryUrl);
    return this.#serialize(extensionId, async () => {
      if (await this.#registry.get(extensionId)) {
        throw new ExtensionConflictError(
          `Extension is already installed: ${snapshot.repositoryUrl}`,
        );
      }
      const legacyName = `third-party/${snapshot.folderName}`;
      if (await this.#registry.findByLegacyName(legacyName)) {
        throw new ExtensionConflictError(
          `Extension folder is already installed: ${snapshot.folderName}`,
        );
      }
      const validated = await validateLegacyExtensionPackage(snapshot.files, this.#limits);
      const now = this.#clock().toISOString();
      const record = createRemoteRecord({
        extensionId,
        legacyName,
        scope,
        snapshot,
        validated,
        installedAt: now,
        updatedAt: now,
        enabled: true,
      });
      await this.#assets.savePackage({
        extensionId,
        legacyName,
        packageHash: validated.packageHash,
        files: validated.files,
        installedAt: now,
      });
      try {
        await this.#registry.install(record);
      } catch (error) {
        await this.#assets.removePackage(extensionId).catch(() => undefined);
        throw error;
      }
      return installDto(record);
    });
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
    await this.#serialize(extensionId, async () => {
      const record = await this.require(extensionId);
      if (record.trust === 'trusted-builtin') {
        throw new ExtensionPermissionError(
          'Trusted built-ins ship with the app and cannot be removed.',
        );
      }
      await this.#registry.remove(extensionId);
      await this.#assets.removePackage(extensionId);
    });
  }

  async legacyDiscover(): Promise<LegacyDiscoveredExtension[]> {
    return (await this.#registry.list()).map((record) => ({
      name: record.legacyName,
      type: record.scope,
    }));
  }

  async findByLegacyReference(reference: string): Promise<ExtensionRecord | null> {
    const direct = await this.#registry.get(reference);
    if (direct) return direct;
    const exactLegacy = await this.#registry.findByLegacyName(reference);
    if (exactLegacy) return exactLegacy;
    return this.#registry.findByLegacyName(normalizeLegacyReference(reference));
  }

  async getLegacyVersion(
    reference: string,
    signal?: AbortSignal,
  ): Promise<LegacyExtensionVersionDto> {
    const record = await this.findByLegacyReference(reference);
    if (!record) throw new ExtensionNotFoundError(reference);
    if (record.source.kind === 'upstream-snapshot') {
      return {
        currentBranchName: '',
        currentCommitHash: '',
        isUpToDate: true,
        remoteUrl: '',
      };
    }
    const candidate = await this.#fetchValidated(record.source, signal);
    return {
      currentBranchName: record.source.resolvedRef,
      currentCommitHash: record.source.revision,
      isUpToDate: candidate.validated.packageHash === record.source.packageHash,
      remoteUrl: record.source.repositoryUrl,
    };
  }

  async updateByLegacyReference(
    reference: string,
    signal?: AbortSignal,
  ): Promise<LegacyUpdateExtensionDto> {
    const record = await this.#requireRemoteReference(reference);
    return this.#serialize(record.extensionId, async () => {
      const current = await this.#requireRemoteReference(record.extensionId);
      const candidate = await this.#fetchValidated(current.source, signal);
      if (candidate.validated.packageHash === current.source.packageHash) {
        return updateDto(current, true);
      }
      const updated = createRemoteRecord({
        extensionId: current.extensionId,
        legacyName: current.legacyName,
        scope: current.scope === 'global' ? 'global' : 'local',
        snapshot: candidate.snapshot,
        validated: candidate.validated,
        installedAt: current.installedAt,
        updatedAt: this.#clock().toISOString(),
        enabled: current.enabled,
      });
      await this.#assets.savePackage({
        extensionId: updated.extensionId,
        legacyName: updated.legacyName,
        packageHash: candidate.validated.packageHash,
        files: candidate.validated.files,
        installedAt: updated.installedAt,
      });
      await this.#registry.replace(updated);
      return updateDto(updated, false);
    });
  }

  async listBranches(reference: string, signal?: AbortSignal): Promise<ExtensionSourceRef[]> {
    const record = await this.#requireRemoteReference(reference);
    return this.#sources.listRefs(record.source, signal);
  }

  async switchBranch(reference: string, branch: string, signal?: AbortSignal): Promise<void> {
    const record = await this.#requireRemoteReference(reference);
    await this.#serialize(record.extensionId, async () => {
      const current = await this.#requireRemoteReference(record.extensionId);
      const snapshot = await this.#sources.fetchSnapshot(
        current.source.repositoryUrl,
        branch,
        this.#limits,
        signal,
      );
      const validated = await validateLegacyExtensionPackage(snapshot.files, this.#limits);
      const updated = createRemoteRecord({
        extensionId: current.extensionId,
        legacyName: current.legacyName,
        scope: current.scope === 'global' ? 'global' : 'local',
        snapshot,
        validated,
        installedAt: current.installedAt,
        updatedAt: this.#clock().toISOString(),
        enabled: current.enabled,
      });
      await this.#assets.savePackage({
        extensionId: updated.extensionId,
        legacyName: updated.legacyName,
        packageHash: validated.packageHash,
        files: validated.files,
        installedAt: updated.installedAt,
      });
      await this.#registry.replace(updated);
    });
  }

  async moveScope(reference: string, destination: string): Promise<void> {
    const record = await this.#requireRemoteReference(reference);
    if (destination !== 'local' && destination !== 'global') {
      throw new TypeError('Extension destination must be local or global.');
    }
    await this.#serialize(record.extensionId, async () => {
      const current = await this.#requireRemoteReference(record.extensionId);
      await this.#registry.replace({ ...current, scope: destination });
    });
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

  async #requireRemoteReference(
    reference: string,
  ): Promise<ExtensionRecord & { source: RemoteExtensionSource }> {
    const record = await this.findByLegacyReference(reference);
    if (!record) throw new ExtensionNotFoundError(reference);
    if (record.source.kind !== 'remote') {
      throw new ExtensionPermissionError('Trusted built-ins do not have a browser-managed remote.');
    }
    return record as ExtensionRecord & { source: RemoteExtensionSource };
  }

  async #fetchValidated(
    source: RemoteExtensionSource,
    signal?: AbortSignal,
  ): Promise<{
    snapshot: ExtensionSourceSnapshot;
    validated: ValidatedLegacyExtensionPackage;
  }> {
    const snapshot = await this.#sources.fetchSnapshot(
      source.repositoryUrl,
      source.resolvedRef,
      this.#limits,
      signal,
    );
    return {
      snapshot,
      validated: await validateLegacyExtensionPackage(snapshot.files, this.#limits),
    };
  }

  async #serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#queues.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#queues.get(key) === queued) this.#queues.delete(key);
    }
  }
}

function createRemoteRecord(input: {
  extensionId: string;
  legacyName: string;
  scope: Exclude<ExtensionScope, 'system'>;
  snapshot: ExtensionSourceSnapshot;
  validated: ValidatedLegacyExtensionPackage;
  installedAt: string;
  updatedAt: string;
  enabled: boolean;
}): ExtensionRecord {
  return {
    extensionId: input.extensionId,
    legacyName: input.legacyName,
    folderName: input.snapshot.folderName,
    trust: 'user-approved-legacy',
    scope: input.scope,
    enabled: input.enabled,
    manifest: input.validated.manifest,
    source: {
      kind: 'remote',
      provider: input.snapshot.provider,
      repositoryUrl: input.snapshot.repositoryUrl,
      requestedRef: input.snapshot.requestedRef,
      resolvedRef: input.snapshot.resolvedRef,
      revision: input.snapshot.revision,
      packageHash: input.validated.packageHash,
      fileCount: input.validated.fileCount,
      totalBytes: input.validated.totalBytes,
    },
    installedAt: input.installedAt,
    updatedAt: input.updatedAt,
  };
}

function installDto(record: ExtensionRecord): LegacyInstallExtensionDto {
  return {
    version: record.manifest.version,
    author: record.manifest.author,
    display_name: record.manifest.display_name,
    extensionPath: `/scripts/extensions/${record.legacyName}`,
    folderName: record.folderName,
  };
}

function updateDto(record: ExtensionRecord, isUpToDate: boolean): LegacyUpdateExtensionDto {
  const source = record.source;
  if (source.kind !== 'remote') throw new TypeError('Remote source is required.');
  return {
    shortCommitHash: source.revision.slice(0, 7),
    extensionPath: `/scripts/extensions/${record.legacyName}`,
    isUpToDate,
    remoteUrl: source.repositoryUrl,
  };
}

async function extensionIdForRepository(repositoryUrl: string): Promise<string> {
  const hash = await sha256Hex(new TextEncoder().encode(repositoryUrl.toLocaleLowerCase('en-US')));
  return `legacy.${hash.slice(0, 40)}`;
}

function normalizeLegacyReference(reference: string): string {
  const value = reference.trim().replace(/^\/+|\/+$/gu, '');
  if (!value) throw new TypeError('Extension name is required.');
  return value.startsWith('third-party/')
    ? value
    : `third-party/${value.replace(/^third-party\/?/u, '')}`;
}

function assertLegacyBuiltInName(value: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)) {
    throw new TypeError(`Invalid trusted legacy built-in name: ${value}`);
  }
}
