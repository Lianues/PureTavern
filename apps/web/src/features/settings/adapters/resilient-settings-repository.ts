import { cloneSettingsDocument, type SettingsDocument } from '../domain/settings-document';
import type { SettingsRepository } from '../ports/settings-repository';

export interface SettingsStorageDiagnostics {
  status: 'ready' | 'degraded';
  backend: 'indexeddb' | 'memory';
  message: string | null;
  lastSavedAt: string | null;
}

export class MemorySettingsRepository implements SettingsRepository {
  #settings: SettingsDocument | null = null;

  async load(): Promise<SettingsDocument | null> {
    return this.#settings ? cloneSettingsDocument(this.#settings) : null;
  }

  async save(settings: SettingsDocument): Promise<void> {
    this.#settings = cloneSettingsDocument(settings);
  }
}

export class ResilientSettingsRepository implements SettingsRepository {
  readonly diagnostics: SettingsStorageDiagnostics = {
    status: 'ready',
    backend: 'indexeddb',
    message: null,
    lastSavedAt: null,
  };

  readonly #primary: SettingsRepository;
  readonly #fallback: SettingsRepository;

  constructor(
    primary: SettingsRepository,
    fallback: SettingsRepository = new MemorySettingsRepository(),
  ) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async load(): Promise<SettingsDocument | null> {
    try {
      const settings = await this.#primary.load();
      if (settings) await this.#fallback.save(settings);
      return settings;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.load();
    }
  }

  async save(settings: SettingsDocument): Promise<void> {
    await this.#fallback.save(settings);
    try {
      await this.#primary.save(settings);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    } catch (error) {
      this.#degrade(error);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    }
  }

  #degrade(error: unknown) {
    this.diagnostics.status = 'degraded';
    this.diagnostics.backend = 'memory';
    this.diagnostics.message = error instanceof Error ? error.message : String(error);
  }
}
