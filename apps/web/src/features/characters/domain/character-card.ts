export type JsonObject = Record<string, unknown>;

export interface CharacterCardData extends JsonObject {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  tags: string[];
  creator: string;
  character_version: string;
  alternate_greetings: string[];
  extensions: JsonObject;
}

export interface CharacterCard extends JsonObject {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creatorcomment: string;
  avatar: string;
  chat: string;
  talkativeness: number | string;
  fav: boolean;
  tags: string[];
  spec: string;
  spec_version: string;
  data: CharacterCardData;
  create_date?: string;
}

export interface LegacyCharacterDto extends JsonObject {
  name: string;
  avatar: string;
  chat: string;
  json_data: string;
  date_added: number;
  create_date: string;
  date_last_chat: number;
  chat_size: number;
  data_size: number;
  data: CharacterCardData;
}

export const UNSET_SENTINEL = '__@@UNSET@@__';

export function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Value must be JSON-serializable.');
  return JSON.parse(serialized) as T;
}

export function isPlainObject(value: unknown): value is JsonObject {
  return Object.prototype.toString.call(value) === '[object Object]';
}

export function tryParseJsonObject(value: unknown): JsonObject | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function humanizedDateTime(timestamp = Date.now()): string {
  const date = new Date(timestamp);
  const parts = {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    millisecond: date.getMilliseconds(),
  };
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}@${pad(parts.hour)}h${pad(
    parts.minute,
  )}m${pad(parts.second)}s${pad(parts.millisecond, 3)}ms`;
}

export function getPath(source: unknown, path: string): unknown {
  if (!path) return source;
  let current = source;
  for (const part of path.split('.')) {
    if (!isPlainObject(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function setPath(target: JsonObject, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return;
  let current: JsonObject = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!isPlainObject(next)) {
      current[part] = {};
    }
    current = current[part] as JsonObject;
  }
  current[parts[parts.length - 1]!] = value;
}

export function unsetPath(target: JsonObject, path: string): void {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return;
  let current: unknown = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(current)) return;
    current = current[part];
  }
  if (isPlainObject(current)) delete current[parts[parts.length - 1]!];
}

export function deepMerge<T>(target: T, source: unknown): T {
  if (!isPlainObject(target) || !isPlainObject(source)) return cloneJson(source as T);
  const result = cloneJson(target) as JsonObject;
  for (const [key, value] of Object.entries(source)) {
    const existing = result[key];
    result[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? deepMerge(existing, value)
        : cloneJson(value);
  }
  return result as T;
}

export function processUnsetSentinels(target: unknown, source: unknown): void {
  if (!isPlainObject(target) || !isPlainObject(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (value === UNSET_SENTINEL) {
      delete target[key];
    } else {
      processUnsetSentinels(target[key], value);
    }
  }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => asString(item).trim()).filter(Boolean);
  if (typeof value === 'string')
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  return [];
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return fallback;
}

function defaultExtensions(): JsonObject {
  return {
    talkativeness: 0.5,
    fav: false,
    world: '',
    depth_prompt: {
      prompt: '',
      depth: 4,
      role: 'system',
    },
  };
}

export function formatCharacterData(
  input: Record<string, unknown>,
  now = Date.now(),
): CharacterCard {
  const char = tryParseJsonObject(input.json_data) ?? {};
  unsetPath(char, 'json_data');

  const name = asString(input.ch_name ?? input.name, '');
  const description = asString(input.description);
  const personality = asString(input.personality);
  const scenario = asString(input.scenario);
  const firstMes = asString(input.first_mes);
  const mesExample = asString(input.mes_example);
  const creatorNotes = asString(input.creator_notes ?? input.creatorcomment);
  const tags = asStringArray(input.tags);
  const alternateGreetings = Array.isArray(input.alternate_greetings)
    ? asStringArray(input.alternate_greetings)
    : input.alternate_greetings
      ? [asString(input.alternate_greetings)]
      : [];
  const talkativeness = input.talkativeness ?? 0.5;
  const fav = asBoolean(input.fav, false);
  const depth = Number(input.depth_prompt_depth);
  const depthPrompt = {
    prompt: asString(input.depth_prompt_prompt),
    depth: Number.isFinite(depth) ? depth : 4,
    role: asString(input.depth_prompt_role, 'system'),
  };

  setPath(char, 'name', name);
  setPath(char, 'description', description);
  setPath(char, 'personality', personality);
  setPath(char, 'scenario', scenario);
  setPath(char, 'first_mes', firstMes);
  setPath(char, 'mes_example', mesExample);
  setPath(char, 'creatorcomment', creatorNotes);
  setPath(char, 'avatar', 'none');
  setPath(char, 'chat', `${name} - ${humanizedDateTime(now)}`);
  setPath(char, 'talkativeness', talkativeness);
  setPath(char, 'fav', fav);
  setPath(char, 'tags', tags);

  setPath(char, 'spec', 'chara_card_v2');
  setPath(char, 'spec_version', '2.0');
  setPath(char, 'data.name', name);
  setPath(char, 'data.description', description);
  setPath(char, 'data.personality', personality);
  setPath(char, 'data.scenario', scenario);
  setPath(char, 'data.first_mes', firstMes);
  setPath(char, 'data.mes_example', mesExample);
  setPath(char, 'data.creator_notes', creatorNotes);
  setPath(char, 'data.system_prompt', asString(input.system_prompt));
  setPath(char, 'data.post_history_instructions', asString(input.post_history_instructions));
  setPath(char, 'data.tags', tags);
  setPath(char, 'data.creator', asString(input.creator));
  setPath(char, 'data.character_version', asString(input.character_version));
  setPath(char, 'data.alternate_greetings', alternateGreetings);
  setPath(char, 'data.extensions', {
    ...defaultExtensions(),
    talkativeness,
    fav,
    world: asString(input.world),
    depth_prompt: depthPrompt,
  });

  if (typeof input.extensions === 'string' && input.extensions.trim()) {
    try {
      const extensions = JSON.parse(input.extensions) as unknown;
      if (isPlainObject(extensions)) {
        setPath(
          char,
          'data.extensions',
          deepMerge(getPath(char, 'data.extensions') as JsonObject, extensions),
        );
      }
    } catch {
      // Keep Legacy behavior: invalid extension JSON is ignored.
    }
  } else if (isPlainObject(input.extensions)) {
    setPath(
      char,
      'data.extensions',
      deepMerge(getPath(char, 'data.extensions') as JsonObject, input.extensions),
    );
  }

  return normalizeCharacterCard(char, { hoistDate: true, now });
}

export function convertLegacyToV2(input: JsonObject, now = Date.now()): CharacterCard {
  const card = formatCharacterData(
    {
      json_data: JSON.stringify(input),
      ch_name: input.name,
      description: input.description,
      personality: input.personality,
      scenario: input.scenario,
      first_mes: input.first_mes,
      mes_example: input.mes_example,
      creator_notes: input.creatorcomment ?? input.creator_notes,
      talkativeness: input.talkativeness,
      fav: input.fav,
      creator: input.creator,
      tags: input.tags,
      depth_prompt_prompt: input.depth_prompt_prompt,
      depth_prompt_depth: input.depth_prompt_depth,
      depth_prompt_role: input.depth_prompt_role,
    },
    now,
  );
  card.chat = asString(input.chat, card.chat);
  if (typeof input.create_date === 'string') card.create_date = input.create_date;
  return card;
}

export function readFromV2(input: JsonObject, now = Date.now()): CharacterCard {
  const char = cloneJson(input);
  unsetPath(char, 'json_data');

  if (!isPlainObject(char.data)) {
    return convertLegacyToV2(char, now);
  }

  const mappings: Record<string, string> = {
    name: 'name',
    description: 'description',
    personality: 'personality',
    scenario: 'scenario',
    first_mes: 'first_mes',
    mes_example: 'mes_example',
    talkativeness: 'extensions.talkativeness',
    fav: 'extensions.fav',
    tags: 'tags',
  };

  for (const [field, dataPath] of Object.entries(mappings)) {
    let value = getPath(char.data, dataPath);
    if (value === undefined) {
      if (dataPath === 'extensions.talkativeness') value = 0.5;
      else if (dataPath === 'extensions.fav') value = false;
      else if (field === 'tags') value = [];
      else value = '';
    }
    char[field] = value;
  }

  char.chat = asString(char.chat, `${asString(char.name)} - ${humanizedDateTime(now)}`);
  char.avatar = asString(char.avatar, 'none');
  char.creatorcomment = asString(char.creatorcomment ?? getPath(char, 'data.creator_notes'));
  char.spec = asString(char.spec, 'chara_card_v2');
  char.spec_version = asString(char.spec_version, char.spec === 'chara_card_v3' ? '3.0' : '2.0');

  const data = char.data as JsonObject;
  data.name = asString(data.name ?? char.name);
  data.description = asString(data.description ?? char.description);
  data.personality = asString(data.personality ?? char.personality);
  data.scenario = asString(data.scenario ?? char.scenario);
  data.first_mes = asString(data.first_mes ?? char.first_mes);
  data.mes_example = asString(data.mes_example ?? char.mes_example);
  data.creator_notes = asString(data.creator_notes ?? char.creatorcomment);
  data.system_prompt = asString(data.system_prompt);
  data.post_history_instructions = asString(data.post_history_instructions);
  data.tags = asStringArray(data.tags ?? char.tags);
  data.creator = asString(data.creator);
  data.character_version = asString(data.character_version);
  data.alternate_greetings = asStringArray(data.alternate_greetings);
  data.extensions = deepMerge(
    defaultExtensions(),
    isPlainObject(data.extensions) ? data.extensions : {},
  );

  return char as CharacterCard;
}

export function normalizeCharacterCard(
  input: unknown,
  options: { hoistDate?: boolean; now?: number } = {},
): CharacterCard {
  if (!isPlainObject(input)) throw new TypeError('Character card must be a JSON object.');
  const now = options.now ?? Date.now();
  const card = input.spec === undefined ? convertLegacyToV2(input, now) : readFromV2(input, now);
  const name = asString(getPath(card, 'data.name') ?? card.name).trim();
  if (!name) throw new TypeError('Character name is required.');
  card.name = name;
  card.data.name = name;
  card.chat = asString(card.chat, `${name} - ${humanizedDateTime(now)}`);
  if (options.hoistDate !== false && !card.create_date)
    card.create_date = new Date(now).toISOString();
  return card;
}

export function unsetPrivateFields<T extends JsonObject>(input: T): T {
  const card = cloneJson(input);
  setPath(card, 'fav', false);
  setPath(card, 'data.extensions.fav', false);
  unsetPath(card, 'chat');
  unsetPath(card, 'json_data');
  return card as T;
}

export function serializeCard(card: CharacterCard): string {
  return JSON.stringify(card);
}

export function calculateDataSize(data: unknown): number {
  if (!isPlainObject(data)) return 0;
  return Object.values(data).reduce<number>((total, value) => total + String(value).length, 0);
}

export function toLegacyCharacterDto(
  card: CharacterCard,
  options: {
    avatarFile: string;
    createdAt: string;
    updatedAt: string;
  },
): LegacyCharacterDto {
  const jsonData = serializeCard(card);
  const createdMs = Date.parse(options.createdAt);
  return {
    ...cloneJson(card),
    avatar: options.avatarFile,
    json_data: jsonData,
    date_added: Number.isFinite(createdMs) ? createdMs : 0,
    create_date: card.create_date ?? options.createdAt,
    date_last_chat: 0,
    chat_size: 0,
    data_size: calculateDataSize(card.data),
    data: cloneJson(card.data),
  };
}
