import type { ProviderErrorCode } from '../domain/provider';

export const GENERATION_TRANSPORT_MODES = ['frontend', 'local', 'remote'] as const;

export type GenerationTransportMode = (typeof GENERATION_TRANSPORT_MODES)[number];
export type RemoteBackendConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface GenerationTransportSnapshot {
  mode: GenerationTransportMode;
  remote: {
    url: string;
    key: string;
    status: RemoteBackendConnectionStatus;
    error: string | null;
  };
}

export interface RemoteConnectionAttempt {
  revision: number;
  url: string;
  key: string;
}

export interface ConnectedRemoteBackend {
  revision: number;
  baseUrl: URL;
  key: string;
}

export interface GenerationTransportDiagnostics {
  mode: GenerationTransportMode;
  remote: {
    configured: boolean;
    status: RemoteBackendConnectionStatus;
    lastErrorCode: ProviderErrorCode | null;
  };
}

type TransportListener = (snapshot: GenerationTransportSnapshot) => void;

export class GenerationTransportState {
  readonly diagnostics: GenerationTransportDiagnostics = {
    mode: 'frontend',
    remote: {
      configured: false,
      status: 'disconnected',
      lastErrorCode: null,
    },
  };

  #mode: GenerationTransportMode = 'frontend';
  #remoteUrl = '';
  #remoteKey = '';
  #remoteStatus: RemoteBackendConnectionStatus = 'disconnected';
  #remoteError: string | null = null;
  #remoteRevision = 0;
  #connectedRemote: ConnectedRemoteBackend | null = null;
  readonly #listeners = new Set<TransportListener>();

  get mode(): GenerationTransportMode {
    return this.#mode;
  }

  get snapshot(): GenerationTransportSnapshot {
    return {
      mode: this.#mode,
      remote: {
        url: this.#remoteUrl,
        key: this.#remoteKey,
        status: this.#remoteStatus,
        error: this.#remoteError,
      },
    };
  }

  setMode(mode: GenerationTransportMode): void {
    if (this.#mode === mode) return;
    this.#mode = mode;
    this.diagnostics.mode = mode;
    this.#emit();
  }

  updateRemoteConfig(url: string, key: string): void {
    if (this.#remoteUrl === url && this.#remoteKey === key) return;
    this.#remoteUrl = url;
    this.#remoteKey = key;
    this.#remoteRevision += 1;
    this.#connectedRemote = null;
    this.#remoteStatus = 'disconnected';
    this.#remoteError = null;
    this.diagnostics.remote.configured = Boolean(url.trim() && key.trim());
    this.diagnostics.remote.status = 'disconnected';
    this.diagnostics.remote.lastErrorCode = null;
    this.#emit();
  }

  beginRemoteConnection(): RemoteConnectionAttempt {
    this.#connectedRemote = null;
    this.#remoteStatus = 'connecting';
    this.#remoteError = null;
    this.diagnostics.remote.status = 'connecting';
    this.diagnostics.remote.lastErrorCode = null;
    this.#emit();
    return {
      revision: this.#remoteRevision,
      url: this.#remoteUrl,
      key: this.#remoteKey,
    };
  }

  completeRemoteConnection(attempt: RemoteConnectionAttempt, baseUrl: URL, key: string): boolean {
    if (attempt.revision !== this.#remoteRevision) return false;
    this.#connectedRemote = {
      revision: attempt.revision,
      baseUrl: new URL(baseUrl),
      key,
    };
    this.#remoteStatus = 'connected';
    this.#remoteError = null;
    this.diagnostics.remote.status = 'connected';
    this.diagnostics.remote.lastErrorCode = null;
    this.#emit();
    return true;
  }

  failRemoteConnection(revision: number, message: string, code: ProviderErrorCode): boolean {
    if (revision !== this.#remoteRevision) return false;
    this.#connectedRemote = null;
    this.#remoteStatus = 'error';
    this.#remoteError = message;
    this.diagnostics.remote.status = 'error';
    this.diagnostics.remote.lastErrorCode = code;
    this.#emit();
    return true;
  }

  getConnectedRemote(): ConnectedRemoteBackend | null {
    if (!this.#connectedRemote || this.#remoteStatus !== 'connected') return null;
    return {
      revision: this.#connectedRemote.revision,
      baseUrl: new URL(this.#connectedRemote.baseUrl),
      key: this.#connectedRemote.key,
    };
  }

  subscribe(listener: TransportListener): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}
