import type { PresetDocument, PresetSeedManifest } from '../domain/preset';

export interface PresetSeedLoader {
  load(): Promise<PresetSeedManifest<PresetDocument>>;
}
