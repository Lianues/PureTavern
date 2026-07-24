import type { ChatStatsSourceCapability } from '@/platform/features/standard-capabilities';

import { cloneStatsDocument, normalizeStatsDocument, type StatsDocument } from '../domain/stats';
import type { StatsRepository } from '../ports/stats-repository';
import { StatsDeriver } from './stats-deriver';

export interface StatsServiceOptions {
  now?: () => number;
}

export class StatsService {
  readonly #repository: StatsRepository;
  readonly #deriver: StatsDeriver;
  readonly #now: () => number;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    repository: StatsRepository,
    source: ChatStatsSourceCapability,
    options: StatsServiceOptions = {},
  ) {
    this.#repository = repository;
    this.#now = options.now ?? Date.now;
    this.#deriver = new StatsDeriver(source, this.#now);
  }

  get(): Promise<StatsDocument> {
    return this.#enqueue(async () => {
      const stored = await this.#repository.load();
      if (stored) return cloneStatsDocument(stored);
      return this.#deriveAndSave();
    });
  }

  update(input: unknown): Promise<StatsDocument> {
    return this.#enqueue(async () => {
      const normalized = normalizeStatsDocument(input);
      normalized.timestamp = this.#now();
      await this.#repository.save(normalized);
      return cloneStatsDocument(normalized);
    });
  }

  recreate(): Promise<StatsDocument> {
    return this.#enqueue(() => this.#deriveAndSave());
  }

  async #deriveAndSave(): Promise<StatsDocument> {
    const derived = normalizeStatsDocument(await this.#deriver.derive());
    await this.#repository.save(derived);
    return cloneStatsDocument(derived);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
