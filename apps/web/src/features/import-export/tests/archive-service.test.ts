import { afterEach, describe, expect, it } from 'vitest';

import { AppDatabase } from '@/platform/storage/app-database';
import { AppStorage } from '@/platform/storage/app-storage';
import { initializeStorage } from '@/platform/storage/initialize-storage';

import { decodeArchive } from '../application/archive-codec';
import { ArchiveParticipantRegistry } from '../application/archive-participant-registry';
import { ArchiveService } from '../application/archive-service';
import { LocalBackupTransport } from '../infrastructure/local-backup-transport';
import { MemoryBackupRepository } from '../infrastructure/resilient-backup-repository';

const databases: AppDatabase[] = [];

async function createHarness() {
  const database = new AppDatabase(`pure-tavern-archive-service-${crypto.randomUUID()}`);
  databases.push(database);
  const storage = new AppStorage(database);
  await initializeStorage(storage);
  const participants = new ArchiveParticipantRegistry();
  participants.registerModule({
    moduleId: 'settings',
    displayName: 'Settings',
    dataVersion: 1,
    sensitive: false,
    defaultSelected: true,
    records: storage.records.forModule('settings'),
    blobs: storage.blobs.forModule('settings'),
  });
  participants.registerModule({
    moduleId: 'characters',
    displayName: 'Characters',
    dataVersion: 1,
    sensitive: false,
    defaultSelected: true,
    records: storage.records.forModule('characters'),
    blobs: storage.blobs.forModule('characters'),
  });
  participants.registerModule({
    moduleId: 'secrets',
    displayName: 'Secrets',
    dataVersion: 1,
    sensitive: true,
    defaultSelected: false,
    records: storage.records.forModule('secrets'),
    blobs: storage.blobs.forModule('secrets'),
  });
  let counter = 0;
  const transport = new LocalBackupTransport(new MemoryBackupRepository());
  const service = new ArchiveService(
    participants,
    transport,
    storage.records.forModule('import-export'),
    {
      clock: () => new Date(`2026-07-24T00:00:0${counter++}.000Z`),
      createId: () => `archive-${counter}`,
      backupRetention: 5,
    },
  );
  return { storage, service, transport };
}

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('ArchiveService', () => {
  it('exports all registered data, excludes secrets by default and restores with conflict preview', async () => {
    const { storage, service } = await createHarness();
    await storage.records.forModule('settings').put('documents', 'current', { theme: 'dark' });
    await storage.records
      .forModule('characters')
      .put('documents', 'alice', { name: 'Alice', avatar: 'Alice.png' });
    await storage.records.forModule('secrets').put('store', 'current', { value: 'plaintext-key' });

    const exported = await service.exportArchive();
    const decoded = await decodeArchive(exported.blob);
    expect(decoded.manifest.modules.map((module) => module.moduleId)).toEqual([
      'characters',
      'settings',
    ]);
    expect(JSON.stringify(decoded.manifest)).not.toContain('plaintext-key');

    await storage.records.forModule('settings').put('documents', 'current', { theme: 'changed' });
    const preview = await service.previewArchive(exported.blob);
    expect(preview.modules.find((module) => module.moduleId === 'settings')).toMatchObject({
      conflicts: 1,
      selected: true,
    });
    const report = await service.importArchive(exported.blob, {
      strategy: 'replace-module',
      createRecoveryPoint: false,
    });
    expect(report.modules.every((module) => module.errors.length === 0)).toBe(true);
    await expect(
      storage.records.forModule('settings').get('documents', 'current'),
    ).resolves.toMatchObject({
      value: { theme: 'dark' },
    });

    const withSecrets = await service.exportArchive({ includeSecrets: true });
    expect(withSecrets.manifest.includeSecrets).toBe(true);
    expect(withSecrets.manifest.modules.map((module) => module.moduleId)).toContain('secrets');
  });

  it('creates, downloads, restores, rotates and deletes local opaque backups through BackupTransport', async () => {
    const { storage, service, transport } = await createHarness();
    const settings = storage.records.forModule('settings');
    await settings.put('documents', 'current', { marker: 'before' });

    const backup = await service.createBackup('Browser recovery', { moduleIds: ['settings'] });
    expect(transport.capabilities).toMatchObject({
      kind: 'browser-local',
      opaqueArchiveStorage: true,
    });
    expect(await service.downloadBackup(backup.id)).toBeInstanceOf(Blob);

    await settings.put('documents', 'current', { marker: 'after' });
    const report = await service.restoreBackup(backup.id, {
      strategy: 'replace-module',
      createRecoveryPoint: false,
    });
    expect(report.archiveId).toBe(backup.archiveId);
    await expect(settings.get('documents', 'current')).resolves.toMatchObject({
      value: { marker: 'before' },
    });

    expect(await service.listBackups()).toHaveLength(1);
    await service.deleteBackup(backup.id);
    expect(await service.listBackups()).toEqual([]);
  });

  it('creates a pre-import recovery point and persists an import journal', async () => {
    const { storage, service } = await createHarness();
    const settings = storage.records.forModule('settings');
    await settings.put('documents', 'current', { marker: 'archive' });
    const archive = await service.exportArchive({ moduleIds: ['settings'] });
    await settings.put('documents', 'current', { marker: 'current' });

    const report = await service.importArchive(archive.blob, { strategy: 'merge' });
    expect(report.recoveryBackupId).toEqual(expect.any(String));
    expect(await service.listBackups()).toHaveLength(1);
    await expect(
      storage.records.forModule('import-export').get('import-journal', 'current'),
    ).resolves.toMatchObject({
      value: { stage: 'completed', archiveId: archive.manifest.archiveId },
    });
  });
});
