import type { ModuleRecordStore } from '@/platform/storage/app-storage';

import { cloneStatsDocument, normalizeStatsDocument, type StatsDocument } from '../domain/stats';
import type { StatsRepository } from '../ports/stats-repository';

const STATS_COLLECTION = 'documents';
const CURRENT_STATS_DOCUMENT = 'current';

export class IndexedDbStatsRepository implements StatsRepository {
  readonly #records: ModuleRecordStore;

  constructor(records: ModuleRecordStore) {
    this.#records = records;
  }

  async load(): Promise<StatsDocument | null> {
    const record = await this.#records.get<unknown>(STATS_COLLECTION, CURRENT_STATS_DOCUMENT);
    return record ? normalizeStatsDocument(record.value) : null;
  }

  async save(document: StatsDocument): Promise<void> {
    await this.#records.put(STATS_COLLECTION, CURRENT_STATS_DOCUMENT, cloneStatsDocument(document));
  }
}
