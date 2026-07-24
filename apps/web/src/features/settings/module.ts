import type { FeatureModule } from '@/platform/features/feature-module';

import { SettingsSnapshotService } from './application/settings-snapshot-service';
import { SettingsService } from './application/settings-service';
import { cloneSettingsDocument } from './domain/settings-document';
import { IndexedDbSettingsRepository } from './infrastructure/indexeddb-settings-repository';
import { IndexedDbSettingsSnapshotRepository } from './infrastructure/indexeddb-settings-snapshot-repository';
import { ResilientSettingsRepository } from './infrastructure/resilient-settings-repository';
import { ResilientSettingsSnapshotRepository } from './infrastructure/resilient-settings-snapshot-repository';
import { registerSettingsLegacyRoutes } from './legacy/register-routes';

export const settingsFeature: FeatureModule = {
  id: 'settings',
  install({ router, nativeFetch, records, capabilities }) {
    const repository = new ResilientSettingsRepository(new IndexedDbSettingsRepository(records));
    const service = new SettingsService(repository, async () => {
      const response = await nativeFetch('/__pure_tavern/default-settings.json');
      if (!response.ok) {
        throw new Error(`Default settings failed to load: HTTP ${response.status}`);
      }

      const defaults = cloneSettingsDocument(await response.json());
      return {
        ...defaults,
        firstRun: false,
        active_character: null,
        active_group: null,
        accountStorage:
          defaults.accountStorage && typeof defaults.accountStorage === 'object'
            ? defaults.accountStorage
            : {},
      };
    });

    const snapshotRepository = new ResilientSettingsSnapshotRepository(
      new IndexedDbSettingsSnapshotRepository(records),
    );
    const snapshots = new SettingsSnapshotService(service, snapshotRepository);

    registerSettingsLegacyRoutes(router, service, snapshots, capabilities);

    return {
      diagnostics: {
        storage: repository.diagnostics,
        snapshots: snapshotRepository.diagnostics,
      },
    };
  },
};
