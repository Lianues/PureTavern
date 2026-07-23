import { cloneSettingsDocument, type SettingsDocument } from '../domain/settings-document';
import type { SettingsRepository } from '../ports/settings-repository';

export type DefaultSettingsLoader = () => Promise<SettingsDocument>;

export class SettingsService {
  readonly #repository: SettingsRepository;
  readonly #loadDefaults: DefaultSettingsLoader;

  #current: SettingsDocument | undefined;
  #initialLoad: Promise<SettingsDocument> | undefined;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(repository: SettingsRepository, loadDefaults: DefaultSettingsLoader) {
    this.#repository = repository;
    this.#loadDefaults = loadDefaults;
  }

  async getSettings(): Promise<SettingsDocument> {
    await this.#writeQueue;
    if (this.#current) return cloneSettingsDocument(this.#current);

    this.#initialLoad ??= this.#loadInitialSettings();
    const settings = await this.#initialLoad;
    return cloneSettingsDocument(settings);
  }

  async saveSettings(value: unknown): Promise<void> {
    const snapshot = cloneSettingsDocument(value);
    await this.getSettings();

    const write = this.#writeQueue.then(async () => {
      await this.#repository.save(snapshot);
      this.#current = snapshot;
    });
    this.#writeQueue = write.catch(() => undefined);
    await write;
  }

  async #loadInitialSettings(): Promise<SettingsDocument> {
    const stored = await this.#repository.load();
    if (stored) {
      this.#current = cloneSettingsDocument(stored);
      return this.#current;
    }

    const defaults = cloneSettingsDocument(await this.#loadDefaults());
    await this.#repository.save(defaults);
    this.#current = defaults;
    return defaults;
  }
}
