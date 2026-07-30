import type { GenerationTransportState } from '../application/generation-transport-state';
import { GenerationProviderError, type ProviderErrorCode } from '../domain/provider';
import {
  REMOTE_BACKEND_PROTOCOL,
  REMOTE_BACKEND_PROTOCOL_VERSION,
  type RemoteBackendHealth,
  type RemoteBackendProxyRequest,
} from '../domain/remote-backend-protocol';
import type { ProviderHttpClient } from '../ports/provider-http-client';

const TRANSPORT_HEADER = 'X-Pure-Tavern-Transport';
const PROXY_ERROR_HEADER = 'X-Pure-Tavern-Proxy-Error';

export interface RemoteBackendDiagnostics {
  connectionAttempts: number;
  requests: number;
  streams: number;
  failures: number;
  aborted: number;
  lastSource: string | null;
  lastErrorCode: ProviderErrorCode | null;
}

export class RemoteBackendClient implements ProviderHttpClient {
  readonly diagnostics: RemoteBackendDiagnostics = {
    connectionAttempts: 0,
    requests: 0,
    streams: 0,
    failures: 0,
    aborted: 0,
    lastSource: null,
    lastErrorCode: null,
  };

  readonly #fetch: typeof window.fetch;
  readonly #state: GenerationTransportState;

  constructor(nativeFetch: typeof window.fetch, state: GenerationTransportState) {
    this.#fetch = nativeFetch;
    this.#state = state;
  }

  async connect(): Promise<void> {
    this.diagnostics.connectionAttempts += 1;
    const attempt = this.#state.beginRemoteConnection();
    try {
      const baseUrl = normalizeRemoteBackendUrl(attempt.url);
      const key = requireRemoteBackendKey(attempt.key);
      const response = await this.#fetch(remoteEndpoint(baseUrl, 'v1/health'), {
        method: 'GET',
        headers: backendHeaders(key),
        cache: 'no-store',
      });
      if (response.status === 401 || response.status === 403) {
        throw new GenerationProviderError(
          'remote-backend-authentication',
          'The remote backend rejected the access key.',
          401,
        );
      }
      if (!response.ok) {
        throw new GenerationProviderError(
          'remote-backend-unreachable',
          `The remote backend health check returned HTTP ${response.status}.`,
          502,
        );
      }

      let health: unknown;
      try {
        health = (await response.json()) as unknown;
      } catch (error) {
        throw new GenerationProviderError(
          'remote-backend-protocol',
          'The remote backend health response is not valid JSON.',
          502,
          { cause: error },
        );
      }
      if (!isRemoteBackendHealth(health)) {
        throw new GenerationProviderError(
          'remote-backend-protocol',
          'The server does not implement the expected PureTavern proxy protocol.',
          502,
        );
      }
      if (!this.#state.completeRemoteConnection(attempt, baseUrl, key)) {
        throw new GenerationProviderError(
          'remote-backend-not-connected',
          'The remote backend settings changed during the connection check.',
          409,
        );
      }
      this.diagnostics.lastErrorCode = null;
    } catch (error) {
      const providerError = normalizeRemoteError(error, undefined, 'connection');
      this.diagnostics.failures += 1;
      if (providerError.code === 'aborted') this.diagnostics.aborted += 1;
      this.diagnostics.lastErrorCode = providerError.code;
      this.#state.failRemoteConnection(attempt.revision, providerError.message, providerError.code);
      throw providerError;
    }
  }

  async send(source: string, url: URL, init: RequestInit): Promise<Response> {
    this.diagnostics.requests += 1;
    this.diagnostics.lastSource = source;
    const remote = this.#state.getConnectedRemote();
    try {
      if (!remote) {
        throw new GenerationProviderError(
          'remote-backend-not-connected',
          'Connect to a remote backend before sending provider requests.',
          503,
        );
      }
      const payload = createProxyRequest(url, init);
      const response = await this.#fetch(remoteEndpoint(remote.baseUrl, 'v1/proxy'), {
        method: 'POST',
        headers: {
          ...backendHeaders(remote.key),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: init.signal ?? null,
      });
      if (
        (response.status === 401 || response.status === 403) &&
        response.headers.get(PROXY_ERROR_HEADER) === 'authentication'
      ) {
        throw new GenerationProviderError(
          'remote-backend-authentication',
          'The remote backend rejected the access key.',
          401,
        );
      }

      const headers = new Headers(response.headers);
      headers.set(TRANSPORT_HEADER, 'remote');
      if (headers.get('Content-Type')?.includes('text/event-stream')) {
        this.diagnostics.streams += 1;
      }
      this.diagnostics.lastErrorCode = null;
      return new Response(responseHasBody(response.status) ? response.body : null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      const providerError = normalizeRemoteError(error, init.signal, 'request');
      this.diagnostics.failures += 1;
      if (providerError.code === 'aborted') this.diagnostics.aborted += 1;
      this.diagnostics.lastErrorCode = providerError.code;
      if (disconnectsRemoteBackend(providerError.code) && remote) {
        this.#state.failRemoteConnection(
          remote.revision,
          providerError.message,
          providerError.code,
        );
      }
      throw providerError;
    }
  }
}

