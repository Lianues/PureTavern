import {
  assertExtensionId,
  isExtensionCapability,
  type ExtensionCapability,
  type ExtensionManifest,
} from '../domain/extension';
import type { ValidatedExtensionPackageFile } from '../ports/extension-package-assets';

export const DEFAULT_EXTENSION_PACKAGE_LIMITS = Object.freeze({
  maxFiles: 256,
  maxTotalBytes: 20 * 1024 * 1024,
  maxManifestBytes: 256 * 1024,
  maxPathLength: 240,
});

export interface ExtensionPackageLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxManifestBytes: number;
  maxPathLength: number;
}

export interface ExtensionPackageFile {
  path: string;
  data: Blob;
}

export interface ValidatedLocalExtensionPackage {
  manifest: ExtensionManifest;
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

export async function validateLocalExtensionPackage(
  inputFiles: readonly ExtensionPackageFile[],
  limits: ExtensionPackageLimits = DEFAULT_EXTENSION_PACKAGE_LIMITS,
): Promise<ValidatedLocalExtensionPackage> {
  assertPositiveLimits(limits);
  if (inputFiles.length === 0) fail('empty-package', 'Extension package is empty.');
  if (inputFiles.length > limits.maxFiles) {
    fail('file-count', `Extension package exceeds the ${limits.maxFiles} file limit.`);
  }

  const files: ExtensionPackageFile[] = [];
  const pathKeys = new Set<string>();
  let totalBytes = 0;
  for (const file of inputFiles) {
    if (!(file.data instanceof Blob))
      fail('invalid-file', 'Every package entry must contain a Blob.');
    const path = validatePackagePath(file.path, limits.maxPathLength);
    const conflictKey = path.normalize('NFKC').toLocaleLowerCase('en-US');
    if (pathKeys.has(conflictKey)) {
      fail('duplicate-path', `Duplicate or case-conflicting package path: ${path}`);
    }
    pathKeys.add(conflictKey);
    totalBytes += file.data.size;
    if (totalBytes > limits.maxTotalBytes) {
      fail('package-size', `Extension package exceeds the ${limits.maxTotalBytes} byte limit.`);
    }
    files.push({ path, data: file.data });
  }

  const manifestFile = files.find((file) => file.path === 'manifest.json');
  if (!manifestFile)
    fail('missing-manifest', 'Extension package must contain manifest.json at its root.');
  if (manifestFile.data.size > limits.maxManifestBytes) {
    fail('manifest-size', `manifest.json exceeds the ${limits.maxManifestBytes} byte limit.`);
  }

  const rawManifest = await parseManifestJson(manifestFile.data);
  const parsed = parsePackageManifest(rawManifest, limits.maxPathLength);
  const filePaths = new Set(files.map((file) => file.path));
  if (!filePaths.has(parsed.manifest.entrypoint.path)) {
    fail(
      'missing-entrypoint',
      `Manifest entrypoint does not exist: ${parsed.manifest.entrypoint.path}`,
    );
  }

  const expectedPaths = [...filePaths].filter((path) => path !== 'manifest.json').sort();
  const declaredPaths = Object.keys(parsed.hashes).sort();
  if (
    expectedPaths.length !== declaredPaths.length ||
    expectedPaths.some((path, index) => path !== declaredPaths[index])
  ) {
    fail(
      'hash-coverage',
      'Manifest hashes must contain every package file except manifest.json, with no extra paths.',
    );
  }

  const validatedFiles: ValidatedExtensionPackageFile[] = [];
  for (const file of files) {
    const digest = await sha256Hex(file.data);
    if (file.path !== 'manifest.json') {
      const expected = parsed.hashes[file.path];
      if (expected !== digest) {
        fail('hash-mismatch', `SHA-256 mismatch for package file: ${file.path}`);
      }
    }
    validatedFiles.push({ path: file.path, data: file.data, sha256: digest });
  }

  const packageHashInput = validatedFiles
    .map((file) => `${file.path}\u0000${file.sha256}`)
    .sort()
    .join('\n');
  const packageHash = await sha256Hex(new TextEncoder().encode(packageHashInput));

  return {
    manifest: parsed.manifest,
    files: validatedFiles,
    packageHash,
    totalBytes,
    fileCount: files.length,
  };
}

export function validatePackagePath(path: string, maxPathLength = 240): string {
  if (typeof path !== 'string') fail('invalid-path', 'Package path must be a string.');
  const normalized = path.normalize('NFC');
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
    /^[a-zA-Z]:/.test(normalized)
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
        segment.length > 100 ||
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

async function parseManifestJson(blob: Blob): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await blob.text()) as unknown;
    if (!isRecord(value)) fail('manifest-schema', 'manifest.json must contain a JSON object.');
    return value;
  } catch (error) {
    if (error instanceof ExtensionPackageValidationError) throw error;
    fail('manifest-json', `manifest.json is not valid JSON: ${String(error)}`);
  }
}

