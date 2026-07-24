import {
  cloneExtensionRecord,
  createVersionMetadata,
  type ExtensionInstallation,
  type ExtensionManifest,
  type ExtensionRecord,
  type ExtensionVersionMetadata,
} from '../domain/extension';
import {
  ExtensionConflictError,
  ExtensionNotFoundError,
  type ExtensionRegistry,
  type ExtensionStorageDiagnostics,
} from '../ports/extension-registry';
import type { ExtensionRecordStore } from './record-store';

const MANIFESTS_COLLECTION = 'manifests';
const INSTALLATIONS_COLLECTION = 'installations';
const ENABLED_COLLECTION = 'enabled';

interface EnabledRecord {
  enabled: boolean;
}

export class RecordExtensionRegistry implements ExtensionRegistry {
  readonly #records: ExtensionRecordStore;

  constructor(records: ExtensionRecordStore) {
    this.#records = records;
  }

  async discover(): Promise<ExtensionRecord[]> {
    return (await this.list()).filter((record) => record.enabled);
  }

  async list(): Promise<ExtensionRecord[]> {
    const installations = await this.#records.list<ExtensionInstallation>(INSTALLATIONS_COLLECTION);
    const records = await Promise.all(
      installations.map((installation) => this.#readRecord(installation.value)),
    );
    return records
      .filter((record): record is ExtensionRecord => record !== null)
      .sort(compareRecords);
  }

  async get(extensionId: string): Promise<ExtensionRecord | null> {
    const installation = await this.#records.get<ExtensionInstallation>(
      INSTALLATIONS_COLLECTION,
      extensionId,
    );
    return installation ? this.#readRecord(installation.value) : null;
  }

  async findByLegacyName(legacyName: string): Promise<ExtensionRecord | null> {
    const target = normalizeLegacyName(legacyName);
    return (
      (await this.list()).find((record) => normalizeLegacyName(record.legacyName) === target) ??
      null
    );
  }

  async install(record: ExtensionRecord): Promise<void> {
    await assertNoConflict(this, record);
    await this.#writeRecord(record);
  }

  async upsertTrusted(record: ExtensionRecord): Promise<void> {
    if (record.trust !== 'trusted-builtin') {
      throw new TypeError('Only trusted built-ins can use registry upsert.');
    }
    const existing = await this.get(record.extensionId);
    if (existing && existing.trust !== 'trusted-builtin') {
      throw new ExtensionConflictError(
        `Extension id is already owned by a user package: ${record.extensionId}`,
      );
    }
    const legacyConflict = (await this.list()).find(
      (candidate) =>
        candidate.extensionId !== record.extensionId &&
        normalizeLegacyName(candidate.legacyName) === normalizeLegacyName(record.legacyName),
    );
    if (legacyConflict) {
      throw new ExtensionConflictError(
        `Legacy extension path is already in use: ${record.legacyName}`,
      );
    }
    await this.#writeRecord(
      existing
        ? {
            ...record,
            enabled: existing.enabled,
            installedAt: existing.installedAt,
            version: createVersionMetadata({
              extensionId: record.extensionId,
              manifestVersion: record.manifest.version,
              source: record.source,
              installedAt: existing.installedAt,
              updatedAt: record.updatedAt,
            }),
          }
        : record,
    );
  }

  async enable(extensionId: string): Promise<void> {
    await this.#setEnabled(extensionId, true);
  }

  async disable(extensionId: string): Promise<void> {
    await this.#setEnabled(extensionId, false);
  }

  async remove(extensionId: string): Promise<void> {
    if (!(await this.get(extensionId))) throw new ExtensionNotFoundError(extensionId);
    await this.#records.delete(ENABLED_COLLECTION, extensionId);
    await this.#records.delete(MANIFESTS_COLLECTION, extensionId);
    await this.#records.delete(INSTALLATIONS_COLLECTION, extensionId);
  }

  async getVersion(extensionId: string): Promise<ExtensionVersionMetadata | null> {
    return (await this.get(extensionId))?.version ?? null;
  }

  async #readRecord(installation: ExtensionInstallation): Promise<ExtensionRecord | null> {
    const [manifest, enabled] = await Promise.all([
      this.#records.get<ExtensionManifest>(MANIFESTS_COLLECTION, installation.extensionId),
      this.#records.get<EnabledRecord>(ENABLED_COLLECTION, installation.extensionId),
    ]);
    if (!manifest || !enabled) return null;
    return cloneExtensionRecord({
      ...installation,
      enabled: enabled.value.enabled,
      manifest: manifest.value,
      version: createVersionMetadata({
        extensionId: installation.extensionId,
        manifestVersion: manifest.value.version,
        source: installation.source,
        installedAt: installation.installedAt,
        updatedAt: installation.updatedAt,
      }),
    });
  }

  async #writeRecord(record: ExtensionRecord): Promise<void> {
    const installation: ExtensionInstallation = {
      extensionId: record.extensionId,
      legacyName: record.legacyName,
      trust: record.trust,
      source: structuredClone(record.source),
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
    };
    await this.#records.put(MANIFESTS_COLLECTION, record.extensionId, record.manifest);
    await this.#records.put(INSTALLATIONS_COLLECTION, record.extensionId, installation);
    await this.#records.put(ENABLED_COLLECTION, record.extensionId, { enabled: record.enabled });
  }

  async #setEnabled(extensionId: string, enabled: boolean): Promise<void> {
    const existing = await this.get(extensionId);
    if (!existing) throw new ExtensionNotFoundError(extensionId);
    await this.#records.put(ENABLED_COLLECTION, extensionId, { enabled });
  }
}

