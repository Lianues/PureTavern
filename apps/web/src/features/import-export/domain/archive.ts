import type { ArchiveConflictStrategy } from '@pure-tavern/contracts';

export const ARCHIVE_MANIFEST_PATH = 'manifest.json';

/**
 * 归档上限只用来挡住畸形和恶意输入，不用来替用户决定他能存多少数据。
 * 一个用满的库有好几 GB 是正常的，卡在这里只会让用户导不出自己的东西。
 *
 * 两条内部约束必须一起动，否则会出现「导得出、导不回」的备份：
 * - 每条文件描述符在 manifest 里约 450 字节，所以 maxManifestBytes 要能装下 maxFiles 条；
 * - maxExpandedBytes 要给 maxArchiveBytes 留出解压后的余量。
 *
 * 真正的天花板不在这里，而是浏览器内存：解包会把整个归档读进内存再解压，
 * 所以多 GB 的包会先撞上内存而不是这些数字。
 */
export const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024 * 1024,
  maxFiles: 2_000_000,
  maxExpandedBytes: 128 * 1024 * 1024 * 1024,
  // 单文件受浏览器 ArrayBuffer 上限约束，再大也读不进来。
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  maxManifestBytes: 4 * 1024 * 1024 * 1024,
  maxPathLength: 500,
  maxCompressionRatio: 10_000,
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
