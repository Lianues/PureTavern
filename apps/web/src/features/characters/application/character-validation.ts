const FORBIDDEN_VISIBLE_FILE_CHARS = /[\\/:*?"<>|]/;
const RESERVED_NAMES = new Set(['', '.', '..']);

export const MAX_AVATAR_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export class CharacterValidationError extends Error {}
export class CharacterNotFoundError extends Error {}
export class DuplicateCharacterError extends Error {}

export function sanitizeDisplayName(value: unknown, fallback = 'Character'): string {
  const text = String(value ?? '')
    .trim()
    .split('')
    .map((char) => (isControlCharacter(char) ? ' ' : char))
    .join('');
  return text || fallback;
}

export function sanitizeFileBaseName(value: unknown, fallback = 'Character'): string {
  const display = sanitizeDisplayName(value, fallback);
  const sanitized = display
    .replace(/[\\/:*?"<>|]/g, '')
    .split('')
    .filter((char) => !isControlCharacter(char))
    .join('')
    .replace(/[. ]+$/g, '')
    .trim();
  return RESERVED_NAMES.has(sanitized) ? fallback : sanitized;
}

export function normalizeAvatarFile(value: unknown): string {
  if (typeof value !== 'string') throw new CharacterValidationError('avatar_url must be a string.');
  const decoded = decodeURIComponent(value).trim();
  if (decoded !== value.trim() && /[\\/]/.test(decoded)) {
    throw new CharacterValidationError('avatar_url cannot contain path separators.');
  }
  if (/[\\/]/.test(decoded) || decoded.includes('..') || hasUnsafeFileCharacter(decoded)) {
    throw new CharacterValidationError('avatar_url cannot contain unsafe path characters.');
  }
  if (!decoded.toLowerCase().endsWith('.png')) {
    throw new CharacterValidationError('avatar_url must end with .png.');
  }
  const base = decoded.slice(0, -4);
  if (RESERVED_NAMES.has(base)) throw new CharacterValidationError('avatar_url is invalid.');
  return decoded;
}

export function normalizeInternalName(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const withoutExtension = text.toLowerCase().endsWith('.png') ? text.slice(0, -4) : text;
  return sanitizeFileBaseName(withoutExtension);
}

export function toAvatarFile(internalName: string): string {
  return `${normalizeInternalName(internalName)}.png`;
}

export function ensureSupportedImportType(value: unknown): 'json' | 'png' {
  const type = String(value ?? '').toLowerCase();
  if (type === 'json' || type === 'png') return type;
  throw new CharacterValidationError(
    `Unsupported character import format: ${type || '(missing)'}.`,
  );
}

export function ensureBlobSize(blob: Blob, maxBytes: number, label: string): void {
  if (blob.size > maxBytes) {
    throw new CharacterValidationError(`${label} is too large. Maximum size is ${maxBytes} bytes.`);
  }
}

export function ensureImageBlob(blob: Blob): void {
  if (blob.size === 0) return;
  if (blob.type && !blob.type.startsWith('image/')) {
    throw new CharacterValidationError('Avatar upload must be an image.');
  }
  ensureBlobSize(blob, MAX_AVATAR_BYTES, 'Avatar upload');
}

export function uniqueName(baseName: string, existing: ReadonlySet<string>): string {
  const base = sanitizeFileBaseName(baseName);
  for (let index = 0; index < 10000; index += 1) {
    const candidate = index === 0 ? base : `${base}${index}`;
    if (!existing.has(`${candidate}.png`)) return candidate;
  }
  throw new DuplicateCharacterError('Could not create a unique character filename.');
}

function hasUnsafeFileCharacter(value: string): boolean {
  return value
    .split('')
    .some((char) => isControlCharacter(char) || FORBIDDEN_VISIBLE_FILE_CHARS.test(char));
}

function isControlCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code >= 0 && code <= 31;
}

export function duplicateAvatarFileName(
  sourceAvatarFile: string,
  existing: ReadonlySet<string>,
): string {
  const avatarFile = normalizeAvatarFile(sourceAvatarFile);
  const baseWithMaybeSuffix = avatarFile.slice(0, -4);
  const parts = baseWithMaybeSuffix.split('_');
  const lastPart = parts[parts.length - 1] ?? '';
  let suffix = Number(lastPart);
  let baseName = baseWithMaybeSuffix;
  if (Number.isFinite(suffix) && String(suffix) === lastPart && parts.length > 1) {
    suffix += 1;
    baseName = parts.slice(0, -1).join('_');
  } else {
    suffix = 1;
  }

  for (let tries = 0; tries < 10000; tries += 1) {
    const candidate = `${baseName}_${suffix}.png`;
    if (!existing.has(candidate)) return candidate;
    suffix += 1;
  }
  throw new DuplicateCharacterError('Could not create a duplicate character filename.');
}
