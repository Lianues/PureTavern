import type { ModuleRecordStore } from '@/platform/storage/app-storage';

import type { AssetService } from '../application/asset-service';

const MANIFEST_URL = '/__pure_tavern/default-assets.json';
const SEED_COLLECTION = 'seed-state';
const SEED_ID = 'backgrounds';

interface DefaultAssetManifest {
  version: 1;
  backgrounds: { name: string; sourceHash: string }[];
}

interface BackgroundSeedState {
  sourceHashes: Record<string, string>;
  synchronizedAt: string;
}

export interface DefaultBackgroundSeedDiagnostics {
  status: 'pending' | 'ready' | 'error';
  seeded: number;
  message: string | null;
}

export async function seedDefaultBackgrounds(
  assets: AssetService,
  records: ModuleRecordStore,
  nativeFetch: typeof window.fetch,
  diagnostics: DefaultBackgroundSeedDiagnostics,
): Promise<void> {
  try {
    const manifest = await loadManifest(nativeFetch);
    const savedState = await records.get<BackgroundSeedState>(SEED_COLLECTION, SEED_ID);
    const sourceHashes = { ...(savedState?.value.sourceHashes ?? {}) };
    const existing = new Set(
      (await assets.listBackgrounds()).images.map((image) => image.filename),
    );

    for (const background of manifest.backgrounds) {
      validateEntry(background);
      if (sourceHashes[background.name]) continue;
      if (!existing.has(background.name)) {
        const response = await nativeFetch(
          `/backgrounds/${background.name.split('/').map(encodeURIComponent).join('/')}`,
        );
        if (!response.ok) {
          throw new Error(
            `Default background ${background.name} failed to load: HTTP ${response.status}`,
          );
        }
        await assets.uploadBackground(await response.blob(), background.name);
        existing.add(background.name);
        diagnostics.seeded += 1;
      }
      sourceHashes[background.name] = background.sourceHash;
      await records.put<BackgroundSeedState>(SEED_COLLECTION, SEED_ID, {
        sourceHashes,
        synchronizedAt: new Date().toISOString(),
      });
    }

    diagnostics.status = 'ready';
    diagnostics.message = null;
  } catch (error) {
    diagnostics.status = 'error';
    diagnostics.message = error instanceof Error ? error.message : String(error);
  }
}

async function loadManifest(nativeFetch: typeof window.fetch): Promise<DefaultAssetManifest> {
  const response = await nativeFetch(MANIFEST_URL);
  if (!response.ok)
    throw new Error(`Default Assets manifest failed to load: HTTP ${response.status}`);
  const value = (await response.json()) as Partial<DefaultAssetManifest>;
  if (value.version !== 1 || !Array.isArray(value.backgrounds)) {
    throw new TypeError('Default Assets manifest must have version 1 and a backgrounds array.');
  }
  return value as DefaultAssetManifest;
}

function validateEntry(entry: { name: string; sourceHash: string }): void {
  if (
    typeof entry.name !== 'string' ||
    !entry.name ||
    entry.name.includes('/') ||
    entry.name.includes('\\') ||
    entry.name.includes('..')
  ) {
    throw new TypeError('Default background manifest contains an unsafe name.');
  }
  if (typeof entry.sourceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sourceHash)) {
    throw new TypeError(`Default background ${entry.name} has an invalid source hash.`);
  }
}
