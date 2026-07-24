export type OpaqueJsonObject = Record<string, unknown>;

export interface ChatDocument {
  header: OpaqueJsonObject;
  messages: OpaqueJsonObject[];
}

export interface StoredChatSession {
  id: string;
  ownerId: string;
  ownerAlias: string;
  characterName: string;
  legacyFileName: string;
  header: OpaqueJsonObject;
  chatMetadata: OpaqueJsonObject;
  messageCount: number;
  byteSize: number;
  lastMessage: string;
  lastMessageAt: string | number;
  createdAt: string;
  updatedAt: string;
}

export interface OwnerAlias {
  ownerId: string;
  avatarUrl: string;
  updatedAt: string;
}

export interface ChatInfoDto {
  file_id: string;
  file_name: string;
  file_size: string;
  chat_items: number;
  mes: string;
  last_mes: string | number;
  chat_metadata?: OpaqueJsonObject;
}

export interface ChatSearchResultDto {
  file_name: string;
  file_size: string;
  message_count: number;
  last_mes: string | number;
  preview_message: string;
}

export interface RecentChatDto extends ChatInfoDto {
  avatar: string;
}

export function isJsonObject(value: unknown): value is OpaqueJsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function cloneJson<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Chat data must be JSON-serializable.');
  return JSON.parse(encoded) as T;
}

export function defaultChatHeader(): OpaqueJsonObject {
  return {
    chat_metadata: {},
    user_name: 'unused',
    character_name: 'unused',
  };
}

export function splitLegacyChat(chat: unknown[]): ChatDocument {
  if (chat.length === 0) return { header: defaultChatHeader(), messages: [] };
  const [header, ...messages] = chat;
  if (!isJsonObject(header)) throw new TypeError('Chat header must be a JSON object.');
  if (!messages.every(isJsonObject)) throw new TypeError('Chat messages must be JSON objects.');
  return {
    header: cloneJson(header),
    messages: cloneJson(messages),
  };
}

export function combineLegacyChat(document: ChatDocument): OpaqueJsonObject[] {
  return [cloneJson(document.header), ...cloneJson(document.messages)];
}

export function readChatMetadata(header: OpaqueJsonObject): OpaqueJsonObject {
  return isJsonObject(header.chat_metadata) ? cloneJson(header.chat_metadata) : {};
}

export function legacyFileId(fileName: string): string {
  return fileName.replace(/\.jsonl$/iu, '');
}

export function normalizeLegacyFileName(value: unknown): string {
  const input = String(value ?? '')
    .trim()
    .replace(/\.jsonl$/iu, '');
  const withoutControls = Array.from(input, (character) =>
    character.codePointAt(0)! <= 0x1f ? '_' : character,
  ).join('');
  const sanitized = withoutControls
    .replace(/[<>:"/\\|?*]/gu, '_')
    .replace(/[. ]+$/gu, '')
    .trim();
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new TypeError('Chat file name must be non-empty.');
  }
  return `${sanitized}.jsonl`;
}

export function normalizeAvatarUrl(value: unknown): string {
  const avatarUrl = String(value ?? '').trim();
  if (
    !avatarUrl ||
    avatarUrl.includes('/') ||
    avatarUrl.includes('\\') ||
    avatarUrl === '.' ||
    avatarUrl === '..'
  ) {
    throw new TypeError('avatar_url must be a safe file name.');
  }
  return avatarUrl;
}

export function serializeJsonl(document: ChatDocument): string {
  return combineLegacyChat(document)
    .map((value) => JSON.stringify(value))
    .join('\n');
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / 1024 ** unit;
  return `${Number(amount.toFixed(unit === 0 ? 0 : 2))} ${units[unit]}`;
}

export function previewMessage(message: string): string {
  return message.length > 400 ? `...${message.slice(-400)}` : message;
}