export class MemoryExtensionRegistry implements ExtensionRegistry {
  readonly #records = new Map<string, ExtensionRecord>();

  async discover(): Promise<ExtensionRecord[]> {
    return (await this.list()).filter((record) => record.enabled);
  }

  async list(): Promise<ExtensionRecord[]> {
    return [...this.#records.values()].map(cloneExtensionRecord).sort(compareRecords);
  }

  async get(extensionId: string): Promise<ExtensionRecord | null> {
    const record = this.#records.get(extensionId);
    return record ? cloneExtensionRecord(record) : null;
  }

  async findByLegacyName(legacyName: string): Promise<ExtensionRecord | null> {
    const target = normalizeLegacyName(legacyName);
    const record = [...this.#records.values()].find(
      (candidate) => normalizeLegacyName(candidate.legacyName) === target,
    );
    return record ? cloneExtensionRecord(record) : null;
  }

  async install(record: ExtensionRecord): Promise<void> {
    await assertNoConflict(this, record);
    this.#records.set(record.extensionId, cloneExtensionRecord(record));
  }

  async upsertTrusted(record: ExtensionRecord): Promise<void> {
    if (record.trust !== 'trusted-builtin') {
      throw new TypeError('Only trusted built-ins can use registry upsert.');
    }
    const existing = this.#records.get(record.extensionId);
    if (existing && existing.trust !== 'trusted-builtin') {
      throw new ExtensionConflictError(
        `Extension id is already owned by a user package: ${record.extensionId}`,
      );
    }
    const legacyConflict = [...this.#records.values()].find(
      (candidate) =>
        candidate.extensionId !== record.extensionId &&
        normalizeLegacyName(candidate.legacyName) === normalizeLegacyName(record.legacyName),
    );
    if (legacyConflict) {
      throw new ExtensionConflictError(
        `Legacy extension path is already in use: ${record.legacyName}`,
      );
    }
    this.#records.set(
      record.extensionId,
      cloneExtensionRecord(
        existing
          ? {
              ...record,
              enabled: existing.enabled,
              installedAt: existing.installedAt,
              version: createVersionMetadata({
                extensionId: record.extensionId,
                manifestVersion: record.manifest.version,
                source: record.source,
                installedAt: existing.installedAt,
                updatedAt: record.updatedAt,
              }),
            }
          : record,
      ),
    );
  }

  async enable(extensionId: string): Promise<void> {
    this.#setEnabled(extensionId, true);
  }

  async disable(extensionId: string): Promise<void> {
    this.#setEnabled(extensionId, false);
  }

  async remove(extensionId: string): Promise<void> {
    if (!this.#records.delete(extensionId)) throw new ExtensionNotFoundError(extensionId);
  }

  async getVersion(extensionId: string): Promise<ExtensionVersionMetadata | null> {
    return (await this.get(extensionId))?.version ?? null;
  }

  replaceAll(records: readonly ExtensionRecord[]): void {
    this.#records.clear();
    for (const record of records)
      this.#records.set(record.extensionId, cloneExtensionRecord(record));
  }

  hydrate(record: ExtensionRecord): void {
    this.#records.set(record.extensionId, cloneExtensionRecord(record));
  }

  #setEnabled(extensionId: string, enabled: boolean): void {
    const record = this.#records.get(extensionId);
    if (!record) throw new ExtensionNotFoundError(extensionId);
    this.#records.set(extensionId, cloneExtensionRecord({ ...record, enabled }));
  }
}

export class ResilientExtensionRegistry implements ExtensionRegistry {
  readonly diagnostics: ExtensionStorageDiagnostics = {
    status: 'ready',
    backend: 'records',
    message: null,
    lastSavedAt: null,
  };

  readonly #primary: ExtensionRegistry;
  readonly #fallback: MemoryExtensionRegistry;

