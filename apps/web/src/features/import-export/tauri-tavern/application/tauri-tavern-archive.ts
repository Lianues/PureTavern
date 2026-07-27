import { unzipSync, zipSync } from 'fflate';

import {
  TAURI_TAVERN_DATA_ROOT,
  TAURI_TAVERN_DIRECTORIES,
  TAURI_TAVERN_USER_HANDLE,
  TAURI_TAVERN_USER_ROOT,
  assertSafeMigrationPath,
  failTauriTavern,
} from '../domain/data-tree';
import {
  readStreamingZipDirectory,
  readZipEntryBytes,
  StreamingZipError,
  type StreamingZipDirectory,
  type StreamingZipEntry,
  type StreamingZipOptions,
} from '../../application/streaming-zip';
import type { TauriTavernFile } from './tauri-tavern-format';

const DATA_USER_PREFIX = `${TAURI_TAVERN_DATA_ROOT}/${TAURI_TAVERN_USER_HANDLE}/`;
const USER_HANDLE_PREFIX = `${TAURI_TAVERN_USER_HANDLE}/`;

/** 直接出现在用户目录根部的条目，用来识别「只打包了 default-user 内容」的 zip。 */
const USER_ROOT_ENTRIES: ReadonlySet<string> = new Set([
  ...Object.values(TAURI_TAVERN_DIRECTORIES),
  'settings.json',
  'secrets.json',
  'stats.json',
]);

export function packTauriTavernArchive(files: readonly TauriTavernFile[]): Blob {
  // 路径直接当对象 key 用，原型为空才不会有某个文件名意外命中 Object.prototype 上的成员。
  const zipped = Object.create(null) as Record<string, Uint8Array>;
  for (const file of files) {
    assertSafeMigrationPath(file.path);
    zipped[file.path] = file.data;
  }
  const bytes = zipSync(zipped, { level: 6 });
  const copy = bytes.slice();
  return new Blob([copy.buffer], { type: 'application/zip' });
}

export interface IndexedTauriTavernFile {
  path: string;
  entry: StreamingZipEntry;
}

export interface IndexedTauriTavernArchive {
  archive: Blob;
  files: IndexedTauriTavernFile[];
  sourceFileCount: number;
}

export async function indexTauriTavernArchive(
  archive: Blob,
  options: StreamingZipOptions = {},
): Promise<IndexedTauriTavernArchive> {
  if (archive.size <= 0) failTauriTavern('archive-size', 'Package must not be empty.');
  let directory: StreamingZipDirectory;
  try {
    directory = await readStreamingZipDirectory(archive, options);
  } catch (error) {
    if (error instanceof StreamingZipError) failTauriTavern(error.code, error.message);
    throw error;
  }
  const entries = directory.entries.filter((entry) => !entry.directory);
  if (entries.length === 0) failTauriTavern('empty-package', 'Package does not contain any files.');

  const paths = entries.map((entry) => normalizeSeparators(entry.path));
  const rebase = createRebaser(paths);
  const files: IndexedTauriTavernFile[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const rebased = rebase(normalizeSeparators(entry.path));
    if (!rebased) continue;
    assertSafeMigrationPath(rebased);
    const key = rebased.normalize('NFKC').toLowerCase();
    if (seen.has(key)) {
      failTauriTavern('duplicate-path', `Package contains the same path twice: ${rebased}`);
    }
    seen.add(key);
    files.push({ path: rebased, entry });
  }
  if (files.length === 0) {
    failTauriTavern(
      'not-a-migration-package',
      'This ZIP does not look like a TauriTavern data package. Expected a data/default-user/ folder.',
    );
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return { archive, files, sourceFileCount: entries.length };
}

export async function readIndexedTauriTavernFile(
  index: IndexedTauriTavernArchive,
  file: IndexedTauriTavernFile,
  options: StreamingZipOptions = {},
): Promise<TauriTavernFile> {
  try {
    return { path: file.path, data: await readZipEntryBytes(index.archive, file.entry, options) };
  } catch (error) {
    if (error instanceof StreamingZipError) failTauriTavern(error.code, error.message);
    throw error;
  }
}

export async function unpackTauriTavernArchive(archive: Blob): Promise<TauriTavernFile[]> {
  if (archive.size <= 0) failTauriTavern('archive-size', 'Package must not be empty.');
  const buffer = new Uint8Array(await archive.arrayBuffer());

  let output: Record<string, Uint8Array>;
  try {
    output = unzipSync(buffer, {
      filter(info) {
        if (info.name.endsWith('/')) return false;
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TauriTavernFormatError') throw error;
    failTauriTavern(
      'invalid-zip',
      `Package is not a supported ZIP: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const paths = Object.keys(output);
  if (paths.length === 0) failTauriTavern('empty-package', 'Package does not contain any files.');

  const rebase = createRebaser(paths);
  const files: TauriTavernFile[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const rebased = rebase(normalizeSeparators(path));
    if (!rebased) continue;
    assertSafeMigrationPath(rebased);
    const key = rebased.normalize('NFKC').toLowerCase();
    if (seen.has(key)) {
      failTauriTavern('duplicate-path', `Package contains the same path twice: ${rebased}`);
    }
    seen.add(key);
    files.push({ path: rebased, data: output[path] as Uint8Array });
  }

  if (files.length === 0) {
    failTauriTavern(
      'not-a-migration-package',
      'This ZIP does not look like a TauriTavern data package. Expected a data/default-user/ folder.',
    );
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

/**
 * 迁移包在到达这里之前会被各种方式重新打包：外面套一层日期目录、只压了 `default-user`、
 * 甚至只压了用户目录里的内容。与其让用户回去重压一次，不如在这里统一还原成 `data/default-user/`。
 */
function createRebaser(paths: readonly string[]): (path: string) => string | null {
  const normalized = paths.map(normalizeSeparators);
  const wrapper = findWrapperPrefix(normalized);
  if (wrapper !== null) {
    return (path) => {
      if (!path.startsWith(wrapper)) return null;
      const remainder = path.slice(wrapper.length);
      return remainder.startsWith(`${TAURI_TAVERN_DATA_ROOT}/`) ? remainder : null;
    };
  }

  const userWrapper = findPrefixOf(normalized, USER_HANDLE_PREFIX);
  if (userWrapper !== null) {
    return (path) => {
      if (!path.startsWith(`${userWrapper}${USER_HANDLE_PREFIX}`)) return null;
      return `${TAURI_TAVERN_USER_ROOT}/${path.slice(userWrapper.length + USER_HANDLE_PREFIX.length)}`;
    };
  }

  if (normalized.some((path) => USER_ROOT_ENTRIES.has(path.split('/')[0] ?? ''))) {
    return (path) =>
      USER_ROOT_ENTRIES.has(path.split('/')[0] ?? '') ? `${TAURI_TAVERN_USER_ROOT}/${path}` : null;
  }
  return () => null;
}

/** 找出 `data/default-user/` 之前的那层包装目录（通常是空字符串）。 */
function findWrapperPrefix(paths: readonly string[]): string | null {
  return findPrefixOf(paths, DATA_USER_PREFIX);
}

function findPrefixOf(paths: readonly string[], marker: string): string | null {
  let shortest: string | null = null;
  for (const path of paths) {
    const index = path.indexOf(marker);
    if (index < 0) continue;
    if (index > 0 && path[index - 1] !== '/') continue;
    const prefix = path.slice(0, index);
    if (shortest === null || prefix.length < shortest.length) shortest = prefix;
  }
  return shortest;
}

function normalizeSeparators(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^\.\//u, '');
}
