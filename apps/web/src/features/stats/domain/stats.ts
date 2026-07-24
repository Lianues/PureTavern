export type StatsDocument = Record<string, unknown>;

export interface CharacterStats extends Record<string, unknown> {
  total_gen_time: number;
  user_word_count: number;
  non_user_word_count: number;
  user_msg_count: number;
  non_user_msg_count: number;
  total_swipe_count: number;
  chat_size: number;
  date_last_chat: number;
  date_first_chat: number;
}

export const NEVER_CHAT_TIMESTAMP = new Date('9999-12-31T23:59:59.999Z').getTime();

const MAX_DOCUMENT_LENGTH = 2_000_000;
const MAX_DOCUMENT_NODES = 50_000;
const MAX_DOCUMENT_DEPTH = 32;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const NUMERIC_FIELDS = new Set([
  'total_gen_time',
  'user_word_count',
  'non_user_word_count',
  'user_msg_count',
  'non_user_msg_count',
  'total_swipe_count',
  'chat_size',
  'date_last_chat',
  'date_first_chat',
]);

export class StatsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatsValidationError';
  }
}

export function createEmptyCharacterStats(): CharacterStats {
  return {
    total_gen_time: 0,
    user_word_count: 0,
    non_user_word_count: 0,
    user_msg_count: 0,
    non_user_msg_count: 0,
    total_swipe_count: 0,
    chat_size: 0,
    date_last_chat: 0,
    date_first_chat: NEVER_CHAT_TIMESTAMP,
  };
}

export function normalizeStatsDocument(value: unknown): StatsDocument {
  if (!isRecord(value)) throw new StatsValidationError('Stats document must be a JSON object.');

  let serialized: string;
  try {
    const candidate = JSON.stringify(value);
    if (candidate === undefined) throw new TypeError('Stats document is not JSON-serializable.');
    serialized = candidate;
  } catch (error) {
    throw new StatsValidationError(
      `Stats document must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (serialized.length > MAX_DOCUMENT_LENGTH) {
    throw new StatsValidationError('Stats document exceeds the local compatibility size limit.');
  }

  const cloned = JSON.parse(serialized) as unknown;
  assertSafeJson(cloned);
  if (!isRecord(cloned)) throw new StatsValidationError('Stats document must be a JSON object.');

  const normalized: StatsDocument = {};
  for (const [key, entry] of Object.entries(cloned)) {
    if (key === 'timestamp') {
      normalized[key] = normalizeNonNegativeNumber(entry);
      continue;
    }
    if (!isRecord(entry)) {
      normalized[key] = entry;
      continue;
    }
    const stats: Record<string, unknown> = { ...entry };
    for (const field of NUMERIC_FIELDS) {
      if (Object.hasOwn(stats, field)) stats[field] = normalizeNonNegativeNumber(stats[field]);
    }
    normalized[key] = stats;
  }
  return normalized;
}

export function cloneStatsDocument(document: StatsDocument): StatsDocument {
  return normalizeStatsDocument(document);
}

function normalizeNonNegativeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertSafeJson(root: unknown): void {
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_DOCUMENT_NODES) {
      throw new StatsValidationError('Stats document contains too many values.');
    }
    if (depth > MAX_DOCUMENT_DEPTH) {
      throw new StatsValidationError('Stats document is nested too deeply.');
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (UNSAFE_KEYS.has(key)) {
        throw new StatsValidationError(`Stats document contains an unsafe key: ${key}.`);
      }
      visit(item, depth + 1);
    }
  };
  visit(root, 0);
}
