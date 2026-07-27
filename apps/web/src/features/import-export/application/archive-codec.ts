import {
  PURE_TAVERN_ARCHIVE_FORMAT,
  PURE_TAVERN_ARCHIVE_SCHEMA_VERSION,
  type PureTavernArchiveFile,
  type PureTavernArchiveManifest,
  type PureTavernArchiveModule,
} from '@pure-tavern/contracts';
import { unzipSync, zipSync } from 'fflate';

import { ARCHIVE_MANIFEST_PATH, assertArchivePath, fail } from '../domain/archive';
import type { PortableArchiveEntry } from './archive-participant-registry';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface ArchiveMetadataInput {
  archiveId: string;
  createdAt: string;
  appVersion: string;
  upstreamVersion: string;
  includeSecrets: boolean;
  modules: PureTavernArchiveModule[];
}

export interface DecodedArchive {
  manifest: PureTavernArchiveManifest;
  entries: PortableArchiveEntry[];
  totalBytes: number;
}

export async function encodeArchive(
  metadata: ArchiveMetadataInput,
  inputEntries: readonly PortableArchiveEntry[],
): Promise<{ blob: Blob; manifest: PureTavernArchiveManifest }> {
  const entries: PortableArchiveEntry[] = [];
  for (const input of inputEntries) {
    const data = input.data.slice();
    entries.push({
      descriptor: {
        ...input.descriptor,
        size: data.byteLength,
        sha256: await sha256Hex(data),
      },
      data,
    });
  }
  entries.sort((left, right) => left.descriptor.path.localeCompare(right.descriptor.path, 'en'));
  assertUniqueArchiveEntries(entries.map((entry) => entry.descriptor));

  const manifest: PureTavernArchiveManifest = {
    format: PURE_TAVERN_ARCHIVE_FORMAT,
    schemaVersion: PURE_TAVERN_ARCHIVE_SCHEMA_VERSION,
    archiveId: metadata.archiveId,
    createdAt: metadata.createdAt,
    appVersion: metadata.appVersion,
    upstreamVersion: metadata.upstreamVersion,
    includeSecrets: metadata.includeSecrets,
    modules: [...metadata.modules].sort((left, right) =>
      left.moduleId.localeCompare(right.moduleId, 'en'),
    ),
    files: entries.map((entry) => entry.descriptor),
  };
  const encodedManifest = textEncoder.encode(JSON.stringify(manifest, null, 2));
  const zipped: Record<string, Uint8Array> = {
    [ARCHIVE_MANIFEST_PATH]: encodedManifest,
  };
  for (const entry of entries) zipped[entry.descriptor.path] = entry.data;
  const bytes = zipSync(zipped, { level: 6 });
  const copy = bytes.slice();
  return {
    blob: new Blob([copy.buffer], { type: 'application/zip' }),
    manifest,
  };
}

