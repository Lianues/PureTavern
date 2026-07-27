import type { ModuleRecordStore } from '@/platform/storage/app-storage';

import type { ExtensionService } from '../application/extension-service';
import { extractExtensionZip, sha256Hex } from '../application/package-validator';
import { ExtensionConflictError } from '../ports/extension-registry';

const MANIFEST_URL = '/__pure_tavern/bundled-extensions/manifest.json';
const ARCHIVE_BASE_URL = '/__pure_tavern/bundled-extensions/';
const SEED_COLLECTION = 'seed-state';
const SEED_ID = 'bundled-extensions-v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[a-f0-9]{40}$/u;
const SAFE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])$/u;
const SAFE_ARCHIVE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\.zip$/u;
const SAFE_FOLDER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,98}[a-zA-Z0-9])?$/u;

export interface BundledExtensionManifestEntry {
  id: string;
  repositoryUrl: string;
  releaseTag: string;
  revision: string;
  folderName: string;
  manifestVersion: string;
  archiveFile: string;
  archiveBytes: number;
  archiveSha256: string;
}

interface BundledExtensionManifest {
  version: 1;
  extensions: BundledExtensionManifestEntry[];
}

interface BundledExtensionSeedItemState {
  outcome: 'installed' | 'existing';
  archiveSha256: string;
  revision: string;
  processedAt: string;
}

interface BundledExtensionSeedState {
  version: 1;
  completed: boolean;
  items: Record<string, BundledExtensionSeedItemState>;
  completedAt: string | null;
}

export interface BundledExtensionSeedDiagnostics {
  status: 'pending' | 'ready' | 'error';
  installed: number;
  skipped: number;
  pending: number;
  completed: boolean;
  message: string | null;
}

export function createBundledExtensionSeedDiagnostics(): BundledExtensionSeedDiagnostics {
  return {
    status: 'pending',
    installed: 0,
    skipped: 0,
    pending: 0,
    completed: false,
    message: null,
  };
}

/**
 * Imports the shipped Release snapshots once per local profile. A completed state is checked before
 * the bundled manifest is fetched so later launches and app upgrades never reinstall a package the
 * user removed. Per-item state makes an interrupted first import resumable.
 */
export async function seedBundledExtensions(
  service: ExtensionService,
  records: ModuleRecordStore,
  nativeFetch: typeof window.fetch,
  diagnostics: BundledExtensionSeedDiagnostics,
  clock: () => Date = () => new Date(),
): Promise<void> {
  resetDiagnostics(diagnostics);
  try {
    const saved = await records.get<BundledExtensionSeedState>(SEED_COLLECTION, SEED_ID);
    const state = saved ? validateSeedState(saved.value) : createSeedState();
    if (state.completed) {
      diagnostics.status = 'ready';
      diagnostics.completed = true;
      return;
    }

    const manifest = await loadManifest(nativeFetch);
    diagnostics.pending = manifest.extensions.filter((entry) => !state.items[entry.id]).length;
    const errors: string[] = [];

    for (const entry of manifest.extensions) {
      if (state.items[entry.id]) continue;
      let outcome: BundledExtensionSeedItemState['outcome'];
      try {
        const archive = await loadArchive(entry, nativeFetch);
        const files = await extractExtensionZip(archive);
        await service.installSnapshot(
          {
            provider: 'github',
            repositoryUrl: entry.repositoryUrl,
            requestedRef: entry.releaseTag,
            resolvedRef: entry.releaseTag,
            revision: entry.revision,
            folderName: entry.folderName,
            files,
          },
          'local',
        );
        outcome = 'installed';
        diagnostics.installed += 1;
      } catch (error) {
        if (!(error instanceof ExtensionConflictError)) {
          errors.push(`${entry.id}: ${errorMessage(error)}`);
          continue;
        }
        outcome = 'existing';
        diagnostics.skipped += 1;
      }

      state.items[entry.id] = {
        outcome,
        archiveSha256: entry.archiveSha256,
        revision: entry.revision,
        processedAt: clock().toISOString(),
      };
      await saveSeedState(records, state);
      diagnostics.pending -= 1;
    }

    diagnostics.pending = manifest.extensions.filter((entry) => !state.items[entry.id]).length;
    if (diagnostics.pending === 0) {
      state.completed = true;
      state.completedAt = clock().toISOString();
      await saveSeedState(records, state);
      diagnostics.completed = true;
    }
    diagnostics.status = errors.length === 0 ? 'ready' : 'error';
    diagnostics.message = errors.length === 0 ? null : errors.join(' | ');
  } catch (error) {
    diagnostics.status = 'error';
    diagnostics.completed = false;
    diagnostics.message = errorMessage(error);
  }
}

