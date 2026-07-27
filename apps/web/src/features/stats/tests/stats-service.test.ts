import { describe, expect, it } from 'vitest';

import type { ChatStatsSourceCapability } from '@/platform/features/standard-capabilities';

import { StatsService } from '../application/stats-service';
import { StatsValidationError, type StatsDocument } from '../domain/stats';
import {
  MemoryStatsRepository,
  ResilientStatsRepository,
} from '../infrastructure/resilient-stats-repository';
import type { StatsRepository } from '../ports/stats-repository';

const emptySource: ChatStatsSourceCapability = {
  async listChatsForStats() {
    return [];
  },
};

describe('StatsService', () => {
  it('lazily recreates once, round-trips opaque fields and stamps full Legacy updates', async () => {
    let reads = 0;
    const source: ChatStatsSourceCapability = {
      async listChatsForStats() {
        reads += 1;
        return [];
      },
    };
    const repository = new MemoryStatsRepository();
    const service = new StatsService(repository, source, { now: () => 42 });

    await expect(service.get()).resolves.toEqual({ timestamp: 42 });
    await expect(service.get()).resolves.toEqual({ timestamp: 42 });
    expect(reads).toBe(1);

    await service.update({
      'Alice.png': {
        user_msg_count: '3',
        future: { retained: ['opaque'] },
      },
      topLevelFuture: 'kept',
      timestamp: 1,
    });
    await expect(service.get()).resolves.toEqual({
      'Alice.png': {
        user_msg_count: 3,
        future: { retained: ['opaque'] },
      },
      topLevelFuture: 'kept',
      timestamp: 42,
    });
  });

  it('accepts documents beyond the former serialized-length and node-count quotas', async () => {
    const service = new StatsService(new MemoryStatsRepository(), emptySource, { now: () => 7 });
    const payload = 'x'.repeat(2_000_001);
    const values = Array.from({ length: 50_001 }, (_, index) => index);

    await service.update({ payload, values });

    await expect(service.get()).resolves.toMatchObject({
      payload,
      values,
      timestamp: 7,
    });
  });

  it('serializes competing updates in invocation order', async () => {
    class DelayedRepository extends MemoryStatsRepository {
      override async save(document: StatsDocument): Promise<void> {
        if ((document.value as number) === 1)
          await new Promise((resolve) => setTimeout(resolve, 20));
        await super.save(document);
      }
    }
    let now = 10;
    const service = new StatsService(new DelayedRepository(), emptySource, {
      now: () => ++now,
    });

    const first = service.update({ value: 1 });
    const second = service.update({ value: 2 });
    await Promise.all([first, second]);
    await expect(service.get()).resolves.toMatchObject({ value: 2, timestamp: 12 });
  });

  it('rejects prototype-pollution input without persisting it', async () => {
    const service = new StatsService(new MemoryStatsRepository(), emptySource);
    await expect(
      service.update(JSON.parse('{"__proto__":{"polluted":true}}')),
    ).rejects.toBeInstanceOf(StatsValidationError);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('degrades failed persistent storage to non-throwing page memory', async () => {
    const failing: StatsRepository = {
      async load() {
        throw new Error('IndexedDB blocked');
      },
      async save() {
        throw new Error('IndexedDB blocked');
      },
    };
    const repository = new ResilientStatsRepository(failing);
    const service = new StatsService(repository, emptySource, { now: () => 5 });

    await expect(service.get()).resolves.toEqual({ timestamp: 5 });
    await service.update({ 'Alice.png': { user_msg_count: 1 } });
    await expect(service.get()).resolves.toMatchObject({
      'Alice.png': { user_msg_count: 1 },
    });
    expect(repository.diagnostics).toMatchObject({
      status: 'degraded',
      backend: 'memory',
      lastSavedAt: expect.any(String),
    });
  });
});
