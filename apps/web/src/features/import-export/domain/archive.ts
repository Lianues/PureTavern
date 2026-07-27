import type { ArchiveConflictStrategy } from '@pure-tavern/contracts';

export const ARCHIVE_MANIFEST_PATH = 'manifest.json';

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

export function assertArchivePath(path: string, maxLength = 500): void {
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
