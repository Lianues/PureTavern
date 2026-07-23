import type { SettingsStorageDiagnostics } from './resilient-settings-repository';
import { cloneSettingsSnapshot, type SettingsSnapshot } from '../domain/settings-snapshot';
import type { SettingsSnapshotRepository } from '../ports/settings-snapshot-repository';

export class MemorySettingsSnapshotRepository implements SettingsSnapshotRepository {
  readonly #snapshots = new Map<string, SettingsSnapshot>();

  async list(): Promise<SettingsSnapshot[]> {
    return [...this.#snapshots.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((snapshot) => cloneSettingsSnapshot(snapshot));
  }

  async get(name: string): Promise<SettingsSnapshot | null> {
    const snapshot = this.#snapshots.get(name);
    return snapshot ? cloneSettingsSnapshot(snapshot) : null;
  }

  async put(snapshot: SettingsSnapshot): Promise<void> {
    this.#snapshots.set(snapshot.name, cloneSettingsSnapshot(snapshot));
  }
}

export class ResilientSettingsSnapshotRepository implements SettingsSnapshotRepository {
  readonly diagnostics: SettingsStorageDiagnostics = {
    status: 'ready',
    backend: 'indexeddb',
    message: null,
    lastSavedAt: null,
  };

  readonly #primary: SettingsSnapshotRepository;
  readonly #fallback: SettingsSnapshotRepository;

  constructor(
    primary: SettingsSnapshotRepository,
    fallback: SettingsSnapshotRepository = new MemorySettingsSnapshotRepository(),
  ) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async list(): Promise<SettingsSnapshot[]> {
    try {
      const snapshots = await this.#primary.list();
      await Promise.all(snapshots.map((snapshot) => this.#fallback.put(snapshot)));
      return snapshots;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.list();
    }
  }

  async get(name: string): Promise<SettingsSnapshot | null> {
    try {
      const snapshot = await this.#primary.get(name);
      if (snapshot) await this.#fallback.put(snapshot);
      return snapshot;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.get(name);
    }
  }

  async put(snapshot: SettingsSnapshot): Promise<void> {
    await this.#fallback.put(snapshot);
    try {
      await this.#primary.put(snapshot);
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
