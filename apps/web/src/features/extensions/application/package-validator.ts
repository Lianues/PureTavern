import { unzipSync, type UnzipFileInfo } from 'fflate';

import type { LegacyExtensionManifest } from '../domain/extension';
import type { ValidatedExtensionPackageFile } from '../ports/extension-package-assets';

const MAX_EXTENSION_PACKAGE_PATH_LENGTH = 300;

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

export function extractExtensionZip(archive: Blob): Promise<ExtensionPackageFile[]> {
  if (archive.size <= 0) fail('archive-size', 'Extension archive must not be empty.');
  return archive.arrayBuffer().then((buffer) => {
    let output: Record<string, Uint8Array>;
    try {
      output = unzipSync(new Uint8Array(buffer), {
        filter(info) {
          if (isIgnoredArchiveEntry(info.name) || info.name.endsWith('/')) return false;
          assertSafeZipEntry(info, MAX_EXTENSION_PACKAGE_PATH_LENGTH);
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
): Promise<ValidatedLegacyExtensionPackage> {
  if (inputFiles.length === 0) fail('empty-package', 'Extension package is empty.');

  const files: ExtensionPackageFile[] = [];
  const pathKeys = new Set<string>();
  let totalBytes = 0;
  for (const file of inputFiles) {
    if (!(file.data instanceof Blob)) {
      fail('invalid-file', 'Every package entry must contain a Blob.');
    }
    const path = validatePackagePath(file.path, MAX_EXTENSION_PACKAGE_PATH_LENGTH);
    const conflictKey = path.normalize('NFKC').toLocaleLowerCase('en-US');
    if (pathKeys.has(conflictKey)) {
      fail('duplicate-path', `Duplicate or case-conflicting package path: ${path}`);
    }
    pathKeys.add(conflictKey);
    totalBytes += file.data.size;
    files.push({ path, data: file.data });
  }

  const manifestFile = files.find((file) => file.path === 'manifest.json');
  if (!manifestFile) {
    fail('missing-manifest', 'SillyTavern extension must contain manifest.json at its root.');
  }
  const manifest = await parseLegacyManifest(
    manifestFile.data,
    MAX_EXTENSION_PACKAGE_PATH_LENGTH,
  );

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
