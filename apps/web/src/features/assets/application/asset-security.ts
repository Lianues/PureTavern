import { AssetLimitError, AssetValidationError } from './asset-errors';

export const ASSET_LIMITS = Object.freeze({
  maxFileBytes: 50 * 1024 * 1024,
  maxRemoteFileBytes: 50 * 1024 * 1024,
  maxZipBytes: 20 * 1024 * 1024,
  maxZipExpandedBytes: 100 * 1024 * 1024,
  maxZipFiles: 256,
  maxFilenameLength: 180,
  maxPathLength: 600,
});

const UNSAFE_EXTENSIONS = new Set([
  'app',
  'bat',
  'cmd',
  'com',
  'cpl',
  'dll',
  'exe',
  'hta',
  'htm',
  'html',
  'jar',
  'js',
  'jse',
  'lnk',
  'mjs',
  'msi',
  'pif',
  'ps1',
  'reg',
  'scr',
  'sh',
  'svg',
  'vb',
  'vbe',
  'vbs',
  'ws',
  'wsf',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  apng: 'image/png',
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  pdf: 'application/pdf',
  zip: 'application/zip',
  vrm: 'model/gltf-binary',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
};

export function sanitizeFilename(value: unknown, fallback = 'file'): string {
  if (typeof value !== 'string') return fallback;
  const normalized = stripControlCharacters(value.normalize('NFKC'))
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, ASSET_LIMITS.maxFilenameLength);
  return normalized || fallback;
}

export function assertSafeFilename(value: unknown, label = 'filename'): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AssetValidationError(`${label} must be a non-empty string.`);
  }
  if (value.length > ASSET_LIMITS.maxFilenameLength) {
    throw new AssetValidationError(`${label} is too long.`);
  }
  if (hasControlCharacters(value)) {
    throw new AssetValidationError(`${label} contains control characters.`);
  }
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new AssetValidationError(`${label} must not contain a path.`);
  }
  if (value.startsWith('.') || value.includes('..')) {
    throw new AssetValidationError(`${label} contains an unsafe traversal sequence.`);
  }
  const sanitized = sanitizeFilename(value);
  if (sanitized !== value.trim()) {
    throw new AssetValidationError(
      `${label} contains characters that are not safe in a file name.`,
    );
  }
  assertSafeExtension(sanitized);
  return sanitized;
}

export function assertSafePathSegment(value: unknown, label = 'path segment'): string {
  const segment = assertSafeFilename(value, label);
  if (segment.includes('.')) {
    const extension = getExtension(segment);
    if (extension) assertSafeExtension(segment);
  }
  return segment;
}

export function assertSafeExtension(filename: string): void {
  const extension = getExtension(filename);
  if (extension && UNSAFE_EXTENSIONS.has(extension)) {
    throw new AssetValidationError(`The .${extension} file extension is not allowed.`);
  }
}

export function getExtension(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index > 0 && index < filename.length - 1 ? filename.slice(index + 1).toLowerCase() : '';
}

export function withoutExtension(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index > 0 ? filename.slice(0, index) : filename;
}

export function mimeTypeForFilename(filename: string): string {
  return MIME_BY_EXTENSION[getExtension(filename)] ?? 'application/octet-stream';
}

export function extensionForMimeType(mimeType: string): string | null {
  switch (mimeType.toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'video/mp4':
      return 'mp4';
    case 'video/webm':
      return 'webm';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/wav':
      return 'wav';
    default:
      return null;
  }
}

export function assertFileSize(blob: Blob, limit = ASSET_LIMITS.maxFileBytes): void {
  if (blob.size <= 0) throw new AssetValidationError('The uploaded file is empty.');
  if (blob.size > limit) {
    throw new AssetLimitError(`The uploaded file exceeds the ${limit}-byte size limit.`);
  }
}

export function normalizeLegacyPath(value: unknown, allowedPrefixes?: readonly string[]): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AssetValidationError('Asset path must be a non-empty string.');
  }
  if (value.length > ASSET_LIMITS.maxPathLength) {
    throw new AssetValidationError('Asset path is too long.');
  }
  let pathname = value.trim();
  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      throw new AssetValidationError('Asset path is not a valid URL.');
    }
  } else {
    pathname = pathname.split(/[?#]/, 1)[0] ?? '';
  }
  if (pathname.includes('\\') || hasControlCharacters(pathname)) {
    throw new AssetValidationError('Asset path contains unsafe characters.');
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    throw new AssetValidationError('Asset path contains invalid percent encoding.');
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  pathname = pathname.replace(/\/{2,}/g, '/');
  const segments = pathname.slice(1).split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new AssetValidationError('Asset path contains an unsafe traversal segment.');
  }
  if (allowedPrefixes && !allowedPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    throw new AssetValidationError('Asset path is outside the supported asset namespaces.');
  }
  return pathname;
}

export function makeLegacyPath(prefix: string, ...segments: string[]): string {
  const safeSegments = segments.map((segment, index) =>
    assertSafePathSegment(segment, `path[${index}]`),
  );
  return normalizeLegacyPath(`${prefix.replace(/\/$/, '')}/${safeSegments.join('/')}`);
}

export function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function stripControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join('');
}

export function assertMimeMatchesExtension(filename: string, mimeType: string): void {
  const expected = mimeTypeForFilename(filename);
  if (expected === 'application/octet-stream') return;
  const normalizedExpected =
    expected === 'image/png' && getExtension(filename) === 'apng' ? 'image/png' : expected;
  if (mimeType && mimeType !== 'application/octet-stream' && mimeType !== normalizedExpected) {
    throw new AssetValidationError(
      `File extension .${getExtension(filename)} does not match detected MIME type ${mimeType}.`,
    );
  }
}
