import { Inflate, Zip, ZipDeflate } from 'fflate';

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const MAX_EOCD_BYTES = 65_557;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const DEFAULT_INPUT_CHUNK_SIZE = 64 * 1024;
const DEFAULT_BLOB_COMPACTION_BYTES = 4 * 1024 * 1024;

export interface StreamingZipEntry {
  path: string;
  flags: number;
  compression: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  directory: boolean;
}

export interface StreamingZipDirectory {
  entries: StreamingZipEntry[];
  centralDirectoryOffset: number;
  centralDirectorySize: number;
}

export interface ZipProgress {
  phase: 'scan' | 'read' | 'write';
  path?: string;
  loaded: number;
  total: number;
}

export interface StreamingZipOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ZipProgress) => void;
  inputChunkSize?: number;
}

export interface StreamZipEntryOptions extends StreamingZipOptions {
  onChunk: (chunk: Uint8Array) => void | Promise<void>;
}

export async function readStreamingZipDirectory(
  archive: Blob,
  options: StreamingZipOptions = {},
): Promise<StreamingZipDirectory> {
  assertNotAborted(options.signal);
  if (archive.size < 22) throw zipError('invalid-zip', 'ZIP archive is too small.');

  const tailOffset = Math.max(0, archive.size - MAX_EOCD_BYTES);
  const tail = new Uint8Array(await archive.slice(tailOffset).arrayBuffer());
  options.onProgress?.({ phase: 'scan', loaded: tail.byteLength, total: archive.size });
  assertNotAborted(options.signal);

  const eocdRelativeOffset = findSignatureBackwards(tail, EOCD_SIGNATURE);
  if (eocdRelativeOffset < 0 || eocdRelativeOffset + 22 > tail.byteLength) {
    throw zipError('invalid-zip', 'ZIP end-of-central-directory record was not found.');
  }
  const eocdOffset = tailOffset + eocdRelativeOffset;
  const eocd = viewOf(tail, eocdRelativeOffset);
  const diskNumber = eocd.getUint16(4, true);
  const centralDisk = eocd.getUint16(6, true);
  const entriesOnDisk = eocd.getUint16(8, true);
  let entryCount = eocd.getUint16(10, true);
  let centralDirectorySize = eocd.getUint32(12, true);
  let centralDirectoryOffset = eocd.getUint32(16, true);
  const commentLength = eocd.getUint16(20, true);
  if (eocdRelativeOffset + 22 + commentLength !== tail.byteLength) {
    throw zipError('invalid-zip', 'ZIP end record is truncated or has unexpected trailing data.');
  }
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw zipError('multi-disk', 'Multi-disk ZIP archives are not supported.');
  }

  if (
    entryCount === ZIP64_SENTINEL_16 ||
    centralDirectorySize === ZIP64_SENTINEL_32 ||
    centralDirectoryOffset === ZIP64_SENTINEL_32
  ) {
    const zip64 = await readZip64EndRecord(archive, eocdOffset, options.signal);
    entryCount = zip64.entryCount;
    centralDirectorySize = zip64.centralDirectorySize;
    centralDirectoryOffset = zip64.centralDirectoryOffset;
  }

  assertSafeRange(
    centralDirectoryOffset,
    centralDirectorySize,
    archive.size,
    'ZIP central directory',
  );
  const centralBytes = new Uint8Array(
    await archive
      .slice(centralDirectoryOffset, centralDirectoryOffset + centralDirectorySize)
      .arrayBuffer(),
  );
  options.onProgress?.({
    phase: 'scan',
    loaded: tail.byteLength + centralBytes.byteLength,
    total: archive.size,
  });
  assertNotAborted(options.signal);

  const entries: StreamingZipEntry[] = [];
  let offset = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralBytes.byteLength) {
      throw zipError('invalid-zip', 'ZIP central directory is truncated.');
    }
    const header = viewOf(centralBytes, offset);
    if (header.getUint32(0, true) !== CENTRAL_FILE_SIGNATURE) {
      throw zipError('invalid-zip', 'ZIP central directory contains an invalid file header.');
    }
    const flags = header.getUint16(8, true);
    const compression = header.getUint16(10, true);
    const crc32 = header.getUint32(16, true);
    const compressed32 = header.getUint32(20, true);
    const uncompressed32 = header.getUint32(24, true);
    const nameLength = header.getUint16(28, true);
    const extraLength = header.getUint16(30, true);
    const fileCommentLength = header.getUint16(32, true);
    const diskStart = header.getUint16(34, true);
    const localOffset32 = header.getUint32(42, true);
    const nextOffset = offset + 46 + nameLength + extraLength + fileCommentLength;
    if (nextOffset > centralBytes.byteLength) {
      throw zipError('invalid-zip', 'ZIP central-directory entry is truncated.');
    }
    if ((flags & 0x0001) !== 0) {
      throw zipError('encrypted-entry', 'Encrypted ZIP entries are not supported.');
    }
    if (compression !== 0 && compression !== 8) {
      throw zipError(
        'unsupported-compression',
        `ZIP compression method ${compression} is not supported.`,
      );
    }
    const nameBytes = centralBytes.subarray(offset + 46, offset + 46 + nameLength);
    const path = decodeZipName(nameBytes, (flags & 0x0800) !== 0);
    const extra = centralBytes.subarray(
      offset + 46 + nameLength,
      offset + 46 + nameLength + extraLength,
    );
    const resolved = resolveZip64Values(extra, {
      uncompressedSize: uncompressed32,
      compressedSize: compressed32,
      localHeaderOffset: localOffset32,
      diskStart,
    });
    if (resolved.diskStart !== 0) {
      throw zipError('multi-disk', 'Multi-disk ZIP archives are not supported.');
    }
    assertSafeRange(resolved.localHeaderOffset, 30, archive.size, `ZIP local header for ${path}`);
    entries.push({
      path,
      flags,
      compression,
      crc32,
      compressedSize: resolved.compressedSize,
      uncompressedSize: resolved.uncompressedSize,
      localHeaderOffset: resolved.localHeaderOffset,
      directory: path.endsWith('/'),
    });
    offset = nextOffset;
  }
  if (offset !== centralBytes.byteLength) {
    // A central-directory digital signature is legal but irrelevant to browser-local migration.
    // Rejecting trailing bytes keeps the parser deterministic and prevents hidden undeclared data.
    throw zipError('invalid-zip', 'ZIP central directory has unexpected trailing data.');
  }

  return { entries, centralDirectoryOffset, centralDirectorySize };
}

