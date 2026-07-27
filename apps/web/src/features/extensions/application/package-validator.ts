import { unzipSync, type UnzipFileInfo } from 'fflate';

import type { LegacyExtensionManifest } from '../domain/extension';
import type { ValidatedExtensionPackageFile } from '../ports/extension-package-assets';

export const DEFAULT_EXTENSION_PACKAGE_LIMITS = Object.freeze({
  maxArchiveBytes: 20 * 1024 * 1024,
  maxFiles: 2_000,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  maxManifestBytes: 256 * 1024,
  maxPathLength: 300,
  maxCompressionRatio: 200,
});

/**
 * 从本地迁移包里搬运扩展时用的上限。
 *
 * 默认那套是为「从不可信远端下载」定的：它要限制网络传输量和解压炸弹。迁移包是用户
 * 自己机器上已经存在的数据，那层理由不成立，用它去卡只会把用户既有的扩展整个拒之门外
 * （实测一个 59 MB 的扩展就会被 50 MB 的默认上限挡下）。
 * 路径安全和 manifest 结构校验一点不放宽，放开的只有体积和数量。
 */
export const MIGRATION_EXTENSION_PACKAGE_LIMITS: ExtensionPackageLimits = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024 * 1024,
  maxFiles: 2_000_000,
  maxTotalBytes: 64 * 1024 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  maxManifestBytes: 64 * 1024 * 1024,
  maxPathLength: 300,
  maxCompressionRatio: 10_000,
});

export interface ExtensionPackageLimits {
  maxArchiveBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxManifestBytes: number;
  maxPathLength: number;
  maxCompressionRatio: number;
}

export interface ExtensionPackageFile {
  path: string;
  data: Blob;
}

export interface ValidatedLegacyExtensionPackage {
  manifest: LegacyExtensionManifest;
  files: ValidatedExtensionPackageFile[];
  packageHash: string;
  totalBytes: number;
  fileCount: number;
}

export class ExtensionPackageValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ExtensionPackageValidationError';
    this.code = code;
  }
}

export function extractExtensionZip(
  archive: Blob,
  limits: ExtensionPackageLimits = DEFAULT_EXTENSION_PACKAGE_LIMITS,
): Promise<ExtensionPackageFile[]> {
  assertPositiveLimits(limits);
  if (archive.size <= 0 || archive.size > limits.maxArchiveBytes) {
    fail('archive-size', `Extension archive must be 1-${limits.maxArchiveBytes} bytes.`);
  }
  return archive.arrayBuffer().then((buffer) => {
    let declaredFiles = 0;
    let declaredTotal = 0;
    const compressedBytes = Math.max(archive.size, 1);
    let output: Record<string, Uint8Array>;
    try {
      output = unzipSync(new Uint8Array(buffer), {
        filter(info) {
          if (isIgnoredArchiveEntry(info.name) || info.name.endsWith('/')) return false;
          assertSafeZipEntry(info, limits.maxPathLength);
          declaredFiles += 1;
          declaredTotal += info.originalSize;
          if (declaredFiles > limits.maxFiles) {
            fail('file-count', `Extension archive exceeds the ${limits.maxFiles} file limit.`);
          }
          if (info.originalSize > limits.maxFileBytes) {
            fail('file-size', `Extension archive file is too large: ${info.name}`);
          }
          if (declaredTotal > limits.maxTotalBytes) {
            fail('expanded-size', 'Extension archive expands beyond the configured size limit.');
          }
          if (declaredTotal / compressedBytes > limits.maxCompressionRatio) {
            fail('compression-ratio', 'Extension archive compression ratio is unsafe.');
          }
          return true;
        },
      });
    } catch (error) {
      if (error instanceof ExtensionPackageValidationError) throw error;
      fail('invalid-zip', `Extension archive is not a supported ZIP: ${errorMessage(error)}`);
    }

    const entries = Object.entries(output).map(([path, data]) => ({ path, data }));
    const root = commonArchiveRoot(entries.map((entry) => entry.path));
    return entries.map((entry) => {
      const path = root ? entry.path.slice(root.length + 1) : entry.path;
      const copy = new Uint8Array(entry.data.byteLength);
      copy.set(entry.data);
      return {
        path,
        data: new Blob([copy.buffer], { type: mimeTypeForPath(path) }),
      };
    });
  });
}

export async function validateLegacyExtensionPackage(
  inputFiles: readonly ExtensionPackageFile[],
  limits: ExtensionPackageLimits = DEFAULT_EXTENSION_PACKAGE_LIMITS,
): Promise<ValidatedLegacyExtensionPackage> {
  assertPositiveLimits(limits);
  if (inputFiles.length === 0) fail('empty-package', 'Extension package is empty.');
  if (inputFiles.length > limits.maxFiles) {
    fail('file-count', `Extension package exceeds the ${limits.maxFiles} file limit.`);
  }

  const files: ExtensionPackageFile[] = [];
  const pathKeys = new Set<string>();
  let totalBytes = 0;
  for (const file of inputFiles) {
    if (!(file.data instanceof Blob)) {
      fail('invalid-file', 'Every package entry must contain a Blob.');
    }
    const path = validatePackagePath(file.path, limits.maxPathLength);
    const conflictKey = path.normalize('NFKC').toLocaleLowerCase('en-US');
    if (pathKeys.has(conflictKey)) {
      fail('duplicate-path', `Duplicate or case-conflicting package path: ${path}`);
    }
    pathKeys.add(conflictKey);
    if (file.data.size > limits.maxFileBytes) {
      fail('file-size', `Extension package file exceeds the size limit: ${path}`);
    }
    totalBytes += file.data.size;
    if (totalBytes > limits.maxTotalBytes) {
      fail('package-size', `Extension package exceeds the ${limits.maxTotalBytes} byte limit.`);
    }
    files.push({ path, data: file.data });
  }

  const manifestFile = files.find((file) => file.path === 'manifest.json');
  if (!manifestFile) {
    fail('missing-manifest', 'SillyTavern extension must contain manifest.json at its root.');
  }
  if (manifestFile.data.size > limits.maxManifestBytes) {
    fail('manifest-size', `manifest.json exceeds the ${limits.maxManifestBytes} byte limit.`);
  }
  const manifest = await parseLegacyManifest(manifestFile.data, limits.maxPathLength);

  const validatedFiles: ValidatedExtensionPackageFile[] = [];
  for (const file of files) {
    validatedFiles.push({
      path: file.path,
      data: file.data,
      sha256: await sha256Hex(file.data),
    });
  }
  const packageHash = await sha256Hex(
    new TextEncoder().encode(
      validatedFiles
        .map((file) => `${file.path}\u0000${file.sha256}`)
        .sort()
        .join('\n'),
    ),
  );
  return {
    manifest,
    files: validatedFiles,
    packageHash,
    totalBytes,
    fileCount: validatedFiles.length,
  };
}

