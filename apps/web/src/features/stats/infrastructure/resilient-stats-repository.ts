import { cloneStatsDocument, type StatsDocument } from '../domain/stats';
import type { StatsRepository } from '../ports/stats-repository';

export interface StatsStorageDiagnostics {
  status: 'ready' | 'degraded';
  backend: 'indexeddb' | 'memory';
  message: string | null;
  lastSavedAt: string | null;
}

export class MemoryStatsRepository implements StatsRepository {
  #document: StatsDocument | null = null;

  async load(): Promise<StatsDocument | null> {
    return this.#document ? cloneStatsDocument(this.#document) : null;
  }

  async save(document: StatsDocument): Promise<void> {
    this.#document = cloneStatsDocument(document);
  }
}

export class ResilientStatsRepository implements StatsRepository {
  readonly diagnostics: StatsStorageDiagnostics = {
    status: 'ready',
    backend: 'indexeddb',
    message: null,
    lastSavedAt: null,
  };

  readonly #primary: StatsRepository;
  readonly #fallback: StatsRepository;
  #degraded = false;

  constructor(primary: StatsRepository, fallback: StatsRepository = new MemoryStatsRepository()) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async load(): Promise<StatsDocument | null> {
    if (this.#degraded) return this.#fallback.load();
    try {
      const document = await this.#primary.load();
      if (document) await this.#fallback.save(document);
      return document;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.load();
    }
  }

  async save(document: StatsDocument): Promise<void> {
    await this.#fallback.save(document);
    const savedAt = new Date().toISOString();
    if (this.#degraded) {
      this.diagnostics.lastSavedAt = savedAt;
      return;
    }
    try {
      await this.#primary.save(document);
      this.diagnostics.lastSavedAt = savedAt;
    } catch (error) {
      this.#degrade(error);
      this.diagnostics.lastSavedAt = savedAt;
    }
  }

  #degrade(error: unknown): void {
    this.#degraded = true;
    this.diagnostics.status = 'degraded';
    this.diagnostics.backend = 'memory';
    this.diagnostics.message =
      error instanceof Error
        ? `Persistent stats storage is unavailable: ${error.message}`
        : 'Persistent stats storage is unavailable; using page memory for this session.';
  }
}