export async function streamZipEntry(
  archive: Blob,
  entry: StreamingZipEntry,
  options: StreamZipEntryOptions,
): Promise<void> {
  assertNotAborted(options.signal);
  if (entry.directory) return;
  const dataOffset = await readLocalDataOffset(archive, entry, options.signal);
  assertSafeRange(dataOffset, entry.compressedSize, archive.size, `ZIP entry ${entry.path}`);

  const crc = new Crc32();
  let outputBytes = 0;
  let compressedBytes = 0;
  const consume = async (chunk: Uint8Array): Promise<void> => {
    assertNotAborted(options.signal);
    if (chunk.byteLength === 0) return;
    outputBytes += chunk.byteLength;
    if (outputBytes > entry.uncompressedSize) {
      throw zipError('size-mismatch', `ZIP entry expands beyond its declared size: ${entry.path}`);
    }
    crc.update(chunk);
    await options.onChunk(chunk);
  };

  if (entry.compression === 0) {
    for await (const chunk of blobChunks(
      archive.slice(dataOffset, dataOffset + entry.compressedSize),
      options.inputChunkSize,
      options.signal,
    )) {
      compressedBytes += chunk.byteLength;
      await consume(chunk);
      options.onProgress?.({
        phase: 'read',
        path: entry.path,
        loaded: compressedBytes,
        total: entry.compressedSize,
      });
    }
  } else {
    const inflater = new Inflate();
    let emitted: Uint8Array[] = [];
    let inflateError: unknown = null;
    inflater.ondata = (chunk, final) => {
      try {
        if (chunk.byteLength > 0) emitted.push(chunk.slice());
        if (
          final &&
          outputBytes + emitted.reduce((sum, value) => sum + value.byteLength, 0) !==
            entry.uncompressedSize
        ) {
          // The definitive check is repeated below after the queued chunks are consumed.
        }
      } catch (error) {
        inflateError = error;
      }
    };
    try {
      for await (const chunk of blobChunks(
        archive.slice(dataOffset, dataOffset + entry.compressedSize),
        options.inputChunkSize,
        options.signal,
      )) {
        compressedBytes += chunk.byteLength;
        inflater.push(chunk, compressedBytes === entry.compressedSize);
        if (inflateError) throw inflateError;
        const current = emitted;
        emitted = [];
        for (const output of current) await consume(output);
        options.onProgress?.({
          phase: 'read',
          path: entry.path,
          loaded: compressedBytes,
          total: entry.compressedSize,
        });
        await yieldToBrowser();
      }
      if (entry.compressedSize === 0) inflater.push(new Uint8Array(), true);
      if (inflateError) throw inflateError;
      const current = emitted;
      emitted = [];
      for (const output of current) await consume(output);
    } catch (error) {
      assertNotAborted(options.signal);
      if (isStreamingZipError(error)) throw error;
      throw zipError(
        'invalid-deflate',
        `ZIP entry could not be decompressed: ${entry.path} (${message(error)})`,
      );
    }
  }

  if (compressedBytes !== entry.compressedSize) {
    throw zipError('size-mismatch', `ZIP entry is truncated: ${entry.path}`);
  }
  if (outputBytes !== entry.uncompressedSize) {
    throw zipError(
      'size-mismatch',
      `ZIP entry size does not match its directory record: ${entry.path}`,
    );
  }
  if (crc.digest() !== entry.crc32) {
    throw zipError('crc-mismatch', `ZIP entry failed its CRC32 check: ${entry.path}`);
  }
}