export function validatePackagePath(path: string, maxPathLength = 300): string {
  if (typeof path !== 'string') fail('invalid-path', 'Package path must be a string.');
  const normalized = path.replace(/^\.\//u, '').normalize('NFC');
  if (!normalized || normalized.length > maxPathLength) {
    fail('invalid-path', `Package path must be 1-${maxPathLength} characters.`);
  }
  if (
    normalized !== normalized.trim() ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    normalized.includes('%') ||
    normalized.includes('?') ||
    normalized.includes('#') ||
    normalized.includes(':') ||
    hasControlCharacters(normalized) ||
    /^[a-zA-Z]:/u.test(normalized)
  ) {
    fail('unsafe-path', `Unsafe package path: ${path}`);
  }
  const segments = normalized.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.length > 140 ||
        segment.endsWith(' ') ||
        segment.endsWith('.'),
    )
  ) {
    fail('unsafe-path', `Unsafe package path: ${path}`);
  }
  return normalized;
}

export async function sha256Hex(data: Blob | Uint8Array): Promise<string> {
  let bytes: ArrayBuffer;
  if (data instanceof Blob) {
    bytes = await data.arrayBuffer();
  } else {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    bytes = copy.buffer;
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function parseLegacyManifest(
  blob: Blob,
  maxPathLength: number,
): Promise<LegacyExtensionManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await blob.text()) as unknown;
  } catch (error) {
    fail('manifest-json', `manifest.json is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) fail('manifest-schema', 'manifest.json must contain a JSON object.');
  const displayName = requiredString(value.display_name, 'display_name', 160);
  const version = optionalString(value.version, 'version', 80);
  const author = optionalString(value.author, 'author', 160);
  const js = optionalManifestResource(value.js, 'js', maxPathLength);
  const css = optionalManifestResource(value.css, 'css', maxPathLength);
  if (!js && !css) {
    fail('manifest-entrypoint', 'SillyTavern extension manifest must declare js and/or css.');
  }
  return {
    ...structuredClone(value),
    display_name: displayName,
    version: version || '0.0.0',
    author,
    ...(js ? { js } : {}),
    ...(css ? { css } : {}),
  };
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    fail(
      'manifest-schema',
      `Manifest ${field} must be a non-empty string up to ${maxLength} characters.`,
    );
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maxLength) {
    fail('manifest-schema', `Manifest ${field} must be a string up to ${maxLength} characters.`);
  }
  return value.trim();
}

function optionalManifestResource(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maxLength) {
    fail('manifest-schema', `Manifest ${field} must be a string up to ${maxLength} characters.`);
  }
  return value;
}

function assertSafeZipEntry(info: UnzipFileInfo, maxPathLength: number): void {
  validatePackagePath(info.name.replace(/\/$/u, ''), maxPathLength + 160);
  if (!Number.isSafeInteger(info.originalSize) || info.originalSize < 0) {
    fail('invalid-zip', `Extension archive contains an invalid size: ${info.name}`);
  }
}

function commonArchiveRoot(paths: readonly string[]): string | null {
  if (paths.some((path) => path === 'manifest.json')) return null;
  const roots = new Set(paths.map((path) => path.split('/')[0]).filter(Boolean));
  if (roots.size !== 1) return null;
  const root = [...roots][0];
  return root && paths.some((path) => path === `${root}/manifest.json`) ? root : null;
}

function isIgnoredArchiveEntry(path: string): boolean {
  const normalized = path.replace(/\\/gu, '/');
  return (
    normalized.startsWith('__MACOSX/') ||
    normalized.endsWith('/.DS_Store') ||
    normalized === '.DS_Store'
  );
}

function mimeTypeForPath(path: string): string {
  const extension = path.split('.').at(-1)?.toLocaleLowerCase('en-US');
  switch (extension) {
    case 'js':
    case 'mjs':
      return 'text/javascript';
    case 'css':
      return 'text/css';
    case 'json':
      return 'application/json';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'svg':
      return 'image/svg+xml';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'woff':
      return 'font/woff';
    case 'woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

function assertPositiveLimits(limits: ExtensionPackageLimits): void {
  if (
    Object.values(limits).some((value) => !Number.isInteger(value) || value <= 0) ||
    limits.maxFileBytes > limits.maxTotalBytes
  ) {
    throw new TypeError('Extension package limits must be positive coherent integers.');
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(code: string, message: string): never {
  throw new ExtensionPackageValidationError(code, message);
}
