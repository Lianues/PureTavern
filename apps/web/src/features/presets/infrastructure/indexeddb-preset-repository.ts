import type { ModuleRecordStore } from '@/platform/storage/app-storage';

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

export const PRESET_DOCUMENTS_COLLECTION = 'documents';
export const PRESET_ALIASES_COLLECTION = 'aliases';
export const PRESET_SEED_STATE_COLLECTION = 'seed-state';
export const PRESET_TOMBSTONES_COLLECTION = 'tombstones';

interface StoredPresetAlias {
  presetId: string;
}

interface StoredPresetTombstone {
  deletedAt: string;
}

export class IndexedDbPresetRepository implements PresetStateRepository<PresetDocument> {
  readonly #records: ModuleRecordStore;
  readonly #now: () => Date;
  readonly #uuid: () => string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(
    records: ModuleRecordStore,
    now: () => Date = () => new Date(),
    uuid: () => string = () => crypto.randomUUID(),
  ) {
    this.#records = records;
    this.#now = now;
    this.#uuid = uuid;
  }

  async list(typeInput: PresetType): Promise<PresetRecord<PresetDocument>[]> {
    const type = normalizePresetType(typeInput);
    await this.#writeTail;
    const prefix = `${type}:`;
    const records = await this.#records.list<PresetRecord<PresetDocument>>(
      PRESET_DOCUMENTS_COLLECTION,
    );
    return records
      .filter((record) => record.id.startsWith(prefix) && record.value.type === type)
      .map((record) => clonePresetRecord(record.value))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(
    typeInput: PresetType,
    nameInput: string,
  ): Promise<PresetRecord<PresetDocument> | null> {
    const type = normalizePresetType(typeInput);
    const name = normalizePresetName(nameInput);
    await this.#writeTail;
    return this.#get(type, name);
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
      const previous = await this.#get(type, name);
      const now = this.#now().toISOString();
      const id = previous?.id ?? this.#uuid();
      const record: PresetRecord<PresetDocument> = {
        id,
        type,
        name,
        value,
        metadata: makeMetadata(previous?.metadata, metadata, now),
      };

      await this.#records.put(PRESET_DOCUMENTS_COLLECTION, documentKey(type, id), record);
      await this.#records.put(PRESET_ALIASES_COLLECTION, nameKey(type, name), {
        presetId: id,
      } satisfies StoredPresetAlias);
      await this.#records.delete(PRESET_TOMBSTONES_COLLECTION, nameKey(type, name));
    });
  }

  async delete(typeInput: PresetType, nameInput: string): Promise<void> {
    const type = normalizePresetType(typeInput);
    const name = normalizePresetName(nameInput);
    return this.#write(async () => {
      const alias = await this.#records.get<StoredPresetAlias>(
        PRESET_ALIASES_COLLECTION,
        nameKey(type, name),
      );
      if (alias) {
        await this.#records.delete(PRESET_ALIASES_COLLECTION, nameKey(type, name));
        await this.#records.delete(
          PRESET_DOCUMENTS_COLLECTION,
          documentKey(type, alias.value.presetId),
        );
      }
      await this.#records.put(PRESET_TOMBSTONES_COLLECTION, nameKey(type, name), {
        deletedAt: this.#now().toISOString(),
      } satisfies StoredPresetTombstone);
    });
  }

  async rename(typeInput: PresetType, oldNameInput: string, newNameInput: string): Promise<void> {
    const type = normalizePresetType(typeInput);
    const oldName = normalizePresetName(oldNameInput);
    const newName = normalizePresetName(newNameInput);
    if (oldName === newName) return;

    return this.#write(async () => {
      const oldRecord = await this.#get(type, oldName);
      if (!oldRecord) return;
      const collision = await this.#get(type, newName);
      if (collision && collision.id !== oldRecord.id) {
        throw new PresetConflictError(`Preset already exists: ${newName}`);
      }

      const now = this.#now().toISOString();
      const renamed: PresetRecord<PresetDocument> = {
        ...oldRecord,
        name: newName,
        metadata: {
          ...oldRecord.metadata,
          origin: 'user',
          userModified: true,
          updatedAt: now,
        },
      };
      await this.#records.put(
        PRESET_DOCUMENTS_COLLECTION,
        documentKey(type, oldRecord.id),
        renamed,
      );
      await this.#records.put(PRESET_ALIASES_COLLECTION, nameKey(type, newName), {
        presetId: oldRecord.id,
      } satisfies StoredPresetAlias);
      await this.#records.delete(PRESET_ALIASES_COLLECTION, nameKey(type, oldName));
      await this.#records.delete(PRESET_TOMBSTONES_COLLECTION, nameKey(type, newName));
      await this.#records.put(PRESET_TOMBSTONES_COLLECTION, nameKey(type, oldName), {
        deletedAt: now,
      } satisfies StoredPresetTombstone);
    });
  }

  async isTombstoned(typeInput: PresetType, nameInput: string): Promise<boolean> {
    const type = normalizePresetType(typeInput);
    const name = normalizePresetName(nameInput);
    await this.#writeTail;
    return Boolean(
      await this.#records.get<StoredPresetTombstone>(
        PRESET_TOMBSTONES_COLLECTION,
        nameKey(type, name),
      ),
    );
  }

  async getSeedState(typeInput: PresetType): Promise<PresetSeedState | null> {
    const type = normalizePresetType(typeInput);
    await this.#writeTail;
    const record = await this.#records.get<PresetSeedState>(PRESET_SEED_STATE_COLLECTION, type);
    return record ? cloneJson(record.value) : null;
  }

  async saveSeedState(typeInput: PresetType, state: PresetSeedState): Promise<void> {
    const type = normalizePresetType(typeInput);
    const cloned = cloneJson(state);
    return this.#write(() => this.#records.put(PRESET_SEED_STATE_COLLECTION, type, cloned));
  }

  async #get(type: PresetType, name: string): Promise<PresetRecord<PresetDocument> | null> {
    const alias = await this.#records.get<StoredPresetAlias>(
      PRESET_ALIASES_COLLECTION,
      nameKey(type, name),
    );
    if (!alias) return null;
    const record = await this.#records.get<PresetRecord<PresetDocument>>(
      PRESET_DOCUMENTS_COLLECTION,
      documentKey(type, alias.value.presetId),
    );
    return record ? clonePresetRecord(record.value) : null;
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