export async function decodeArchive(archive: Blob): Promise<DecodedArchive> {
  if (archive.size <= 0) fail('archive-size', 'Archive must not be empty.');
  const buffer = new Uint8Array(await archive.arrayBuffer());
  let output: Record<string, Uint8Array>;
  try {
    output = unzipSync(buffer, {
      filter(info) {
        if (info.name.endsWith('/')) return false;
        assertArchivePath(info.name);
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'ArchiveValidationError') throw error;
    fail('invalid-zip', `Archive is not a supported ZIP: ${errorMessage(error)}`);
  }

  const manifestBytes = output[ARCHIVE_MANIFEST_PATH];
  if (!manifestBytes) fail('missing-manifest', 'Archive does not contain manifest.json.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(manifestBytes)) as unknown;
  } catch (error) {
    fail('invalid-manifest', `Archive manifest is not valid JSON: ${errorMessage(error)}`);
  }
  const manifest = validateArchiveManifest(parsed);
  assertUniqueArchiveEntries(manifest.files);

  const expectedPaths = new Set([
    ARCHIVE_MANIFEST_PATH,
    ...manifest.files.map((file) => file.path),
  ]);
  for (const path of Object.keys(output)) {
    if (!expectedPaths.has(path))
      fail('extra-file', `Archive contains an undeclared file: ${path}`);
  }
  if (Object.keys(output).length !== expectedPaths.size) {
    fail('missing-file', 'Archive is missing one or more declared files.');
  }

  const entries: PortableArchiveEntry[] = [];
  let totalBytes = 0;
  for (const descriptor of manifest.files) {
    assertArchivePath(descriptor.path);
    const data = output[descriptor.path];
    if (!data) fail('missing-file', `Archive file is missing: ${descriptor.path}`);
    if (data.byteLength !== descriptor.size) {
      fail('size-mismatch', `Archive file size does not match manifest: ${descriptor.path}`);
    }
    if ((await sha256Hex(data)) !== descriptor.sha256.toLowerCase()) {
      fail('hash-mismatch', `Archive file hash does not match manifest: ${descriptor.path}`);
    }
    totalBytes += data.byteLength;
    entries.push({ descriptor, data: data.slice() });
  }
  return { manifest, entries, totalBytes };
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const copy = data.slice();
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function validateArchiveManifest(value: unknown): PureTavernArchiveManifest {
  if (!isRecord(value)) fail('invalid-manifest', 'Archive manifest must be an object.');
  assertNoUnsafeKeys(value);
  if (value.format !== PURE_TAVERN_ARCHIVE_FORMAT) {
    fail('invalid-format', 'File is not a PureTavern archive.');
  }
  if (value.schemaVersion !== PURE_TAVERN_ARCHIVE_SCHEMA_VERSION) {
    fail(
      'unsupported-version',
      `Unsupported archive schema version: ${String(value.schemaVersion)}`,
    );
  }
  if (
    typeof value.archiveId !== 'string' ||
    !value.archiveId ||
    typeof value.createdAt !== 'string' ||
    typeof value.appVersion !== 'string' ||
    typeof value.upstreamVersion !== 'string' ||
    typeof value.includeSecrets !== 'boolean' ||
    !Array.isArray(value.modules) ||
    !Array.isArray(value.files)
  ) {
    fail('invalid-manifest', 'Archive manifest fields are invalid.');
  }
  for (const module of value.modules) validateModule(module);
  for (const file of value.files) validateFile(file);
  return value as unknown as PureTavernArchiveManifest;
}

function validateModule(value: unknown): asserts value is PureTavernArchiveModule {
  if (
    !isRecord(value) ||
    typeof value.moduleId !== 'string' ||
    typeof value.displayName !== 'string' ||
    !Number.isSafeInteger(value.dataVersion) ||
    typeof value.sensitive !== 'boolean' ||
    !isNonNegativeInteger(value.recordCount) ||
    !isNonNegativeInteger(value.blobCount) ||
    !isNonNegativeInteger(value.totalBytes)
  ) {
    fail('invalid-manifest', 'Archive module descriptor is invalid.');
  }
}

function validateFile(value: unknown): asserts value is PureTavernArchiveFile {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    typeof value.moduleId !== 'string' ||
    (value.kind !== 'record' && value.kind !== 'blob') ||
    typeof value.collection !== 'string' ||
    typeof value.id !== 'string' ||
    !isNonNegativeInteger(value.size) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/iu.test(value.sha256) ||
    typeof value.updatedAt !== 'string'
  ) {
    fail('invalid-manifest', 'Archive file descriptor is invalid.');
  }
  if (value.contentType !== undefined && typeof value.contentType !== 'string') {
    fail('invalid-manifest', 'Archive file content type is invalid.');
  }
  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    fail('invalid-manifest', 'Archive blob metadata is invalid.');
  }
}

export function assertUniqueArchiveEntries(files: readonly PureTavernArchiveFile[]): void {
  const paths = new Set<string>();
  const targets = new Set<string>();
  for (const file of files) {
    const pathKey = file.path.normalize('NFKC').toLowerCase();
    const targetKey = [file.moduleId, file.kind, file.collection, file.id].join('\u001f');
    if (paths.has(pathKey)) fail('duplicate-path', `Duplicate archive path: ${file.path}`);
    if (targets.has(targetKey)) fail('duplicate-target', `Duplicate archive target: ${file.path}`);
    paths.add(pathKey);
    targets.add(targetKey);
  }
}

function assertNoUnsafeKeys(value: unknown): void {
  const visit = (item: unknown, depth: number): void => {
    if (depth > 40) fail('invalid-manifest', 'Archive manifest is nested too deeply.');
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        fail('unsafe-manifest', `Archive manifest contains an unsafe key: ${key}`);
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
