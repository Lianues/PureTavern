import {
  cloneExtensionRecord,
  createVersionMetadata,
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

const REGISTRY_COLLECTION = 'registry-v2';

export class RecordExtensionRegistry implements ExtensionRegistry {
  readonly #records: ExtensionRecordStore;

  constructor(records: ExtensionRecordStore) {
    this.#records = records;
  }

  async discover(): Promise<ExtensionRecord[]> {
    return this.list();
  }

  async list(): Promise<ExtensionRecord[]> {
    return (await this.#records.list<ExtensionRecord>(REGISTRY_COLLECTION))
      .map((entry) => cloneExtensionRecord(entry.value))
      .sort(compareRecords);
  }

  async get(extensionId: string): Promise<ExtensionRecord | null> {
    const entry = await this.#records.get<ExtensionRecord>(REGISTRY_COLLECTION, extensionId);
    return entry ? cloneExtensionRecord(entry.value) : null;
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
    await this.#records.put(REGISTRY_COLLECTION, record.extensionId, cloneExtensionRecord(record));
  }

  async replace(record: ExtensionRecord): Promise<void> {
    if (!(await this.get(record.extensionId))) throw new ExtensionNotFoundError(record.extensionId);
    await assertNoConflict(this, record, record.extensionId);
    await this.#records.put(REGISTRY_COLLECTION, record.extensionId, cloneExtensionRecord(record));
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
    await assertNoConflict(this, record, record.extensionId);
    await this.#records.put(
      REGISTRY_COLLECTION,
      record.extensionId,
      cloneExtensionRecord(
        existing
          ? {
              ...record,
              enabled: existing.enabled,
              installedAt: existing.installedAt,
            }
          : record,
      ),
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
    await this.#records.delete(REGISTRY_COLLECTION, extensionId);
  }

  async getVersion(extensionId: string): Promise<ExtensionVersionMetadata | null> {
    const record = await this.get(extensionId);
    return record ? createVersionMetadata(record) : null;
  }

  async #setEnabled(extensionId: string, enabled: boolean): Promise<void> {
    const record = await this.get(extensionId);
    if (!record) throw new ExtensionNotFoundError(extensionId);
    await this.#records.put(REGISTRY_COLLECTION, extensionId, { ...record, enabled });
  }
}

export class MemoryExtensionRegistry implements ExtensionRegistry {
  readonly #records = new Map<string, ExtensionRecord>();

  async discover(): Promise<ExtensionRecord[]> {
    return this.list();
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

  async replace(record: ExtensionRecord): Promise<void> {
    if (!this.#records.has(record.extensionId))
      throw new ExtensionNotFoundError(record.extensionId);
    await assertNoConflict(this, record, record.extensionId);
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
    await assertNoConflict(this, record, record.extensionId);
    this.#records.set(
      record.extensionId,
      cloneExtensionRecord(
        existing
          ? {
              ...record,
              enabled: existing.enabled,
              installedAt: existing.installedAt,
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
    const record = await this.get(extensionId);
    return record ? createVersionMetadata(record) : null;
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
    return this.list();
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
      if (record) this.#fallback.hydrate(record);
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
    await this.#write(() => this.#primary.install(record));
  }

  async replace(record: ExtensionRecord): Promise<void> {
    await this.#hydrate(record.extensionId);
    await this.#fallback.replace(record);
    await this.#write(() => this.#primary.replace(record));
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
    const record = await this.get(extensionId);
    return record ? createVersionMetadata(record) : null;
  }

  async #hydrate(extensionId: string): Promise<void> {
    if (await this.#fallback.get(extensionId)) return;
    const record = await this.get(extensionId);
    if (!record) throw new ExtensionNotFoundError(extensionId);
    this.#fallback.hydrate(record);
  }

  async #write(operation: () => Promise<void>): Promise<void> {
    if (this.diagnostics.status === 'degraded') {
      this.#saved();
      return;
    }
    try {
      await operation();
    } catch (error) {
      if (
        error instanceof ExtensionConflictError ||
        error instanceof ExtensionNotFoundError ||
        error instanceof TypeError
      ) {
        throw error;
      }
      this.#degrade(error);
    }
    this.#saved();
  }

  #saved(): void {
    this.diagnostics.lastSavedAt = new Date().toISOString();
  }

  #degrade(error: unknown): void {
    this.diagnostics.status = 'degraded';
    this.diagnostics.backend = 'memory';
    this.diagnostics.message = `IndexedDB extension registry failed; using page memory: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function assertNoConflict(
  registry: Pick<ExtensionRegistry, 'get' | 'list'>,
  record: ExtensionRecord,
  ignoredExtensionId?: string,
): Promise<void> {
  const existing = await registry.get(record.extensionId);
  if (existing && existing.extensionId !== ignoredExtensionId) {
    throw new ExtensionConflictError(`Extension id is already installed: ${record.extensionId}`);
  }
  const target = normalizeLegacyName(record.legacyName);
  const conflict = (await registry.list()).find(
    (candidate) =>
      candidate.extensionId !== ignoredExtensionId &&
      normalizeLegacyName(candidate.legacyName) === target,
  );
  if (conflict) {
    throw new ExtensionConflictError(
      `Legacy extension path is already in use: ${record.legacyName}`,
    );
  }
}

function normalizeLegacyName(value: string): string {
  return value.replace(/^\/+|\/+$/gu, '').toLocaleLowerCase('en-US');
}

function compareRecords(left: ExtensionRecord, right: ExtensionRecord): number {
  return (
    left.manifest.display_name.localeCompare(right.manifest.display_name, 'en') ||
    left.extensionId.localeCompare(right.extensionId, 'en')
  );
}
