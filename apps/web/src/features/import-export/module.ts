import { defineCapability } from '@/platform/features/capability-registry';
import type { FeatureInstallContext, FeatureModule } from '@/platform/features/feature-module';
import {
  archiveParticipantRegistryCapability,
  characterCardMigrationCapability,
  extensionMigrationCapability,
} from '@/platform/features/standard-capabilities';

import { ArchiveParticipantRegistry } from './application/archive-participant-registry';
import { ArchiveService } from './application/archive-service';
import { IndexedDbBackupRepository } from './infrastructure/indexeddb-backup-repository';
import { LocalBackupTransport } from './infrastructure/local-backup-transport';
import { ResilientBackupRepository } from './infrastructure/resilient-backup-repository';
import { registerImportExportLegacyRoutes } from './legacy/register-routes';
import type { BackupRepository } from './ports/backup-repository';
import type { BackupTransport } from './ports/backup-transport';
import { TauriTavernMigrationService } from './tauri-tavern/application/tauri-tavern-service';

export interface DataManagementRuntimeCapability {
  service: ArchiveService;
  participants: ArchiveParticipantRegistry;
  backupTransport: BackupTransport;
  tauriTavern: TauriTavernMigrationService;
}

export const dataManagementRuntimeCapability = defineCapability<DataManagementRuntimeCapability>(
  'import-export.runtime.v1',
);

export interface ImportExportFeatureOptions {
  createBackupTransport?: (
    context: FeatureInstallContext,
    repository: BackupRepository,
  ) => BackupTransport;
}

export function createImportExportFeature(options: ImportExportFeatureOptions = {}): FeatureModule {
  return {
    id: 'import-export',
    install(context) {
      const participants = new ArchiveParticipantRegistry();
      context.capabilities.register(archiveParticipantRegistryCapability, participants);

      const repository = new ResilientBackupRepository(
        new IndexedDbBackupRepository(context.records, context.blobs),
      );
      const backupTransport =
        options.createBackupTransport?.(context, repository) ??
        new LocalBackupTransport(repository);
      const service = new ArchiveService(participants, backupTransport, context.records);
      // characters / extensions 特性可能在本模块之后安装，所以这些能力必须在请求时再取。
      const tauriTavern = new TauriTavernMigrationService(participants, service, {
        cardReader: () => context.capabilities.get(characterCardMigrationCapability) ?? null,
        extensionMigration: () => context.capabilities.get(extensionMigrationCapability) ?? null,
      });
      context.capabilities.register(dataManagementRuntimeCapability, {
        service,
        participants,
        backupTransport,
        tauriTavern,
      });
      registerImportExportLegacyRoutes(context.router, service, tauriTavern);

      const participantDiagnostics = {
        get count() {
          return participants.list().length;
        },
        get moduleIds() {
          return participants.list().map((participant) => participant.moduleId);
        },
      };
      return {
        diagnostics: {
          storage: repository.diagnostics,
          participants: participantDiagnostics,
          archive: {
            format: 'pure-tavern-archive',
            schemaVersion: 1,
            secretsDefault: 'excluded',
            recoveryPointBeforeImport: true,
          },
          interop: {
            format: 'tauri-tavern-data-directory',
            root: 'data/default-user',
            direction: 'import-and-export',
            sharedImportPipeline: true,
          },
          backupTransport: backupTransport.capabilities,
          optionalBackend: {
            implemented: false,
            contract: 'BackupTransport',
            archiveStorage: 'opaque-versioned-zip',
          },
        },
      };
    },
  };
}

export const importExportFeature = createImportExportFeature();
