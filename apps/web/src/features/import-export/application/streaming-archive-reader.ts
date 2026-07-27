import type { PureTavernArchiveFile, PureTavernArchiveManifest } from '@pure-tavern/contracts';
import { sha256 } from 'js-sha256';

import { ARCHIVE_MANIFEST_PATH, assertArchivePath, fail } from '../domain/archive';
import type { PortableArchiveEntry } from './archive-participant-registry';
import { assertUniqueArchiveEntries, validateArchiveManifest } from './archive-codec';
import {
  readStreamingZipDirectory,
  readZipEntryBytes,
  streamZipEntry,
  StreamingZipError,
  type StreamingZipDirectory,
  type StreamingZipEntry,
  type StreamingZipOptions,
} from './streaming-zip';

const textDecoder = new TextDecoder();

export interface StreamingArchiveIndex {
  archive: Blob;
  manifest: PureTavernArchiveManifest;
  totalBytes: number;
  entriesByPath: ReadonlyMap<string, StreamingZipEntry>;
}

export async function indexStreamingArchive(
  archive: Blob,
  options: StreamingZipOptions = {},
): Promise<StreamingArchiveIndex> {
  if (archive.size <= 0) fail('archive-size', 'Archive must not be empty.');
  let directory: StreamingZipDirectory;
  try {
    directory = await readStreamingZipDirectory(archive, options);
  } catch (error) {
    if (error instanceof StreamingZipError) fail(error.code, error.message);
    throw error;
  }
  const files = directory.entries.filter((entry) => !entry.directory);
  if (files.length === 0) fail('empty-archive', 'Archive does not contain any files.');

  const entriesByPath = new Map<string, StreamingZipEntry>();
  const normalizedPaths = new Set<string>();
  for (const entry of files) {
    assertArchivePath(entry.path);
    const key = entry.path.normalize('NFKC').toLocaleLowerCase('en-US');
    if (normalizedPaths.has(key)) {
      fail(
        'duplicate-path',
        `Archive contains a duplicate or case-conflicting path: ${entry.path}`,
      );
    }
    normalizedPaths.add(key);
    entriesByPath.set(entry.path, entry);
  }

  const manifestEntry = entriesByPath.get(ARCHIVE_MANIFEST_PATH);
  if (!manifestEntry) fail('missing-manifest', 'Archive does not contain manifest.json.');
  let parsed: unknown;
  try {
    const bytes = await readZipEntryBytes(archive, manifestEntry, options);
    parsed = JSON.parse(textDecoder.decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof Error && error.name === 'ArchiveValidationError') throw error;
    fail(
      'invalid-manifest',
      `Archive manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = validateArchiveManifest(parsed);
  assertUniqueArchiveEntries(manifest.files);

  const expectedPaths = new Set([
    ARCHIVE_MANIFEST_PATH,
    ...manifest.files.map((file) => file.path),
  ]);
  for (const path of entriesByPath.keys()) {
    if (!expectedPaths.has(path))
      fail('extra-file', `Archive contains an undeclared file: ${path}`);
  }
  if (entriesByPath.size !== expectedPaths.size) {
    fail('missing-file', 'Archive is missing one or more declared files.');
  }

  let totalBytes = 0;
  for (const descriptor of manifest.files) {
    assertArchivePath(descriptor.path);
    const entry = entriesByPath.get(descriptor.path);
    if (!entry) fail('missing-file', `Archive file is missing: ${descriptor.path}`);
    if (entry.uncompressedSize !== descriptor.size) {
      fail('size-mismatch', `Archive file size does not match manifest: ${descriptor.path}`);
    }
    totalBytes += descriptor.size;
  }
  return { archive, manifest, totalBytes, entriesByPath };
}

export async function readStreamingArchiveEntry(
  index: StreamingArchiveIndex,
  descriptor: PureTavernArchiveFile,
  options: StreamingZipOptions = {},
): Promise<PortableArchiveEntry> {
  const zipEntry = index.entriesByPath.get(descriptor.path);
  if (!zipEntry) fail('missing-file', `Archive file is missing: ${descriptor.path}`);
  if (descriptor.size > 0x7fffffff) {
    fail('entry-too-large', `Archive file is too large for its module parser: ${descriptor.path}`);
  }
  const data = new Uint8Array(descriptor.size);
  const hasher = sha256.create();
  let offset = 0;
  try {
    await streamZipEntry(index.archive, zipEntry, {
      ...options,
      async onChunk(chunk) {
        hasher.update(chunk);
        data.set(chunk, offset);
        offset += chunk.byteLength;
      },
    });
  } catch (error) {
    if (error instanceof StreamingZipError) fail(error.code, error.message);
    throw error;
  }
  if (hasher.hex() !== descriptor.sha256.toLowerCase()) {
    fail('hash-mismatch', `Archive file hash does not match manifest: ${descriptor.path}`);
  }
  return { descriptor, data };
}