async function loadManifest(nativeFetch: typeof window.fetch): Promise<BundledExtensionManifest> {
  const response = await nativeFetch(MANIFEST_URL, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Bundled extension manifest failed to load: HTTP ${response.status}`);
  }
  const value = (await response.json()) as unknown;
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.extensions)) {
    throw new TypeError('Bundled extension manifest must have version 1 and an extensions array.');
  }
  if (value.extensions.length === 0) {
    throw new TypeError('Bundled extension manifest must contain at least one extension.');
  }

  const ids = new Set<string>();
  const archives = new Set<string>();
  const repositories = new Set<string>();
  const folders = new Set<string>();
  const extensions = value.extensions.map((entry) => {
    const validated = validateManifestEntry(entry);
    assertUnique(ids, validated.id, 'id');
    assertUnique(archives, validated.archiveFile.toLocaleLowerCase('en-US'), 'archive file');
    assertUnique(
      repositories,
      validated.repositoryUrl.toLocaleLowerCase('en-US'),
      'repository URL',
    );
    assertUnique(folders, validated.folderName.toLocaleLowerCase('en-US'), 'folder name');
    return validated;
  });
  return { version: 1, extensions };
}

async function loadArchive(
  entry: BundledExtensionManifestEntry,
  nativeFetch: typeof window.fetch,
): Promise<Blob> {
  const response = await nativeFetch(
    `${ARCHIVE_BASE_URL}${encodeURIComponent(entry.archiveFile)}`,
    {
      cache: 'force-cache',
    },
  );
  if (!response.ok) {
    throw new Error(
      `Bundled extension archive ${entry.archiveFile} failed to load: HTTP ${response.status}`,
    );
  }
  const archive = await response.blob();
  if (archive.size !== entry.archiveBytes) {
    throw new Error(
      `Bundled extension archive size mismatch for ${entry.id}: expected ${entry.archiveBytes}, received ${archive.size}.`,
    );
  }
  const hash = await sha256Hex(archive);
  if (hash !== entry.archiveSha256) {
    throw new Error(
      `Bundled extension archive SHA-256 mismatch for ${entry.id}: expected ${entry.archiveSha256}, received ${hash}.`,
    );
  }
  return archive;
}

function validateManifestEntry(value: unknown): BundledExtensionManifestEntry {
  if (!isRecord(value)) throw new TypeError('Bundled extension entries must be objects.');
  const entry: BundledExtensionManifestEntry = {
    id: requiredString(value.id, 'id'),
    repositoryUrl: requiredString(value.repositoryUrl, 'repositoryUrl'),
    releaseTag: requiredString(value.releaseTag, 'releaseTag'),
    revision: requiredString(value.revision, 'revision'),
    folderName: requiredString(value.folderName, 'folderName'),
    manifestVersion: requiredString(value.manifestVersion, 'manifestVersion'),
    archiveFile: requiredString(value.archiveFile, 'archiveFile'),
    archiveBytes: value.archiveBytes as number,
    archiveSha256: requiredString(value.archiveSha256, 'archiveSha256'),
  };
  if (!SAFE_ID_PATTERN.test(entry.id))
    throw new TypeError(`Invalid bundled extension id: ${entry.id}`);
  let repository: URL;
  try {
    repository = new URL(entry.repositoryUrl);
  } catch {
    throw new TypeError(`Invalid bundled extension repository URL: ${entry.repositoryUrl}`);
  }
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

function validateSeedState(value: unknown): BundledExtensionSeedState {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.completed !== 'boolean' ||
    !isRecord(value.items) ||
    !(value.completedAt === null || typeof value.completedAt === 'string')
  ) {
    throw new TypeError('Bundled extension seed state is invalid; automatic import was stopped.');
  }
  const items: Record<string, BundledExtensionSeedItemState> = {};
  for (const [id, item] of Object.entries(value.items)) {
    if (
      !SAFE_ID_PATTERN.test(id) ||
      !isRecord(item) ||
      (item.outcome !== 'installed' && item.outcome !== 'existing') ||
      typeof item.archiveSha256 !== 'string' ||
      !SHA256_PATTERN.test(item.archiveSha256) ||
      typeof item.revision !== 'string' ||
      !REVISION_PATTERN.test(item.revision) ||
      typeof item.processedAt !== 'string'
    ) {
      throw new TypeError('Bundled extension seed state is invalid; automatic import was stopped.');
    }
    items[id] = {
      outcome: item.outcome,
      archiveSha256: item.archiveSha256,
      revision: item.revision,
      processedAt: item.processedAt,
    };
  }
  return {
    version: 1,
    completed: value.completed,
    items,
    completedAt: value.completedAt,
  };
}

function createSeedState(): BundledExtensionSeedState {
  return { version: 1, completed: false, items: {}, completedAt: null };
}

async function saveSeedState(
  records: ModuleRecordStore,
  state: BundledExtensionSeedState,
): Promise<void> {
  await records.put<BundledExtensionSeedState>(SEED_COLLECTION, SEED_ID, state);
}

function resetDiagnostics(diagnostics: BundledExtensionSeedDiagnostics): void {
  diagnostics.status = 'pending';
  diagnostics.installed = 0;
  diagnostics.skipped = 0;
  diagnostics.pending = 0;
  diagnostics.completed = false;
  diagnostics.message = null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new TypeError(`Bundled extension ${field} must be a non-empty trimmed string.`);
  }
  return value;
}

function assertUnique(values: Set<string>, value: string, label: string): void {
  if (values.has(value)) throw new TypeError(`Duplicate bundled extension ${label}: ${value}`);
  values.add(value);
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
