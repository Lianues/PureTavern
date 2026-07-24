import { describe, expect, it } from 'vitest';

import type { ChatStatsSourceCapability } from '@/platform/features/standard-capabilities';

import { StatsDeriver, countAsciiWords, parseStatsTimestamp } from '../application/stats-deriver';
import type { CharacterStats } from '../domain/stats';

function source(
  chats: Awaited<ReturnType<ChatStatsSourceCapability['listChatsForStats']>>,
): ChatStatsSourceCapability {
  return {
    async listChatsForStats() {
      return chats;
    },
  };
}

describe('StatsDeriver', () => {
  it('recreates original message, swipe, timing, date, dedupe and byte-size semantics', async () => {
    const deriver = new StatsDeriver(
      source([
        {
          id: 'chat-b',
          ownerId: 'owner-a',
          avatarUrl: 'Alice.png',
          byteSize: 50,
          updatedAt: '2026-07-24T00:02:00.000Z',
          messages: [
            {
              is_user: false,
              mes: 'answer one',
              gen_started: '2026-07-24T00:00:00.000Z',
              gen_finished: '2026-07-24T00:00:01.000Z',
              swipes: ['answer one', 'answer two'],
              swipe_info: [
                {},
                {
                  gen_started: '2026-07-24T00:00:01.000Z',
                  gen_finished: '2026-07-24T00:00:01.500Z',
                },
              ],
            },
          ],
        },
        {
          id: 'chat-a',
          ownerId: 'owner-a',
          avatarUrl: 'Alice.png',
          byteSize: 100,
          updatedAt: '2026-07-24T00:01:00.000Z',
          messages: [
            {
              is_user: true,
              mes: 'hello world',
              send_date: '2026-7-24@00h00m30s123ms',
            },
          ],
        },
        {
          id: 'chat-c',
          ownerId: 'owner-a',
          avatarUrl: 'Alice.png',
          byteSize: 0,
          updatedAt: '2026-07-24T00:01:30.000Z',
          messages: [
            {
              is_user: false,
              mes: 'answer one',
              gen_started: '2026-07-24T00:00:00.000Z',
              gen_finished: '2026-07-24T00:00:10.000Z',
            },
          ],
        },
      ]),
      () => 123_456,
    );

    const document = await deriver.derive();
    const stats = document['Alice.png'] as CharacterStats;
    expect(document.timestamp).toBe(123_456);
    expect(stats).toMatchObject({
      total_gen_time: 1_500,
      user_word_count: 2,
      non_user_word_count: 4,
      user_msg_count: 1,
      non_user_msg_count: 2,
      total_swipe_count: 1,
      chat_size: 150,
      date_last_chat: Date.parse('2026-07-24T00:02:00.000Z'),
      date_first_chat: Date.parse('2026-07-24T00:00:30.123Z'),
    });
  });

  it('uses the original no-swipe-info generation estimate and isolates character totals', async () => {
    const deriver = new StatsDeriver(
      source([
        {
          id: 'one',
          ownerId: 'owner-b',
          avatarUrl: 'Bob.png',
          byteSize: 12,
          updatedAt: '2026-07-24T01:00:00.000Z',
          messages: [
            {
              is_user: false,
              mes: 'base',
              gen_started: '2026-07-24T00:00:00.000Z',
              gen_finished: '2026-07-24T00:00:00.100Z',
              swipes: ['base', 'second'],
            },
          ],
        },
      ]),
      () => 1,
    );
    const stats = (await deriver.derive())['Bob.png'] as CharacterStats;
    expect(stats.total_gen_time).toBe(300);
    expect(stats.non_user_msg_count).toBe(2);
    expect(stats.total_swipe_count).toBe(1);
  });

  it('matches Legacy ASCII word and supported timestamp parsing', () => {
    expect(countAsciiWords('two ASCII_words 中文')).toBe(2);
    expect(parseStatsTimestamp('1721779200000')).toBe(1_721_779_200_000);
    expect(parseStatsTimestamp('July 24, 2026 2:20pm')).toBeGreaterThan(0);
    expect(parseStatsTimestamp('invalid')).toBe(0);
  });
});
