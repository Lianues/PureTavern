import type {
  ChatStatsSourceCapability,
  ChatStatsSourceItem,
} from '@/platform/features/standard-capabilities';

import {
  createEmptyCharacterStats,
  type CharacterStats,
  type StatsDocument,
} from '../domain/stats';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export class StatsDeriver {
  readonly #source: ChatStatsSourceCapability;
  readonly #now: () => number;

  constructor(source: ChatStatsSourceCapability, now: () => number = Date.now) {
    this.#source = source;
    this.#now = now;
  }

  async derive(): Promise<StatsDocument> {
    const chats = [...(await this.#source.listChatsForStats())].sort((left, right) =>
      left.id.localeCompare(right.id, 'en'),
    );
    const records = new Map<string, CharacterStats>();
    const seenMessages = new Map<string, Set<string>>();

    for (const chat of chats) {
      const stats = records.get(chat.avatarUrl) ?? createEmptyCharacterStats();
      records.set(chat.avatarUrl, stats);
      const seen = seenMessages.get(chat.avatarUrl) ?? new Set<string>();
      seenMessages.set(chat.avatarUrl, seen);
      addChatStats(stats, chat, seen);
    }

    const document: StatsDocument = {};
    for (const [avatarUrl, stats] of records) document[avatarUrl] = stats;
    document.timestamp = this.#now();
    return document;
  }
}

function addChatStats(
  stats: CharacterStats,
  chat: ChatStatsSourceItem,
  seenMessages: Set<string>,
): void {
  stats.chat_size += nonNegativeFinite(chat.byteSize);
  stats.date_last_chat = Math.max(stats.date_last_chat, parseStatsTimestamp(chat.updatedAt));

  for (const message of chat.messages) {
    const text = typeof message.mes === 'string' ? message.mes : '';
    if (text) {
      if (seenMessages.has(text)) continue;
      seenMessages.add(text);
    }

    const generationTime = generationDuration(message.gen_started, message.gen_finished);
    stats.total_gen_time += generationTime;
    if (Array.isArray(message.swipes) && !message.swipe_info) {
      stats.total_gen_time += generationTime * message.swipes.length;
    }

    if (text) addMessage(stats, Boolean(message.is_user), text);

    if (Array.isArray(message.swipes) && message.swipes.length > 1) {
      stats.total_swipe_count += message.swipes.length - 1;
      for (const swipe of message.swipes.slice(1)) {
        if (typeof swipe === 'string') addMessage(stats, Boolean(message.is_user), swipe);
      }
    }

    if (Array.isArray(message.swipe_info) && message.swipe_info.length > 1) {
      for (const swipe of message.swipe_info.slice(1)) {
        if (!isRecord(swipe)) continue;
        stats.total_gen_time += generationDuration(swipe.gen_started, swipe.gen_finished);
      }
    }

    if (message.is_user) {
      stats.date_first_chat = Math.min(
        stats.date_first_chat,
        parseStatsTimestamp(message.send_date),
      );
    }
  }
}

function addMessage(stats: CharacterStats, isUser: boolean, text: string): void {
  const words = countAsciiWords(text);
  if (isUser) {
    stats.user_word_count += words;
    stats.user_msg_count += 1;
  } else {
    stats.non_user_word_count += words;
    stats.non_user_msg_count += 1;
  }
}

export function countAsciiWords(value: string): number {
  return value.match(/\b\w+\b/gu)?.length ?? 0;
}

export function parseStatsTimestamp(value: unknown): number {
  if (!value) return 0;
  if (value instanceof Date) return finiteTimestamp(value.getTime());
  if (typeof value === 'number') return finiteTimestamp(value);
  if (typeof value !== 'string') return 0;

  if (/^\d+$/u.test(value)) return finiteTimestamp(Number(value));
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)) {
    return finiteTimestamp(new Date(value).getTime());
  }

  const meridiem = value.match(/^(\w+)\s(\d{1,2}),\s(\d{4})\s(\d{1,2}):(\d{1,2})(am|pm)$/iu);
  if (meridiem) {
    const monthName = meridiem[1] ?? '';
    const day = meridiem[2] ?? '';
    const year = meridiem[3] ?? '';
    const hour = meridiem[4] ?? '';
    const minute = meridiem[5] ?? '';
    const marker = meridiem[6] ?? '';
    const month = MONTH_NAMES.findIndex((candidate) => candidate === monthName) + 1;
    if (month > 0) {
      const hourNumber = Number(hour);
      const hour24 = marker.toLowerCase() === 'pm' ? (hourNumber % 12) + 12 : hourNumber % 12;
      return finiteTimestamp(
        new Date(
          `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}T${String(hour24).padStart(2, '0')}:${minute.padStart(2, '0')}:00`,
        ).getTime(),
      );
    }
  }

  const humanizedPatterns = [
    /^(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s(\d{1,3})ms$/u,
    /^(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s$/u,
    /^(\d{4})-(\d{1,2})-(\d{1,2}) @(\d{1,2})h (\d{1,2})m (\d{1,2})s (\d{1,3})ms$/u,
  ];
  for (const pattern of humanizedPatterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const year = match[1] ?? '';
    const month = match[2] ?? '';
    const day = match[3] ?? '';
    const hour = match[4] ?? '';
    const minute = match[5] ?? '';
    const second = match[6] ?? '';
    const milliseconds = match[7];
    const fraction = milliseconds ? `.${milliseconds.padStart(3, '0')}` : '';
    return finiteTimestamp(
      new Date(
        `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}${fraction}Z`,
      ).getTime(),
    );
  }

  return 0;
}

function generationDuration(start: unknown, finish: unknown): number {
  if (!start || !finish) return 0;
  const duration = new Date(String(finish)).getTime() - new Date(String(start)).getTime();
  return Number.isFinite(duration) ? duration : 0;
}

function finiteTimestamp(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
