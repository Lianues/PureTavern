const FORBIDDEN_VISIBLE_FILE_CHARS = /[\\/:*?"<>|]/;
const RESERVED_NAMES = new Set(['', '.', '..']);

export class WorldBookValidationError extends Error {}
export class WorldBookNotFoundError extends Error {}

export function normalizeWorldBookName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new WorldBookValidationError('World Book name must be a string.');
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value).trim();
  } catch {
    throw new WorldBookValidationError('World Book name is not valid URI text.');
  }

  if (
    RESERVED_NAMES.has(decoded) ||
    decoded.length > 240 ||
    decoded.includes('..') ||
    FORBIDDEN_VISIBLE_FILE_CHARS.test(decoded) ||
    decoded.split('').some(isControlCharacter)
  ) {
    throw new WorldBookValidationError('World Book name contains unsafe path characters.');
  }

  return decoded;
}

export function worldBookNameFromUpload(file: Blob): string {
  const candidate = (file as Blob & { name?: unknown }).name;
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new WorldBookValidationError('World Book import file must have a name.');
  }

  const fileName = candidate.trim();
  const extensionIndex = fileName.lastIndexOf('.');
  const withoutExtension = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  return normalizeWorldBookName(withoutExtension);
}

function isControlCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code >= 0 && code <= 31;
}
