import {
  cloneJson,
  clonePresetRecord,
  type PresetDocument,
  type PresetMetadata,
  type PresetRecord,
  type PresetSeedState,
  type PresetType,
} from '../domain/preset';
import type { PresetStateRepository } from '../ports/preset-repository';
import {
  normalizePresetName,
  normalizePresetType,
  PresetConflictError,
  validatePresetDocument,
} from '../application/preset-validation';

export interface PresetStorageDiagnostics {
  status: 'ready' | 'degraded';
  backend: 'indexeddb' | 'memory';
  message: string | null;
  lastSavedAt: string | null;
}

export class MemoryPresetRepository implements PresetStateRepository<PresetDocument> {
  readonly #documents = new Map<string, PresetRecord<PresetDocument>>();
  readonly #aliases = new Map<string, string>();
  readonly #tombstones = new Set<string>();
  readonly #seedStates = new Map<PresetType, PresetSeedState>();
  readonly #now: () => Date;
  readonly #uuid: () => string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(now: () => Date = () => new Date(), uuid: () => string = () => crypto.randomUUID()) {
    this.#now = now;
    this.#uuid = uuid;
  }

  async list(typeInput: PresetType): Promise<PresetRecord<PresetDocument>[]> {
    const type = normalizePresetType(typeInput);
    await this.#writeTail;
    return [...this.#documents.values()]
      .filter((record) => record.type === type)
      .map(clonePresetRecord)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(
    typeInput: PresetType,
    nameInput: string,
  ): Promise<PresetRecord<PresetDocument> | null> {
    const type = normalizePresetType(typeInput);
    const name = normalizePresetName(nameInput);
    await this.#writeTail;
    const id = this.#aliases.get(nameKey(type, name));
    const record = id ? this.#documents.get(documentKey(type, id)) : null;
    return record ? clonePresetRecord(record) : null;
  }

  async save(
    typeInput: PresetType,
    nameInput: string,
    valueInput: PresetDocument,
    metadata: Partial<PresetMetadata> = {},
  ): Promise<void> {
    const type = normalizePresetType(typeInput);
    const name = normalizePresetName(nameInput);
    validatePresetDocument(valueInput);
    const value = cloneJson(valueInput);

    return this.#write(async () => {
      const aliasKey = nameKey(type, name);
      const previousId = this.#aliases.get(aliasKey);
      const previous = previousId ? this.#documents.get(documentKey(type, previousId)) : undefined;
      const id = previous?.id ?? this.#uuid();
      const now = this.#now().toISOString();
      this.#documents.set(documentKey(type, id), {
        id,
        type,
        name,
        value,
        metadata: makeMetadata(previous?.metadata, metadata, now),
      });
      this.#aliases.set(aliasKey, id);
      this.#tombstones.delete(aliasKey);
    });
  }

  async delete(typeInput: PresetType, nameInput: string): Promise<void> {
    const type = normalizePresetType(typeInput);
    const name = normalizePresetName(nameInput);
    return this.#write(async () => {
      const key = nameKey(type, name);
      const id = this.#aliases.get(key);
      if (id) this.#documents.delete(documentKey(type, id));
      this.#aliases.delete(key);
      this.#tombstones.add(key);
    });
  }

  async rename(typeInput: PresetType, oldNameInput: string, newNameInput: string): Promise<void> {
    const type = normalizePresetType(typeInput);
    const oldName = normalizePresetName(oldNameInput);
    const newName = normalizePresetName(newNameInput);
    if (oldName === newName) return;

    return this.#write(async () => {
      const oldKey = nameKey(type, oldName);
      const newKey = nameKey(type, newName);
      const id = this.#aliases.get(oldKey);
      if (!id) return;
      const collision = this.#aliases.get(newKey);
      if (collision && collision !== id) {
        throw new PresetConflictError(`Preset already exists: ${newName}`);
      }
      const documentKeyValue = documentKey(type, id);
      const record = this.#documents.get(documentKeyValue);
      if (!record) return;
      this.#documents.set(documentKeyValue, {
        ...record,
        name: newName,
        metadata: {
          ...record.metadata,
          origin: 'user',
          userModified: true,
          updatedAt: this.#now().toISOString(),
        },
      });
      this.#aliases.delete(oldKey);
      this.#aliases.set(newKey, id);
      this.#tombstones.add(oldKey);
      this.#tombstones.delete(newKey);
    });
  }

  async isTombstoned(typeInput: PresetType, nameInput: string): Promise<boolean> {
    const type = normalizePresetType(typeInput);
    const name = normalizePresetName(nameInput);
    await this.#writeTail;
    return this.#tombstones.has(nameKey(type, name));
  }

  async getSeedState(typeInput: PresetType): Promise<PresetSeedState | null> {
    const type = normalizePresetType(typeInput);
    await this.#writeTail;
    const state = this.#seedStates.get(type);
    return state ? cloneJson(state) : null;
  }

  async saveSeedState(typeInput: PresetType, state: PresetSeedState): Promise<void> {
    const type = normalizePresetType(typeInput);
    const cloned = cloneJson(state);
    return this.#write(async () => {
      this.#seedStates.set(type, cloned);
    });
  }

  #write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeTail.then(operation, operation);
    this.#writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class ResilientPresetRepository implements PresetStateRepository<PresetDocument> {
  readonly diagnostics: PresetStorageDiagnostics = {
    status: 'ready',
    backend: 'indexeddb',
    message: null,
    lastSavedAt: null,
  };

  readonly #primary: PresetStateRepository<PresetDocument>;
  readonly #fallback: PresetStateRepository<PresetDocument>;

  constructor(
    primary: PresetStateRepository<PresetDocument>,
    fallback: PresetStateRepository<PresetDocument> = new MemoryPresetRepository(),
  ) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async list(type: PresetType): Promise<PresetRecord<PresetDocument>[]> {
    if (this.#isDegraded()) return this.#fallback.list(type);
    try {
      const records = await this.#primary.list(type);
      await Promise.all(
        records.map((record) =>
          this.#fallback.save(record.type, record.name, record.value, record.metadata),
        ),
      );
      return records;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.list(type);
    }
  }

  async get(type: PresetType, name: string): Promise<PresetRecord<PresetDocument> | null> {
    if (this.#isDegraded()) return this.#fallback.get(type, name);
    try {
      const record = await this.#primary.get(type, name);
      if (record) await this.#fallback.save(type, name, record.value, record.metadata);
      return record;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.get(type, name);
    }
  }

  async save(
    type: PresetType,
    name: string,
    value: PresetDocument,
    metadata?: Partial<PresetMetadata>,
  ): Promise<void> {
    await this.#fallback.save(type, name, value, metadata);
    if (!this.#isDegraded()) {
      try {
        await this.#primary.save(type, name, value, metadata);
      } catch (error) {
        this.#degrade(error);
      }
    }
    this.diagnostics.lastSavedAt = new Date().toISOString();
  }

  async delete(type: PresetType, name: string): Promise<void> {
    await this.#fallback.delete(type, name);
    if (!this.#isDegraded()) {
      try {
        await this.#primary.delete(type, name);
      } catch (error) {
        this.#degrade(error);
      }
    }
    this.diagnostics.lastSavedAt = new Date().toISOString();
  }

  async rename(type: PresetType, oldName: string, newName: string): Promise<void> {
    await this.#fallback.rename(type, oldName, newName);
    if (!this.#isDegraded()) {
      try {
        await this.#primary.rename(type, oldName, newName);
      } catch (error) {
        this.#degrade(error);
      }
    }
    this.diagnostics.lastSavedAt = new Date().toISOString();
  }

  async isTombstoned(type: PresetType, name: string): Promise<boolean> {
    if (this.#isDegraded()) return this.#fallback.isTombstoned(type, name);
    try {
      const tombstoned = await this.#primary.isTombstoned(type, name);
      return tombstoned || (await this.#fallback.isTombstoned(type, name));
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.isTombstoned(type, name);
    }
  }

  async getSeedState(type: PresetType): Promise<PresetSeedState | null> {
    if (this.#isDegraded()) return this.#fallback.getSeedState(type);
    try {
      const state = await this.#primary.getSeedState(type);
      if (state) await this.#fallback.saveSeedState(type, state);
      return state;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.getSeedState(type);
    }
  }

  async saveSeedState(type: PresetType, state: PresetSeedState): Promise<void> {
    await this.#fallback.saveSeedState(type, state);
    if (!this.#isDegraded()) {
      try {
        await this.#primary.saveSeedState(type, state);
      } catch (error) {
        this.#degrade(error);
      }
    }
    this.diagnostics.lastSavedAt = new Date().toISOString();
  }

  #isDegraded(): boolean {
    return this.diagnostics.backend === 'memory';
  }

  #degrade(error: unknown): void {
    this.diagnostics.status = 'degraded';
    this.diagnostics.backend = 'memory';
    this.diagnostics.message = error instanceof Error ? error.message : String(error);
  }
}

function makeMetadata(
  previous: PresetMetadata | undefined,
  incoming: Partial<PresetMetadata>,
  now: string,
): PresetMetadata {
  const origin = incoming.origin ?? 'user';
  const metadata: PresetMetadata = {
    origin,
    userModified: incoming.userModified ?? origin !== 'default',
    createdAt: previous?.createdAt ?? incoming.createdAt ?? now,
    updatedAt: now,
  };
  const sourceHash = incoming.sourceHash ?? previous?.sourceHash;
  if (sourceHash !== undefined) metadata.sourceHash = sourceHash;
  return metadata;
}

function nameKey(type: PresetType, name: string): string {
  return `${type}:${name}`;
}

function documentKey(type: PresetType, id: string): string {
  return `${type}:${id}`;
}
