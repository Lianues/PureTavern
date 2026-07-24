import type { StatsDocument } from '../domain/stats';

export interface StatsRepository {
  load(): Promise<StatsDocument | null>;
  save(document: StatsDocument): Promise<void>;
}
