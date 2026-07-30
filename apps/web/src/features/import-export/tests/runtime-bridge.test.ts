import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ArchiveService } from '../application/archive-service';
import { installDataManagementRuntimeBridge } from '../runtime-bridge';
import type { TauriTavernMigrationService } from '../tauri-tavern/application/tauri-tavern-service';

afterEach(() => {
  globalThis.__PURE_TAVERN_DATA_STREAMING__ = undefined;
});

describe('data management runtime bridge', () => {
  it('dispatches fast and slow operations to the eager and streaming services', async () => {
    const archiveMethods = {
      previewArchive: vi.fn(async () => ({})),
      previewArchiveStreaming: vi.fn(async () => ({})),
      importArchive: vi.fn(async () => ({})),
      importArchiveStreaming: vi.fn(async () => ({})),
      inspectArchiveStreaming: vi.fn(async () => ({})),
    };
    const tauriTavernMethods = {
      previewPackage: vi.fn(async () => ({})),
      previewPackageStreaming: vi.fn(async () => ({})),
      importPackage: vi.fn(async () => ({})),
      importPackageStreaming: vi.fn(async () => ({})),
      inspectPackageStreaming: vi.fn(async () => ({})),
    };
    const bridge = installDataManagementRuntimeBridge(
      archiveMethods as unknown as ArchiveService,
      tauriTavernMethods as unknown as TauriTavernMigrationService,
    );
    const file = new Blob(['zip']);

    await bridge.previewArchive(file, {}, { method: 'fast' });
    await bridge.previewArchive(file, {}, { method: 'slow' });
    await bridge.importArchive(file, {}, { method: 'fast' });
    await bridge.importArchive(file, {}, { method: 'slow' });
    await bridge.previewTauriTavern(file, {}, { method: 'fast' });
    await bridge.previewTauriTavern(file, {}, { method: 'slow' });
    await bridge.importTauriTavern(file, {}, { method: 'fast' });
    await bridge.importTauriTavern(file, {}, { method: 'slow' });

    expect(archiveMethods.previewArchive).toHaveBeenCalledTimes(1);
    expect(archiveMethods.previewArchiveStreaming).toHaveBeenCalledTimes(1);
    expect(archiveMethods.importArchive).toHaveBeenCalledTimes(1);
    expect(archiveMethods.importArchiveStreaming).toHaveBeenCalledTimes(1);
    expect(tauriTavernMethods.previewPackage).toHaveBeenCalledTimes(1);
    expect(tauriTavernMethods.previewPackageStreaming).toHaveBeenCalledTimes(1);
    expect(tauriTavernMethods.importPackage).toHaveBeenCalledTimes(1);
    expect(tauriTavernMethods.importPackageStreaming).toHaveBeenCalledTimes(1);
  });
});
