import {
  cloneJson,
  type PresetDocument,
  type PresetRecord,
  type PresetType,
} from '../domain/preset';
import type { PresetStateRepository } from '../ports/preset-repository';
import { PresetSeedService } from './preset-seed-service';
import {
  normalizePresetName,
  normalizePresetType,
  PresetNotFoundError,
  validatePresetDocument,
} from './preset-validation';

export interface RestoredPreset {
  isDefault: boolean;
  preset: PresetDocument;
}

export class PresetService {
  readonly #repository: PresetStateRepository<PresetDocument>;
  readonly #seeds: PresetSeedService | null;
  #initialized = false;
  #initialization: Promise<void> | null = null;

  constructor(
    repository: PresetStateRepository<PresetDocument>,
    seeds: PresetSeedService | null = null,
  ) {
    this.#repository = repository;
    this.#seeds = seeds;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    if (!this.#initialization) {
      this.#initialization = (this.#seeds?.synchronize() ?? Promise.resolve())
        .then(() => {
          this.#initialized = true;
        })
        .finally(() => {
          this.#initialization = null;
        });
    }
    return this.#initialization;
  }

  async synchronizeDefaults(): Promise<void> {
    if (this.#seeds) await this.#seeds.synchronize();
    this.#initialized = true;
  }

  async list(typeInput: PresetType): Promise<PresetRecord<PresetDocument>[]> {
    const type = normalizePresetType(typeInput);
    await this.initialize();
    return this.#repository.list(type);
  }

  async get(
    typeInput: PresetType,
    nameInput: string,
  ): Promise<PresetRecord<PresetDocument> | null> {
    const type = normalizePresetType(typeInput);
    const name = normalizePresetName(nameInput);
    await this.initialize();
    return this.#repository.get(type, name);
  }

  async save(typeInput: PresetType, nameInput: string, valueInput: unknown): Promise<string> {
    const type = normalizePresetType(typeInput);
    const name = normalizePresetName(nameInput);
    validatePresetDocument(valueInput);
    const value = cloneJson(valueInput);
    await this.initialize();
    await this.#repository.save(type, name, value, {
      origin: 'user',
      userModified: true,
    });
    return name;
  }

  async delete(
    typeInput: PresetType,
    nameInput: string,
    options: { requireExisting?: boolean } = {},
  ): Promise<void> {
    const type = normalizePresetType(typeInput);
    const name = normalizePresetName(nameInput);
    await this.initialize();
    if (options.requireExisting !== false && !(await this.#repository.get(type, name))) {
      throw new PresetNotFoundError(`Preset not found: ${name}`);
    }
    await this.#repository.delete(type, name);
  }

  async rename(typeInput: PresetType, oldNameInput: string, newNameInput: string): Promise<void> {
    const type = normalizePresetType(typeInput);
    const oldName = normalizePresetName(oldNameInput);
    const newName = normalizePresetName(newNameInput);
    await this.initialize();
    if (!(await this.#repository.get(type, oldName))) {
      throw new PresetNotFoundError(`Preset not found: ${oldName}`);
    }
    await this.#repository.rename(type, oldName, newName);
  }

  async restore(typeInput: PresetType, nameInput: string): Promise<RestoredPreset> {
    const type = normalizePresetType(typeInput);
    const name = normalizePresetName(nameInput);
    if (!this.#seeds) return { isDefault: false, preset: {} };
    const entry = await this.#seeds.restore(type, name);
    return entry
      ? { isDefault: true, preset: cloneJson(entry.value) }
      : { isDefault: false, preset: {} };
  }
}
