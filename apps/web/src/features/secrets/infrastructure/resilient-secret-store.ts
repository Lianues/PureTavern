import { cloneSecretDocument, type SecretDocument } from '../domain/secret';
import type { SecretStore } from '../ports/secret-store';

export interface SecretStorageDiagnostics {
  status: 'ready' | 'degraded';
  backend: 'indexeddb' | 'memory';
  message: string | null;
  lastSavedAt: string | null;
}

export class MemorySecretStore implements SecretStore {
  #document: SecretDocument | null = null;

  async load(): Promise<SecretDocument | null> {
    return this.#document ? cloneSecretDocument(this.#document) : null;
  }

  async save(document: SecretDocument): Promise<void> {
    this.#document = cloneSecretDocument(document);
  }
}

export class ResilientSecretStore implements SecretStore {
  readonly diagnostics: SecretStorageDiagnostics = {
    status: 'ready',
    backend: 'indexeddb',
    message: null,
    lastSavedAt: null,
  };

  readonly #primary: SecretStore;
  readonly #fallback: SecretStore;
  #degraded = false;

  constructor(primary: SecretStore, fallback: SecretStore = new MemorySecretStore()) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async load(): Promise<SecretDocument | null> {
    if (this.#degraded) return this.#fallback.load();
    try {
      const document = await this.#primary.load();
      if (document) await this.#fallback.save(document);
      return document;
    } catch {
      this.#degrade();
      return this.#fallback.load();
    }
  }

  async save(document: SecretDocument): Promise<void> {
    await this.#fallback.save(document);
    const savedAt = new Date().toISOString();
    if (this.#degraded) {
      this.diagnostics.lastSavedAt = savedAt;
      return;
    }
    try {
      await this.#primary.save(document);
      this.diagnostics.lastSavedAt = savedAt;
    } catch {
      this.#degrade();
      this.diagnostics.lastSavedAt = savedAt;
    }
  }

  #degrade(): void {
    this.#degraded = true;
    this.diagnostics.status = 'degraded';
    this.diagnostics.backend = 'memory';
    this.diagnostics.message =
      'Persistent credential storage is unavailable; using page memory for this session.';
  }
}
