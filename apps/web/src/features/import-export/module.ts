import { defineCapability } from '@/platform/features/capability-registry';
import type { FeatureInstallContext, FeatureModule } from '@/platform/features/feature-module';
import { archiveParticipantRegistryCapability } from '@/platform/features/standard-capabilities';

import { ArchiveParticipantRegistry } from './application/archive-participant-registry';
import { ArchiveService } from './application/archive-service';
import { IndexedDbBackupRepository } from './infrastructure/indexeddb-backup-repository';
import { LocalBackupTransport } from './infrastructure/local-backup-transport';
import { ResilientBackupRepository } from './infrastructure/resilient-backup-repository';
import { registerImportExportLegacyRoutes } from './legacy/register-routes';
import type { BackupRepository } from './ports/backup-repository';
import type { BackupTransport } from './ports/backup-transport';

export interface DataManagementRuntimeCapability {
  service: ArchiveService;
  participants: ArchiveParticipantRegistry;
  backupTransport: BackupTransport;
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
      context.capabilities.register(dataManagementRuntimeCapability, {
        service,
        participants,
        backupTransport,
      });
      registerImportExportLegacyRoutes(context.router, service);

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
