import type { FeatureModule } from '@/platform/features/feature-module';
import { registerArchiveModule } from '@/platform/features/register-archive-module';
import { worldNamesCapability } from '@/platform/features/standard-capabilities';

import { WorldBookService } from './application/world-book-service';
import { IndexedDbWorldBookRepository } from './infrastructure/indexeddb-world-book-repository';
import { ResilientWorldBookRepository } from './infrastructure/resilient-world-book-repository';
import { registerWorldBooksLegacyRoutes } from './legacy/register-routes';
import { LEGACY_WORLD_INFO_MATCHER } from './ports/world-info-matcher';

export const worldBooksFeature: FeatureModule = {
  id: 'world-books',
  install(context) {
    const { router, records, capabilities } = context;
    registerArchiveModule(context, { moduleId: 'world-books', displayName: 'World Books' });
    const repository = new ResilientWorldBookRepository(new IndexedDbWorldBookRepository(records));
    const service = new WorldBookService(repository);
    capabilities.register(worldNamesCapability, {
      listWorldNames: () => service.listWorldNames(),
    });
    registerWorldBooksLegacyRoutes(router, service);

    return {
      diagnostics: {
        storage: repository.diagnostics,
        matcher: LEGACY_WORLD_INFO_MATCHER,
      },
    };
  },
};