export function normalizeRemoteBackendUrl(value: string): URL {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new GenerationProviderError('invalid-endpoint', 'Remote backend URL is required.', 400);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new GenerationProviderError(
      'invalid-endpoint',
      'Remote backend URL must be a valid absolute URL.',
      400,
      { cause: error },
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GenerationProviderError(
      'invalid-endpoint',
      'Remote backend URL must use HTTP or HTTPS.',
      400,
    );
  }
  if (url.username || url.password) {
    throw new GenerationProviderError(
      'invalid-endpoint',
      'Remote backend URL must not contain embedded credentials.',
      400,
    );
  }
  if (url.search || url.hash) {
    throw new GenerationProviderError(
      'invalid-endpoint',
      'Remote backend URL must not contain a query string or fragment.',
      400,
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`;
  return url;
}

function requireRemoteBackendKey(value: string): string {
  const key = value.trim();
  if (!key) {
    throw new GenerationProviderError(
      'invalid-request',
      'Remote backend access key is required.',
      400,
    );
  }
  return key;
}

function remoteEndpoint(baseUrl: URL, pathname: string): URL {
  return new URL(pathname, baseUrl);
}

function backendHeaders(key: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${key}`,
  };
}

function createProxyRequest(url: URL, init: RequestInit): RemoteBackendProxyRequest {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    throw new GenerationProviderError(
      'unsupported-capability',
      'The remote backend transport only supports GET and POST provider requests.',
      422,
    );
  }
  let body: string | null = null;
  if (init.body !== undefined && init.body !== null) {
    if (typeof init.body !== 'string') {
      throw new GenerationProviderError(
        'unsupported-capability',
        'The remote backend transport only supports string request bodies.',
        422,
      );
    }
    body = init.body;
  }
  return {
    protocol: REMOTE_BACKEND_PROTOCOL,
    protocolVersion: REMOTE_BACKEND_PROTOCOL_VERSION,
    request: {
      url: url.toString(),
      method,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body,
    },
  };
}

function isRemoteBackendHealth(value: unknown): value is RemoteBackendHealth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const health = value as Partial<RemoteBackendHealth>;
  return (
    health.status === 'ok' &&
    health.service === 'pure-tavern-remote-backend' &&
    health.protocol === REMOTE_BACKEND_PROTOCOL &&
    health.protocolVersion === REMOTE_BACKEND_PROTOCOL_VERSION
  );
}

function normalizeRemoteError(
  error: unknown,
  signal: AbortSignal | null | undefined,
  operation: 'connection' | 'request',
): GenerationProviderError {
  if (error instanceof GenerationProviderError) return error;
  const aborted =
    signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');
  if (aborted) {
    return new GenerationProviderError('aborted', 'The remote backend request was aborted.', 499, {
      cause: error,
    });
  }
  return new GenerationProviderError(
    'remote-backend-unreachable',
    operation === 'connection'
      ? 'The browser could not reach the remote backend. Check its URL, TLS and CORS settings.'
      : 'The connection to the remote backend failed.',
    502,
    { cause: error },
  );
}

function disconnectsRemoteBackend(code: ProviderErrorCode): boolean {
  return code === 'remote-backend-authentication' || code === 'remote-backend-unreachable';
}

function responseHasBody(status: number): boolean {
  return status !== 204 && status !== 205 && status !== 304;
}
