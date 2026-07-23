import { SettingsSnapshotService } from '../features/settings/application/settings-snapshot-service';
import { SettingsService } from '../features/settings/application/settings-service';
import { IndexedDbSettingsRepository } from '../features/settings/adapters/indexeddb-settings-repository';
import { IndexedDbSettingsSnapshotRepository } from '../features/settings/adapters/indexeddb-settings-snapshot-repository';
import { ResilientSettingsSnapshotRepository } from '../features/settings/adapters/resilient-settings-snapshot-repository';
import { ResilientSettingsRepository } from '../features/settings/adapters/resilient-settings-repository';
import { cloneSettingsDocument } from '../features/settings/domain/settings-document';
import { appDatabase } from '../infrastructure/database/app-database';

export function createLegacySettingsRuntime(nativeFetch: typeof window.fetch) {
  const repository = new ResilientSettingsRepository(new IndexedDbSettingsRepository(appDatabase));
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
    new IndexedDbSettingsSnapshotRepository(appDatabase),
  );
  const snapshots = new SettingsSnapshotService(service, snapshotRepository);

  return {
    service,
    diagnostics: repository.diagnostics,
    snapshots,
    snapshotDiagnostics: snapshotRepository.diagnostics,
  };
}