  constructor(
    primary: ExtensionRegistry,
    fallback: MemoryExtensionRegistry = new MemoryExtensionRegistry(),
  ) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async discover(): Promise<ExtensionRecord[]> {
    return (await this.list()).filter((record) => record.enabled);
  }

  async list(): Promise<ExtensionRecord[]> {
    if (this.diagnostics.status === 'degraded') return this.#fallback.list();
    try {
      const records = await this.#primary.list();
      this.#fallback.replaceAll(records);
      return records;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.list();
    }
  }

  async get(extensionId: string): Promise<ExtensionRecord | null> {
    if (this.diagnostics.status === 'degraded') return this.#fallback.get(extensionId);
    try {
      const record = await this.#primary.get(extensionId);
      if (record) {
        this.#fallback.hydrate(record);
      } else if (await this.#fallback.get(extensionId)) {
        await this.#fallback.remove(extensionId);
      }
      return record;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.get(extensionId);
    }
  }

  async findByLegacyName(legacyName: string): Promise<ExtensionRecord | null> {
    if (this.diagnostics.status === 'degraded') return this.#fallback.findByLegacyName(legacyName);
    try {
      const record = await this.#primary.findByLegacyName(legacyName);
      if (record) this.#fallback.hydrate(record);
      return record;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.findByLegacyName(legacyName);
    }
  }

  async install(record: ExtensionRecord): Promise<void> {
    if (this.diagnostics.status !== 'degraded') await this.list();
    await this.#fallback.install(record);
    if (this.diagnostics.status === 'degraded') return this.#saved();
    try {
      await this.#primary.install(record);
      this.#saved();
    } catch (error) {
      if (error instanceof ExtensionConflictError) {
        await this.#fallback.remove(record.extensionId);
        throw error;
      }
      this.#degrade(error);
      this.#saved();
    }
  }

  async upsertTrusted(record: ExtensionRecord): Promise<void> {
    if (this.diagnostics.status !== 'degraded') await this.list();
    await this.#fallback.upsertTrusted(record);
    await this.#write(() => this.#primary.upsertTrusted(record));
  }

  async enable(extensionId: string): Promise<void> {
    await this.#hydrate(extensionId);
    await this.#fallback.enable(extensionId);
    await this.#write(() => this.#primary.enable(extensionId));
  }

  async disable(extensionId: string): Promise<void> {
    await this.#hydrate(extensionId);
    await this.#fallback.disable(extensionId);
    await this.#write(() => this.#primary.disable(extensionId));
  }

  async remove(extensionId: string): Promise<void> {
    await this.#hydrate(extensionId);
    await this.#fallback.remove(extensionId);
    await this.#write(() => this.#primary.remove(extensionId));
  }

  async getVersion(extensionId: string): Promise<ExtensionVersionMetadata | null> {
    return (await this.get(extensionId))?.version ?? null;
  }

  async #hydrate(extensionId: string): Promise<void> {
    if (this.diagnostics.status === 'degraded') return;
    const record = await this.get(extensionId);
    if (!record) throw new ExtensionNotFoundError(extensionId);
  }

  async #write(operation: () => Promise<void>): Promise<void> {
    if (this.diagnostics.status !== 'degraded') {
      try {
        await operation();
      } catch (error) {
        if (error instanceof ExtensionConflictError || error instanceof ExtensionNotFoundError) {
          throw error;
        }
        this.#degrade(error);
      }
    }
    this.#saved();
  }

  #saved(): void {
    this.diagnostics.lastSavedAt = new Date().toISOString();
  }

  #degrade(error: unknown): void {
    this.diagnostics.status = 'degraded';
    this.diagnostics.backend = 'memory';
    this.diagnostics.message = error instanceof Error ? error.message : String(error);
  }
}

async function assertNoConflict(
  registry: ExtensionRegistry,
  record: ExtensionRecord,
): Promise<void> {
  if (await registry.get(record.extensionId)) {
    throw new ExtensionConflictError(`Extension id is already installed: ${record.extensionId}`);
  }
  if (await registry.findByLegacyName(record.legacyName)) {
    throw new ExtensionConflictError(
      `Legacy extension path is already in use: ${record.legacyName}`,
    );
  }
}

function normalizeLegacyName(value: string): string {
  return value
    .trim()
    .replace(/^\/+/, '')
    .replace(/^third-party\//i, '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US');
}

function compareRecords(left: ExtensionRecord, right: ExtensionRecord): number {
  return (
    Number(right.trust === 'trusted-builtin') - Number(left.trust === 'trusted-builtin') ||
    left.manifest.displayName.localeCompare(right.manifest.displayName) ||
    left.extensionId.localeCompare(right.extensionId)
  );
}