function parsePackageManifest(
  input: Record<string, unknown>,
  maxPathLength: number,
): { manifest: ExtensionManifest; hashes: Record<string, string> } {
  if (input.schema_version !== 1) {
    fail('manifest-schema', 'manifest schema_version must be 1.');
  }
  const id = requiredString(input.id, 'id', 128);
  try {
    assertExtensionId(id);
  } catch (error) {
    fail('manifest-id', error instanceof Error ? error.message : String(error));
  }
  const displayName = requiredString(input.display_name, 'display_name', 120);
  const version = requiredString(input.version, 'version', 64);
  const author = optionalString(input.author, 'author', 120);
  const description = optionalString(input.description, 'description', 2_000);

  if (!isRecord(input.entry)) fail('manifest-entry', 'Manifest entry must be an object.');
  if (input.entry.type !== 'iframe' && input.entry.type !== 'worker') {
    fail(
      'entry-type',
      'User extension entry.type must be iframe or worker; same-context is reserved for trusted built-ins.',
    );
  }
  const entryPath = validatePackagePath(
    requiredString(input.entry.path, 'entry.path', maxPathLength),
    maxPathLength,
  );
  if (input.entry.type === 'iframe' && !/\.html?$/i.test(entryPath)) {
    fail('entry-type', 'Iframe entrypoints must be an .html file.');
  }
  if (input.entry.type === 'worker' && !/\.(?:js|mjs)$/i.test(entryPath)) {
    fail('entry-type', 'Worker entrypoints must be a .js or .mjs file.');
  }

  const permissions = input.permissions ?? [];
  if (!Array.isArray(permissions) || !permissions.every(isExtensionCapability)) {
    fail('manifest-permissions', 'Manifest permissions contains an unknown capability.');
  }
  const requestedCapabilities = [...new Set(permissions as ExtensionCapability[])];

  if (!isRecord(input.hashes)) fail('manifest-hashes', 'Manifest hashes must be an object.');
  const hashes: Record<string, string> = {};
  for (const [rawPath, rawDigest] of Object.entries(input.hashes)) {
    const path = validatePackagePath(rawPath, maxPathLength);
    if (path === 'manifest.json') {
      fail('manifest-hashes', 'manifest.json cannot declare a self hash.');
    }
    if (typeof rawDigest !== 'string' || !/^[a-fA-F0-9]{64}$/.test(rawDigest)) {
      fail('manifest-hashes', `Hash for ${path} must be a 64-character SHA-256 hex digest.`);
    }
    if (Object.prototype.hasOwnProperty.call(hashes, path)) {
      fail('duplicate-path', `Duplicate manifest hash path: ${path}`);
    }
    hashes[path] = rawDigest.toLowerCase();
  }

  return {
    manifest: {
      schemaVersion: 1,
      id,
      displayName,
      version,
      author,
      description,
      entrypoint: { type: input.entry.type, path: entryPath },
      requestedCapabilities,
    },
    hashes,
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
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > maxLength) {
    fail('manifest-schema', `Manifest ${field} must be a string up to ${maxLength} characters.`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function assertPositiveLimits(limits: ExtensionPackageLimits): void {
  if (
    !Number.isInteger(limits.maxFiles) ||
    !Number.isInteger(limits.maxTotalBytes) ||
    !Number.isInteger(limits.maxManifestBytes) ||
    !Number.isInteger(limits.maxPathLength) ||
    Object.values(limits).some((value) => value <= 0)
  ) {
    throw new TypeError('Extension package limits must be positive integers.');
  }
}

function fail(code: string, message: string): never {
  throw new ExtensionPackageValidationError(code, message);
}
