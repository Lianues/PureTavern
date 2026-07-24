import type { BackupDescriptor } from '@pure-tavern/contracts';

import type { BackupRepository, SaveBackupInput } from '../ports/backup-repository';

export interface BackupStorageDiagnostics {
  status: 'ready' | 'degraded';
  backend: 'indexeddb' | 'memory';
  message: string | null;
  lastSavedAt: string | null;
}

export class MemoryBackupRepository implements BackupRepository {
  readonly #items = new Map<string, { descriptor: BackupDescriptor; archive: Blob }>();

  async list(): Promise<BackupDescriptor[]> {
    return [...this.#items.values()]
      .map((item) => structuredClone(item.descriptor))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt, 'en'));
  }

  async get(id: string): Promise<{ descriptor: BackupDescriptor; archive: Blob } | null> {
    const item = this.#items.get(id);
    return item ? { descriptor: structuredClone(item.descriptor), archive: item.archive } : null;
  }

  async save(input: SaveBackupInput): Promise<BackupDescriptor> {
    const descriptor: BackupDescriptor = {
      id: crypto.randomUUID(),
      label: input.label,
      createdAt: new Date().toISOString(),
      size: input.archive.size,
      archiveId: input.manifest.archiveId,
      moduleIds: input.manifest.modules.map((module) => module.moduleId),
      includeSecrets: input.manifest.includeSecrets,
      reason: input.reason,
    };
    this.#items.set(descriptor.id, { descriptor, archive: input.archive });
    return structuredClone(descriptor);
  }

  async delete(id: string): Promise<void> {
    this.#items.delete(id);
  }
}

export class ResilientBackupRepository implements BackupRepository {
  readonly diagnostics: BackupStorageDiagnostics = {
    status: 'ready',
    backend: 'indexeddb',
    message: null,
    lastSavedAt: null,
  };

  readonly #primary: BackupRepository;
  readonly #fallback: BackupRepository;
  #degraded = false;

  constructor(
    primary: BackupRepository,
    fallback: BackupRepository = new MemoryBackupRepository(),
  ) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async list(): Promise<BackupDescriptor[]> {
    if (this.#degraded) return this.#fallback.list();
    try {
      return await this.#primary.list();
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.list();
    }
  }

  async get(id: string): Promise<{ descriptor: BackupDescriptor; archive: Blob } | null> {
    if (this.#degraded) return this.#fallback.get(id);
    try {
      return await this.#primary.get(id);
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.get(id);
    }
  }

  async save(input: SaveBackupInput): Promise<BackupDescriptor> {
    if (this.#degraded) {
      const descriptor = await this.#fallback.save(input);
      this.diagnostics.lastSavedAt = descriptor.createdAt;
      return descriptor;
    }
    try {
      const descriptor = await this.#primary.save(input);
      this.diagnostics.lastSavedAt = descriptor.createdAt;
      return descriptor;
    } catch (error) {
      this.#degrade(error);
      const descriptor = await this.#fallback.save(input);
      this.diagnostics.lastSavedAt = descriptor.createdAt;
      return descriptor;
    }
  }

  async delete(id: string): Promise<void> {
    if (this.#degraded) {
      await this.#fallback.delete(id);
      return;
    }
    try {
      await this.#primary.delete(id);
    } catch (error) {
      this.#degrade(error);
      await this.#fallback.delete(id);
    }
  }

  #degrade(error: unknown): void {
    this.#degraded = true;
    this.diagnostics.status = 'degraded';
    this.diagnostics.backend = 'memory';
    this.diagnostics.message = error instanceof Error ? error.message : String(error);
  }
}
