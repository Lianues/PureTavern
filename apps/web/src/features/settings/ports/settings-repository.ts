import type { SettingsDocument } from '../domain/settings-document';

export interface SettingsRepository {
  load(): Promise<SettingsDocument | null>;
  save(settings: SettingsDocument): Promise<void>;
}
