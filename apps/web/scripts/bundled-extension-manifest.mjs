import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { unzipSync } from 'fflate';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[a-f0-9]{40}$/u;
const SAFE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])$/u;
const SAFE_ARCHIVE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\.zip$/u;
const SAFE_FOLDER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,98}[a-zA-Z0-9])?$/u;

export async function validateBundledExtensionManifest(root) {
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!isRecord(manifest) || manifest.version !== 1 || !Array.isArray(manifest.extensions)) {
    throw new TypeError('Bundled extension manifest must have version 1 and an extensions array.');
  }
  if (manifest.extensions.length === 0) {
    throw new TypeError('Bundled extension manifest must contain at least one extension.');
  }

  const ids = new Set();
  const archives = new Set();
  const repositories = new Set();
  const folders = new Set();
  for (const value of manifest.extensions) {
    const entry = validateEntry(value);
    assertUnique(ids, entry.id, 'id');
    assertUnique(archives, entry.archiveFile.toLocaleLowerCase('en-US'), 'archive file');
    assertUnique(repositories, entry.repositoryUrl.toLocaleLowerCase('en-US'), 'repository URL');
    assertUnique(folders, entry.folderName.toLocaleLowerCase('en-US'), 'folder name');

    const archive = await readFile(path.join(root, entry.archiveFile));
    if (archive.byteLength !== entry.archiveBytes) {
      throw new Error(
        `Bundled extension archive size mismatch for ${entry.id}: expected ${entry.archiveBytes}, received ${archive.byteLength}.`,
      );
    }
    const hash = createHash('sha256').update(archive).digest('hex');
    if (hash !== entry.archiveSha256) {
      throw new Error(
        `Bundled extension archive SHA-256 mismatch for ${entry.id}: expected ${entry.archiveSha256}, received ${hash}.`,
      );
    }

    const extensionManifest = readRootExtensionManifest(entry.id, archive);
    if (extensionManifest.version !== entry.manifestVersion) {
      throw new Error(
        `Bundled extension manifest version mismatch for ${entry.id}: expected ${entry.manifestVersion}, received ${String(extensionManifest.version)}.`,
      );
    }
    if (
      typeof extensionManifest.display_name !== 'string' ||
      !extensionManifest.display_name.trim()
    ) {
      throw new TypeError(`Bundled extension ${entry.id} has no display_name.`);
    }
    if (typeof extensionManifest.js !== 'string' && typeof extensionManifest.css !== 'string') {
      throw new TypeError(`Bundled extension ${entry.id} has no JS or CSS entry point.`);
    }
  }

  return manifest;
}

function validateEntry(value) {
  if (!isRecord(value)) throw new TypeError('Bundled extension entries must be objects.');
  const entry = {
    id: requiredString(value.id, 'id'),
    repositoryUrl: requiredString(value.repositoryUrl, 'repositoryUrl'),
    releaseTag: requiredString(value.releaseTag, 'releaseTag'),
    revision: requiredString(value.revision, 'revision'),
    folderName: requiredString(value.folderName, 'folderName'),
    manifestVersion: requiredString(value.manifestVersion, 'manifestVersion'),
    archiveFile: requiredString(value.archiveFile, 'archiveFile'),
    archiveBytes: value.archiveBytes,
    archiveSha256: requiredString(value.archiveSha256, 'archiveSha256'),
  };
  if (!SAFE_ID_PATTERN.test(entry.id))
    throw new TypeError(`Invalid bundled extension id: ${entry.id}`);
  const repository = new URL(entry.repositoryUrl);
  if (
    repository.protocol !== 'https:' ||
    repository.hostname !== 'github.com' ||
    repository.username ||
    repository.password ||
    repository.search ||
    repository.hash ||
    repository.pathname.split('/').filter(Boolean).length !== 2 ||
    repository.pathname.endsWith('/')
  ) {
    throw new TypeError(`Invalid bundled extension repository URL: ${entry.repositoryUrl}`);
  }
  if (
    entry.releaseTag.length > 200 ||
    entry.releaseTag.startsWith('-') ||
    hasControlCharacters(entry.releaseTag)
  ) {
    throw new TypeError(`Invalid bundled extension release tag: ${entry.releaseTag}`);
  }
  if (!REVISION_PATTERN.test(entry.revision)) {
    throw new TypeError(`Invalid bundled extension revision: ${entry.revision}`);
  }
  if (!SAFE_FOLDER_PATTERN.test(entry.folderName)) {
    throw new TypeError(`Invalid bundled extension folder name: ${entry.folderName}`);
  }
  if (!SAFE_ARCHIVE_PATTERN.test(entry.archiveFile)) {
    throw new TypeError(`Invalid bundled extension archive file: ${entry.archiveFile}`);
  }
  if (!Number.isSafeInteger(entry.archiveBytes) || entry.archiveBytes <= 0) {
    throw new TypeError(`Invalid bundled extension archive size for ${entry.id}.`);
  }
  if (!SHA256_PATTERN.test(entry.archiveSha256)) {
    throw new TypeError(`Invalid bundled extension archive SHA-256 for ${entry.id}.`);
  }
  return entry;
}

function readRootExtensionManifest(id, archive) {
  let output;
  try {
    output = unzipSync(new Uint8Array(archive));
  } catch (error) {
    throw new Error(
      `Bundled extension ${id} is not a supported ZIP: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const files = Object.keys(output).filter((name) => name && !name.endsWith('/'));
  const direct = files.includes('manifest.json') ? ['manifest.json'] : [];
  const nested = files.filter(
    (name) => name.endsWith('/manifest.json') && name.split('/').length === 2,
  );
  const candidates = [...direct, ...nested];
  if (candidates.length !== 1) {
    throw new Error(`Bundled extension ${id} must contain exactly one root manifest.json.`);
  }
  const manifestPath = candidates[0];
  const root = manifestPath.slice(0, -'manifest.json'.length);
  if (root && files.some((name) => !name.startsWith(root))) {
    throw new Error(`Bundled extension ${id} contains files outside its archive root.`);
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(output[manifestPath]));
    if (!isRecord(parsed)) throw new TypeError('manifest.json must contain an object.');
    return parsed;
  } catch (error) {
    throw new Error(
      `Bundled extension ${id} has an invalid manifest.json: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new TypeError(`Bundled extension ${field} must be a non-empty trimmed string.`);
  }
  return value;
}

function assertUnique(values, value, label) {
  if (values.has(value)) throw new TypeError(`Duplicate bundled extension ${label}: ${value}`);
  values.add(value);
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
