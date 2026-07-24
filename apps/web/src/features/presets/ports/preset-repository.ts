import type { PresetMetadata, PresetRecord, PresetSeedState, PresetType } from '../domain/preset';

export interface PresetRepository<T> {
  list(type: PresetType): Promise<PresetRecord<T>[]>;
  get(type: PresetType, name: string): Promise<PresetRecord<T> | null>;
  save(type: PresetType, name: string, value: T, metadata?: Partial<PresetMetadata>): Promise<void>;
  delete(type: PresetType, name: string): Promise<void>;
}

/**
 * Persistence operations needed for alias migration and default-content upgrades.
 * Modern consumers can depend only on PresetRepository; the application service
 * uses this richer port so those storage details never leak into Settings.
 */
export interface PresetStateRepository<T> extends PresetRepository<T> {
  rename(type: PresetType, oldName: string, newName: string): Promise<void>;
  isTombstoned(type: PresetType, name: string): Promise<boolean>;
  getSeedState(type: PresetType): Promise<PresetSeedState | null>;
  saveSeedState(type: PresetType, state: PresetSeedState): Promise<void>;
}
