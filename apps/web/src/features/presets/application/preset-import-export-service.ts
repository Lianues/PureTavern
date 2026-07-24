import { cloneJson, type PresetDocument, type PresetType } from '../domain/preset';
import {
  MAX_PRESET_NAME_LENGTH,
  normalizePresetName,
  normalizePresetType,
  PresetConflictError,
  PresetNotFoundError,
  PresetValidationError,
  validatePresetDocument,
} from './preset-validation';
import type { PresetService } from './preset-service';

export type PresetConflictStrategy = 'overwrite' | 'unique';

export interface PresetBundle {
  version: 1;
  type: PresetType;
  presets: Array<{ name: string; preset: PresetDocument }>;
}

export class PresetImportExportService {
  readonly #presets: PresetService;

  constructor(presets: PresetService) {
    this.#presets = presets;
  }

  async importSingle(
    typeInput: PresetType,
    nameInput: string,
    input: string | unknown,
    strategyInput: PresetConflictStrategy,
  ): Promise<string> {
    const type = normalizePresetType(typeInput);
    const name = normalizePresetName(nameInput);
    const strategy = normalizeStrategy(strategyInput);
    const value = parseJsonInput(input);
    validatePresetDocument(value);
    const targetName = await this.#resolveName(type, name, strategy);
    await this.#presets.save(type, targetName, value);
    return targetName;
  }

  async exportSingle(typeInput: PresetType, nameInput: string): Promise<PresetDocument> {
    const type = normalizePresetType(typeInput);
    const name = normalizePresetName(nameInput);
    const record = await this.#presets.get(type, name);
    if (!record) throw new PresetNotFoundError(`Preset not found: ${name}`);
    return cloneJson(record.value);
  }

  async exportSingleJson(typeInput: PresetType, nameInput: string, space = 2): Promise<string> {
    return JSON.stringify(await this.exportSingle(typeInput, nameInput), null, space);
  }

  async importBundle(
    typeInput: PresetType,
    input: string | unknown,
    strategyInput: PresetConflictStrategy,
  ): Promise<string[]> {
    const type = normalizePresetType(typeInput);
    const strategy = normalizeStrategy(strategyInput);
    const bundle = parseBundle(parseJsonInput(input));
    if (bundle.type !== type) {
      throw new PresetValidationError(
        `Preset bundle type ${bundle.type} does not match requested type ${type}.`,
      );
    }

    const imported: string[] = [];
    for (const entry of bundle.presets) {
      imported.push(await this.importSingle(type, entry.name, entry.preset, strategy));
    }
    return imported;
  }

  async exportBundle(typeInput: PresetType): Promise<PresetBundle> {
    const type = normalizePresetType(typeInput);
    const records = await this.#presets.list(type);
    return {
      version: 1,
      type,
      presets: records.map((record) => ({
        name: record.name,
        preset: cloneJson(record.value),
      })),
    };
  }

  async exportBundleJson(typeInput: PresetType, space = 2): Promise<string> {
    return JSON.stringify(await this.exportBundle(typeInput), null, space);
  }

  async #resolveName(
    type: PresetType,
    requestedName: string,
    strategy: PresetConflictStrategy,
  ): Promise<string> {
    if (!(await this.#presets.get(type, requestedName))) return requestedName;
    if (strategy === 'overwrite') return requestedName;

    for (let index = 2; index < 10_000; index += 1) {
      const suffix = ` (${index})`;
      const base = [...requestedName].slice(0, MAX_PRESET_NAME_LENGTH - suffix.length).join('');
      const candidate = normalizePresetName(`${base}${suffix}`);
      if (!(await this.#presets.get(type, candidate))) return candidate;
    }
    throw new PresetConflictError(`Could not create a unique preset name for: ${requestedName}`);
  }
}

function parseJsonInput(input: string | unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    throw new PresetValidationError('Preset import must contain valid JSON.', { cause: error });
  }
}

function parseBundle(value: unknown): PresetBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PresetValidationError('Preset bundle must be a JSON object.');
  }
  const candidate = value as Partial<PresetBundle>;
  const type = normalizePresetType(candidate.type);
  if (candidate.version !== 1 || !Array.isArray(candidate.presets)) {
    throw new PresetValidationError('Preset bundle must have version 1 and a presets array.');
  }
  const presets = candidate.presets.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new PresetValidationError('Preset bundle entries must be JSON objects.');
    }
    const item = entry as Partial<PresetBundle['presets'][number]>;
    const name = normalizePresetName(item.name);
    validatePresetDocument(item.preset);
    return { name, preset: cloneJson(item.preset) };
  });
  return { version: 1, type, presets };
}

function normalizeStrategy(value: unknown): PresetConflictStrategy {
  if (value !== 'overwrite' && value !== 'unique') {
    throw new PresetValidationError(
      'Preset import conflict strategy must be explicitly set to overwrite or unique.',
    );
  }
  return value;
}
