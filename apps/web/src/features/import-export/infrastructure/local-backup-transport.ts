import type { BackupTransportCapabilities } from '@pure-tavern/contracts';

import type { BackupRepository } from '../ports/backup-repository';
import type { BackupTransport } from '../ports/backup-transport';

export class LocalBackupTransport implements BackupTransport {
  readonly capabilities: BackupTransportCapabilities = {
    providerId: 'browser-local',
    kind: 'browser-local',
    list: true,
    upload: true,
    download: true,
    delete: true,
    opaqueArchiveStorage: true,
    supportsIncrementalManifestNegotiation: false,
  };

  readonly #repository: BackupRepository;

  constructor(repository: BackupRepository) {
    this.#repository = repository;
  }

  list() {
    return this.#repository.list();
  }

  upload(input: Parameters<BackupTransport['upload']>[0]) {
    return this.#repository.save(input);
  }

  async download(id: string): Promise<Blob | null> {
    return (await this.#repository.get(id))?.archive ?? null;
  }

  delete(id: string): Promise<void> {
    return this.#repository.delete(id);
  }
}
