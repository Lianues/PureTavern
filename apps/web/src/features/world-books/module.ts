import type { FeatureModule } from '@/platform/features/feature-module';
import { worldNamesCapability } from '@/platform/features/standard-capabilities';

import { WorldBookService } from './application/world-book-service';
import { IndexedDbWorldBookRepository } from './infrastructure/indexeddb-world-book-repository';
import { ResilientWorldBookRepository } from './infrastructure/resilient-world-book-repository';
import { registerWorldBooksLegacyRoutes } from './legacy/register-routes';
import { LEGACY_WORLD_INFO_MATCHER } from './ports/world-info-matcher';

export const worldBooksFeature: FeatureModule = {
  id: 'world-books',
  install({ router, records, capabilities }) {
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
