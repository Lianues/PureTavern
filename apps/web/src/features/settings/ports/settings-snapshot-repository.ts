import type { SettingsSnapshot } from '../domain/settings-snapshot';

export interface SettingsSnapshotRepository {
  list(): Promise<SettingsSnapshot[]>;
  get(name: string): Promise<SettingsSnapshot | null>;
  put(snapshot: SettingsSnapshot): Promise<void>;
}
