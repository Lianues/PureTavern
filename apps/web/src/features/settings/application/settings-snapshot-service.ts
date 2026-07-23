import type { SettingsService } from './settings-service';
import {
  getSettingsSnapshotSize,
  serializeSettingsSnapshot,
  type SettingsSnapshot,
  type SettingsSnapshotSummary,
} from '../domain/settings-snapshot';
import type { SettingsSnapshotRepository } from '../ports/settings-snapshot-repository';

export class InvalidSettingsSnapshotNameError extends Error {}
export class SettingsSnapshotNotFoundError extends Error {}

export type SettingsSnapshotClock = () => number;

export class SettingsSnapshotService {
  readonly #settings: SettingsService;
  readonly #repository: SettingsSnapshotRepository;
  readonly #now: SettingsSnapshotClock;

  constructor(
    settings: SettingsService,
    repository: SettingsSnapshotRepository,
    now: SettingsSnapshotClock = () => Date.now(),
  ) {
    this.#settings = settings;
    this.#repository = repository;
    this.#now = now;
  }

  async listSnapshots(): Promise<SettingsSnapshotSummary[]> {
    const snapshots = await this.#repository.list();
    return snapshots
      .map(({ name, createdAt, size }) => ({ name, date: createdAt, size }))
      .sort((left, right) => right.date - left.date);
  }

  async createSnapshot(): Promise<SettingsSnapshotSummary> {
    const document = await this.#settings.getSettings();
    const createdAt = this.#now();
    const name = await this.#createUniqueName(createdAt);
    const snapshot: SettingsSnapshot = {
      name,
      document,
      createdAt,
      size: getSettingsSnapshotSize(document),
    };
    await this.#repository.put(snapshot);
    return { name, date: createdAt, size: snapshot.size };
  }

  async loadSnapshotContent(name: unknown): Promise<string> {
    const snapshot = await this.#getRequiredSnapshot(name);
    return serializeSettingsSnapshot(snapshot.document);
  }

  async restoreSnapshot(name: unknown): Promise<void> {
    const snapshot = await this.#getRequiredSnapshot(name);
    await this.#settings.saveSettings(snapshot.document);
  }

  async #getRequiredSnapshot(name: unknown): Promise<SettingsSnapshot> {
    const validName = validateSettingsSnapshotName(name);
    const snapshot = await this.#repository.get(validName);
    if (!snapshot)
      throw new SettingsSnapshotNotFoundError(`Settings snapshot not found: ${validName}`);
    return snapshot;
  }

  async #createUniqueName(createdAt: number): Promise<string> {
    const timestamp = new Date(createdAt).toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const baseName = `settings_default-user_${timestamp}`;
    let suffix = 0;

    while (true) {
      const name = `${baseName}${suffix ? `-${suffix}` : ''}.json`;
      if (!(await this.#repository.get(name))) return name;
      suffix += 1;
    }
  }
}

export function validateSettingsSnapshotName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    !value.startsWith('settings_') ||
    !value.endsWith('.json') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('..')
  ) {
    throw new InvalidSettingsSnapshotNameError('Invalid settings snapshot name.');
  }
  return value;
}
