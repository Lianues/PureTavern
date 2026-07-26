import type { ArchiveConflictStrategy } from '@pure-tavern/contracts';

export const ARCHIVE_MANIFEST_PATH = 'manifest.json';

// 每条文件描述符在 manifest 里约 450 字节，maxFiles 条约 9 MB；再加上历史归档把 blob metadata
// 内联进 manifest 的额外体积，上限必须留出足够余量，否则会出现导得出、导不回的备份。
export const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxFiles: 20_000,
  maxExpandedBytes: 1024 * 1024 * 1024,
  maxFileBytes: 512 * 1024 * 1024,
  maxManifestBytes: 32 * 1024 * 1024,
  maxPathLength: 500,
  maxCompressionRatio: 250,
});

export interface ArchiveLimits {
  maxArchiveBytes: number;
  maxFiles: number;
  maxExpandedBytes: number;
  maxFileBytes: number;
  maxManifestBytes: number;
  maxPathLength: number;
  maxCompressionRatio: number;
}

export interface ArchiveExportOptions {
  moduleIds?: readonly string[];
  includeSecrets?: boolean;
}

export interface ArchiveImportOptions {
  moduleIds?: readonly string[];
  includeSecrets?: boolean;
  strategy?: ArchiveConflictStrategy;
  createRecoveryPoint?: boolean;
}

export class ArchiveValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArchiveValidationError';
    this.code = code;
  }
}

export function assertArchivePath(path: string, maxLength: number): void {
  if (!path || path.length > maxLength) fail('unsafe-path', `Unsafe archive path: ${path}`);
  if (path.includes('\\') || path.startsWith('/') || /^[a-z]:/iu.test(path)) {
    fail('unsafe-path', `Unsafe archive path: ${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    fail('unsafe-path', `Unsafe archive path: ${path}`);
  }
  for (const character of path) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      fail('unsafe-path', `Unsafe archive path: ${path}`);
    }
  }
}

export function normalizeStrategy(value: unknown): ArchiveConflictStrategy {
  if (value === undefined || value === null || value === '') return 'merge';
  if (
    value === 'merge' ||
    value === 'skip' ||
    value === 'replace-module' ||
    value === 'replace-all'
  ) {
    return value;
  }
  fail('invalid-strategy', 'Archive conflict strategy is invalid.');
}

export function fail(code: string, message: string): never {
  throw new ArchiveValidationError(code, message);
}
