import {
  cloneJson,
  PRESET_TYPES,
  type PresetDocument,
  type PresetSeedEntry,
  type PresetSeedManifest,
  type PresetType,
} from '../domain/preset';
import type { PresetStateRepository } from '../ports/preset-repository';
import type { PresetSeedLoader } from '../ports/preset-seed-loader';
import {
  normalizePresetName,
  normalizePresetType,
  PresetValidationError,
  validatePresetDocument,
  validateSourceHash,
} from './preset-validation';

export class PresetSeedService {
  readonly #repository: PresetStateRepository<PresetDocument>;
  readonly #loader: PresetSeedLoader;
  readonly #now: () => Date;
  #synchronization: Promise<void> | null = null;

  constructor(
    repository: PresetStateRepository<PresetDocument>,
    loader: PresetSeedLoader,
    now: () => Date = () => new Date(),
  ) {
    this.#repository = repository;
    this.#loader = loader;
    this.#now = now;
  }

  synchronize(): Promise<void> {
    if (this.#synchronization) return this.#synchronization;
    const synchronization = this.#performSynchronization();
    this.#synchronization = synchronization;
    return synchronization.finally(() => {
      if (this.#synchronization === synchronization) this.#synchronization = null;
    });
  }

  async restore(
    typeInput: PresetType,
    nameInput: string,
  ): Promise<PresetSeedEntry<PresetDocument> | null> {
    const type = normalizePresetType(typeInput);
    const name = normalizePresetName(nameInput);
    const manifest = validateManifest(await this.#loader.load());
    const entry = manifest.presets.find((item) => item.type === type && item.name === name);
    return entry ? cloneJson(entry) : null;
  }

  async #performSynchronization(): Promise<void> {
    const manifest = validateManifest(await this.#loader.load());
    const entriesByType = new Map<PresetType, PresetSeedEntry<PresetDocument>[]>();
    for (const type of PRESET_TYPES) entriesByType.set(type, []);
    for (const entry of manifest.presets) entriesByType.get(entry.type)?.push(entry);

    for (const type of PRESET_TYPES) {
      const entries = entriesByType.get(type) ?? [];
      for (const entry of entries) {
        if (await this.#repository.isTombstoned(type, entry.name)) continue;
        const existing = await this.#repository.get(type, entry.name);
        if (!existing) {
          await this.#repository.save(type, entry.name, entry.value, {
            origin: 'default',
            sourceHash: entry.sourceHash,
            userModified: false,
          });
          continue;
        }

        const isUnmodifiedDefault =
          existing.metadata.origin === 'default' && existing.metadata.userModified === false;
        if (isUnmodifiedDefault && existing.metadata.sourceHash !== entry.sourceHash) {
          await this.#repository.save(type, entry.name, entry.value, {
            origin: 'default',
            sourceHash: entry.sourceHash,
            userModified: false,
          });
        }
      }

      await this.#repository.saveSeedState(type, {
        sourceHashes: Object.fromEntries(entries.map((entry) => [entry.name, entry.sourceHash])),
        synchronizedAt: this.#now().toISOString(),
      });
    }
  }
}

export function validateManifest(value: unknown): PresetSeedManifest<PresetDocument> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PresetValidationError('Preset seed manifest must be a JSON object.');
  }
  const candidate = value as Partial<PresetSeedManifest<unknown>>;
  if (candidate.version !== 1 || !Array.isArray(candidate.presets)) {
    throw new PresetValidationError(
      'Preset seed manifest must have version 1 and a presets array.',
    );
  }

  const seen = new Set<string>();
  const presets = candidate.presets.map((rawEntry) => {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      throw new PresetValidationError('Preset seed entries must be JSON objects.');
    }
    const input = rawEntry as Partial<PresetSeedEntry<unknown>>;
    const type = normalizePresetType(input.type);
    const name = normalizePresetName(input.name);
    validatePresetDocument(input.value);
    const sourceHash = validateSourceHash(input.sourceHash);
    const key = `${type}\u001f${name}`;
    if (seen.has(key)) {
      throw new PresetValidationError(`Duplicate preset seed entry: ${type}/${name}`);
    }
    seen.add(key);
    return {
      type,
      name,
      value: cloneJson(input.value),
      sourceHash,
    } satisfies PresetSeedEntry<PresetDocument>;
  });

  return { version: 1, presets };
}