export async function readZipEntryBytes(
  archive: Blob,
  entry: StreamingZipEntry,
  options: StreamingZipOptions = {},
): Promise<Uint8Array> {
  if (entry.uncompressedSize > 0x7fffffff) {
    throw zipError(
      'entry-too-large',
      `ZIP entry is too large for an in-memory parser: ${entry.path}`,
    );
  }
  const output = new Uint8Array(entry.uncompressedSize);
  let offset = 0;
  await streamZipEntry(archive, entry, {
    ...options,
    onChunk(chunk) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    },
  });
  return output;
}

export class StreamingZipWriter {
  readonly #zip: Zip;
  readonly #options: StreamingZipOptions;
  readonly #builder: CompactingBlobBuilder;
  readonly #finished: Promise<void>;
  #resolveFinished!: () => void;
  #rejectFinished!: (error: unknown) => void;
  #ended = false;
  #failed: unknown = null;

  constructor(options: StreamingZipOptions = {}) {
    this.#options = options;
    this.#builder = new CompactingBlobBuilder(DEFAULT_BLOB_COMPACTION_BYTES);
    this.#finished = new Promise<void>((resolve, reject) => {
      this.#resolveFinished = resolve;
      this.#rejectFinished = reject;
    });
    // terminate() may happen before end() is awaited; attach a rejection observer up front.
    void this.#finished.catch(() => undefined);
    this.#zip = new Zip((error, chunk, final) => {
      if (error) {
        this.#failed = error;
        this.#rejectFinished(error);
        return;
      }
      if (chunk.byteLength > 0) this.#builder.append(chunk);
      if (final) this.#resolveFinished();
    });
  }

  async add(
    path: string,
    source: Blob | Uint8Array,
    level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6,
  ): Promise<void> {
    if (this.#ended) throw new Error('Cannot add a ZIP entry after end().');
    if (this.#failed) throw this.#failed;
    assertNotAborted(this.#options.signal);
    const file = new ZipDeflate(path, { level });
    this.#zip.add(file);
    const total = source instanceof Blob ? source.size : source.byteLength;
    let loaded = 0;
    for await (const chunk of sourceChunks(
      source,
      this.#options.inputChunkSize,
      this.#options.signal,
    )) {
      loaded += chunk.byteLength;
      file.push(chunk, loaded === total);
      this.#options.onProgress?.({ phase: 'write', path, loaded, total });
      await yieldToBrowser();
    }
    if (total === 0) file.push(new Uint8Array(), true);
    if (this.#failed) throw this.#failed;
  }

  async end(type = 'application/zip'): Promise<Blob> {
    if (!this.#ended) {
      this.#ended = true;
      this.#zip.end();
    }
    await this.#finished;
    if (this.#failed) throw this.#failed;
    return this.#builder.finish(type);
  }

  terminate(): void {
    this.#zip.terminate();
    if (!this.#ended) {
      this.#ended = true;
      this.#rejectFinished(zipError('aborted', 'ZIP writing was aborted.'));
    }
  }
}

class CompactingBlobBuilder {
  readonly #threshold: number;
  #blob = new Blob();
  #parts: ArrayBuffer[] = [];
  #pendingBytes = 0;

  constructor(threshold: number) {
    this.#threshold = threshold;
  }

  append(chunk: Uint8Array): void {
    this.#parts.push(chunk.slice().buffer as ArrayBuffer);
    this.#pendingBytes += chunk.byteLength;
    if (this.#pendingBytes >= this.#threshold) this.#compact();
  }

  finish(type: string): Blob {
    this.#compact();
    return new Blob([this.#blob], { type });
  }

  #compact(): void {
    if (this.#parts.length === 0) return;
    this.#blob = new Blob([this.#blob, ...this.#parts]);
    this.#parts = [];
    this.#pendingBytes = 0;
  }
}

interface Zip64ResolutionInput {
  uncompressedSize: number;
  compressedSize: number;
  localHeaderOffset: number;
  diskStart: number;
}

function resolveZip64Values(extra: Uint8Array, input: Zip64ResolutionInput): Zip64ResolutionInput {
  const resolved = { ...input };
  if (
    input.uncompressedSize !== ZIP64_SENTINEL_32 &&
    input.compressedSize !== ZIP64_SENTINEL_32 &&
    input.localHeaderOffset !== ZIP64_SENTINEL_32 &&
    input.diskStart !== ZIP64_SENTINEL_16
  ) {
    return resolved;
  }
  let offset = 0;
  while (offset + 4 <= extra.byteLength) {
    const view = viewOf(extra, offset);
    const id = view.getUint16(0, true);
    const size = view.getUint16(2, true);
    const start = offset + 4;
    const end = start + size;
    if (end > extra.byteLength) throw zipError('invalid-zip', 'ZIP extra field is truncated.');
    if (id === 0x0001) {
      let cursor = start;
      const read64 = (): number => {
        if (cursor + 8 > end) throw zipError('invalid-zip', 'ZIP64 extra field is truncated.');
        const value = safeNumber(viewOf(extra, cursor).getBigUint64(0, true), 'ZIP64 value');
        cursor += 8;
        return value;
      };
      if (input.uncompressedSize === ZIP64_SENTINEL_32) resolved.uncompressedSize = read64();
      if (input.compressedSize === ZIP64_SENTINEL_32) resolved.compressedSize = read64();
      if (input.localHeaderOffset === ZIP64_SENTINEL_32) resolved.localHeaderOffset = read64();
      if (input.diskStart === ZIP64_SENTINEL_16) {
        if (cursor + 4 > end) throw zipError('invalid-zip', 'ZIP64 disk field is truncated.');
        resolved.diskStart = viewOf(extra, cursor).getUint32(0, true);
      }
      return resolved;
    }
    offset = end;
  }
  throw zipError('invalid-zip', 'ZIP64 sentinel is present without a ZIP64 extra field.');
}

async function readZip64EndRecord(
  archive: Blob,
  eocdOffset: number,
  signal?: AbortSignal,
): Promise<{ entryCount: number; centralDirectorySize: number; centralDirectoryOffset: number }> {
  if (eocdOffset < 20) throw zipError('invalid-zip', 'ZIP64 locator is missing.');
  const locator = new Uint8Array(await archive.slice(eocdOffset - 20, eocdOffset).arrayBuffer());
  assertNotAborted(signal);
  const locatorView = viewOf(locator);
  if (locatorView.getUint32(0, true) !== ZIP64_LOCATOR_SIGNATURE) {
    throw zipError('invalid-zip', 'ZIP64 locator is missing.');
  }
  if (locatorView.getUint32(4, true) !== 0 || locatorView.getUint32(16, true) !== 1) {
    throw zipError('multi-disk', 'Multi-disk ZIP64 archives are not supported.');
  }
  const recordOffset = safeNumber(locatorView.getBigUint64(8, true), 'ZIP64 end-record offset');
  assertSafeRange(recordOffset, 56, archive.size, 'ZIP64 end record');
  const record = new Uint8Array(await archive.slice(recordOffset, recordOffset + 56).arrayBuffer());
  assertNotAborted(signal);
  const view = viewOf(record);
  if (view.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) {
    throw zipError('invalid-zip', 'ZIP64 end record is invalid.');
  }
  if (view.getUint32(16, true) !== 0 || view.getUint32(20, true) !== 0) {
    throw zipError('multi-disk', 'Multi-disk ZIP64 archives are not supported.');
  }
  const entriesOnDisk = safeNumber(view.getBigUint64(24, true), 'ZIP64 entry count');
  const entryCount = safeNumber(view.getBigUint64(32, true), 'ZIP64 entry count');
  if (entriesOnDisk !== entryCount) {
    throw zipError('multi-disk', 'Multi-disk ZIP64 archives are not supported.');
  }
  return {
    entryCount,
    centralDirectorySize: safeNumber(view.getBigUint64(40, true), 'ZIP64 directory size'),
    centralDirectoryOffset: safeNumber(view.getBigUint64(48, true), 'ZIP64 directory offset'),
  };
}

async function readLocalDataOffset(
  archive: Blob,
  entry: StreamingZipEntry,
  signal?: AbortSignal,
): Promise<number> {
  const bytes = new Uint8Array(
    await archive.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer(),
  );
  assertNotAborted(signal);
  if (bytes.byteLength !== 30)
    throw zipError('invalid-zip', `ZIP local header is truncated: ${entry.path}`);
  const view = viewOf(bytes);
  if (view.getUint32(0, true) !== LOCAL_FILE_SIGNATURE) {
    throw zipError('invalid-zip', `ZIP local header is invalid: ${entry.path}`);
  }
  const flags = view.getUint16(6, true);
  const compression = view.getUint16(8, true);
  if ((flags & 0x0001) !== 0 || compression !== entry.compression) {
    throw zipError('invalid-zip', `ZIP local header disagrees with the directory: ${entry.path}`);
  }
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  assertSafeRange(dataOffset, entry.compressedSize, archive.size, `ZIP entry ${entry.path}`);
  return dataOffset;
}

async function* sourceChunks(
  source: Blob | Uint8Array,
  chunkSize = DEFAULT_INPUT_CHUNK_SIZE,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (source instanceof Blob) {
    yield* blobChunks(source, chunkSize, signal);
    return;
  }
  const size = normalizeChunkSize(chunkSize);
  for (let offset = 0; offset < source.byteLength; offset += size) {
    assertNotAborted(signal);
    yield source.subarray(offset, Math.min(source.byteLength, offset + size));
  }
}

async function* blobChunks(
  blob: Blob,
  chunkSize = DEFAULT_INPUT_CHUNK_SIZE,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const size = normalizeChunkSize(chunkSize);
  for (let offset = 0; offset < blob.size; offset += size) {
    assertNotAborted(signal);
    const bytes = new Uint8Array(
      await blob.slice(offset, Math.min(blob.size, offset + size)).arrayBuffer(),
    );
    assertNotAborted(signal);
    yield bytes;
  }
}

function normalizeChunkSize(value: number): number {
  return Number.isSafeInteger(value) && value >= 1024 ? value : DEFAULT_INPUT_CHUNK_SIZE;
}

function decodeZipName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // TauriTavern and PureTavern emit UTF-8 names. For manually repacked legacy archives without
  // the language flag, UTF-8-first is more useful than interpreting every byte as CP437.
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!decoded.includes('\ufffd')) return decoded;
  return [...bytes].map((value) => String.fromCharCode(value)).join('');
}

function findSignatureBackwards(bytes: Uint8Array, signature: number): number {
  for (let offset = bytes.byteLength - 4; offset >= 0; offset -= 1) {
    if (viewOf(bytes, offset).getUint32(0, true) === signature) return offset;
  }
  return -1;
}

function viewOf(bytes: Uint8Array, offset = 0): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
}

function assertSafeRange(offset: number, length: number, total: number, label: string): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > total ||
    length > total - offset
  ) {
    throw zipError('invalid-zip', `${label} points outside the archive.`);
  }
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw zipError('zip64-too-large', `${label} exceeds the browser's safe integer range.`);
  }
  return Number(value);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? zipError('aborted', 'ZIP operation was aborted.');
}

async function yieldToBrowser(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

class Crc32 {
  #value = 0xffffffff;

  update(bytes: Uint8Array): void {
    let value = this.#value;
    for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
    this.#value = value;
  }

  digest(): number {
    return (this.#value ^ 0xffffffff) >>> 0;
  }
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export class StreamingZipError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StreamingZipError';
    this.code = code;
  }
}

function zipError(code: string, messageText: string): StreamingZipError {
  return new StreamingZipError(code, messageText);
}

function isStreamingZipError(error: unknown): error is StreamingZipError {
  return error instanceof StreamingZipError;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
