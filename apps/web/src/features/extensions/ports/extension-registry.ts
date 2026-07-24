import type { ExtensionRecord, ExtensionVersionMetadata } from '../domain/extension';

export class ExtensionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionConflictError';
  }
}

export class ExtensionNotFoundError extends Error {
  constructor(extensionId: string) {
    super(`Extension is not installed: ${extensionId}`);
    this.name = 'ExtensionNotFoundError';
  }
}

export interface ExtensionRegistry {
  discover(): Promise<ExtensionRecord[]>;
  list(): Promise<ExtensionRecord[]>;
  get(extensionId: string): Promise<ExtensionRecord | null>;
  findByLegacyName(legacyName: string): Promise<ExtensionRecord | null>;
  install(record: ExtensionRecord): Promise<void>;
  upsertTrusted(record: ExtensionRecord): Promise<void>;
  enable(extensionId: string): Promise<void>;
  disable(extensionId: string): Promise<void>;
  remove(extensionId: string): Promise<void>;
  getVersion(extensionId: string): Promise<ExtensionVersionMetadata | null>;
}

export interface ExtensionStorageDiagnostics {
  status: 'ready' | 'degraded';
  backend: 'records' | 'memory';
  message: string | null;
  lastSavedAt: string | null;
}
