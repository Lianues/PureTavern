import type { FeatureModule } from '@/platform/features/feature-module';
import { registerArchiveModule } from '@/platform/features/register-archive-module';
import { legacyPresetBootstrapCapability } from '@/platform/features/standard-capabilities';

import { PresetSeedService } from './application/preset-seed-service';
import { PresetService } from './application/preset-service';
import { FetchPresetSeedLoader } from './infrastructure/fetch-preset-seed-loader';
import { IndexedDbPresetRepository } from './infrastructure/indexeddb-preset-repository';
import { ResilientPresetRepository } from './infrastructure/resilient-preset-repository';
import { PresetLegacyBootstrapProvider } from './legacy/bootstrap-data';
import { registerPresetsLegacyRoutes } from './legacy/register-routes';

export const presetsFeature: FeatureModule = {
  id: 'presets',
  install(context) {
    const { router, records, nativeFetch, capabilities } = context;
    registerArchiveModule(context, { moduleId: 'presets', displayName: 'Presets & Themes' });
    const repository = new ResilientPresetRepository(new IndexedDbPresetRepository(records));
    const seedLoader = new FetchPresetSeedLoader(nativeFetch);
    const seeds = new PresetSeedService(repository, seedLoader);
    const service = new PresetService(repository, seeds);
    const legacyBootstrap = new PresetLegacyBootstrapProvider(service);

    capabilities.register(legacyPresetBootstrapCapability, legacyBootstrap);
    registerPresetsLegacyRoutes(router, service);

    return {
      diagnostics: {
        storage: repository.diagnostics,
      },
    };
  },
};
