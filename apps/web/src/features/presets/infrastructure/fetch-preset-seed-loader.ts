import type { PresetDocument, PresetSeedManifest } from '../domain/preset';
import type { PresetSeedLoader } from '../ports/preset-seed-loader';
import { validateManifest } from '../application/preset-seed-service';

export const DEFAULT_PRESET_MANIFEST_URL = '/__pure_tavern/default-presets.json';

export class FetchPresetSeedLoader implements PresetSeedLoader {
  readonly #fetch: typeof window.fetch;
  readonly #url: string;

  constructor(fetchImplementation: typeof window.fetch, url = DEFAULT_PRESET_MANIFEST_URL) {
    this.#fetch = fetchImplementation;
    this.#url = url;
  }

  async load(): Promise<PresetSeedManifest<PresetDocument>> {
    const response = await this.#fetch(this.#url);
    if (!response.ok) {
      throw new Error(`Default presets failed to load: HTTP ${response.status}`);
    }
    return validateManifest(await response.json());
  }
}
