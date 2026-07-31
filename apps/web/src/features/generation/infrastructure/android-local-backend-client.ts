import {
  createFinalProviderRequest,
  type FinalProviderRequest,
} from '../domain/final-provider-request';
import { GenerationProviderError, type ProviderErrorCode } from '../domain/provider';
import type { ProviderHttpClient } from '../ports/provider-http-client';

const RESPONSE_EVENT = 'pureTavernLocalServerResponse';
const TRANSPORT_HEADER = 'X-Pure-Tavern-Transport';
const MAX_DECODED_CHUNK_SIZE = 32 * 1024;
const MAX_ENCODED_CHUNK_SIZE = 48 * 1024;

export interface AndroidLocalBackendPluginListenerHandle {
  remove(): Promise<void>;
}

export interface AndroidLocalBackendPlugin {
  startRequest(
    options: FinalProviderRequest & { requestId: string },
  ): Promise<{ requestId: string }>;
  cancelRequest(options: { requestId: string }): Promise<void>;
  addListener(
    eventName: typeof RESPONSE_EVENT,
    listener: (event: unknown) => void,
  ): Promise<AndroidLocalBackendPluginListenerHandle>;
}

export interface AndroidLocalBackendScope {
  Capacitor?: {
    getPlatform?: () => string;
    Plugins?: {
      PureTavernLocalServer?: unknown;
      [name: string]: unknown;
    };
  };
}

export interface AndroidLocalBackendDiagnostics {
  available: boolean;
  requests: number;
  streams: number;
  failures: number;
  aborted: number;
  lastSource: string | null;
  lastErrorCode: ProviderErrorCode | null;
}

interface PendingRequest {
  requestId: string;
  resolve: (response: Response) => void;
  reject: (error: GenerationProviderError) => void;
  signal: AbortSignal | null;
  abortListener: (() => void) | null;
  headersReceived: boolean;
  responseResolved: boolean;
  noBody: boolean;
  nextSequence: number;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
}

let fallbackRequestId = 0;

export function isAndroidLocalBackendAvailable(
  scope: AndroidLocalBackendScope = globalThis as AndroidLocalBackendScope,
): boolean {
  const capacitor = scope.Capacitor;
  if (!capacitor) return false;
  try {
    if (capacitor.getPlatform?.call(capacitor) !== 'android') return false;
  } catch {
    return false;
  }
  return isAndroidLocalBackendPlugin(capacitor.Plugins?.PureTavernLocalServer);
}

/** Uses the Android Capacitor bridge as a transport for the final frontend-built request. */
export class AndroidLocalBackendClient implements ProviderHttpClient {
  readonly diagnostics: AndroidLocalBackendDiagnostics;

  readonly #plugin: AndroidLocalBackendPlugin | null;
  readonly #pending = new Map<string, PendingRequest>();
  #listenerPromise: Promise<void> | null = null;
  #listenerHandle: AndroidLocalBackendPluginListenerHandle | null = null;

  constructor(plugin: AndroidLocalBackendPlugin | null = defaultPlugin()) {
    this.#plugin = plugin;
    this.diagnostics = {
      available: plugin !== null,
      requests: 0,
      streams: 0,
      failures: 0,
      aborted: 0,
      lastSource: null,
      lastErrorCode: null,
    };
  }

  async send(source: string, url: URL, init: RequestInit): Promise<Response> {
    this.diagnostics.requests += 1;
    this.diagnostics.lastSource = source;

    if (!this.#plugin) {
      const error = new GenerationProviderError(
        'local-backend-unavailable',
        'The Android local backend bridge is unavailable.',
        503,
      );
      this.#recordFailure(error);
      throw error;
    }

    const plugin = this.#plugin;
    let request: FinalProviderRequest;
    try {
      request = createFinalProviderRequest(url, init);
      if (signalAborted(init.signal)) throw abortedError();
      await this.#ensureListener();
      if (signalAborted(init.signal)) throw abortedError();
    } catch (error) {
      const providerError = normalizeBeforeStartError(error, init.signal);
      this.#recordFailure(providerError);
      throw providerError;
    }

    return await new Promise<Response>((resolve, reject) => {
      const requestId = createRequestId();
      const pending: PendingRequest = {
        requestId,
        resolve,
        reject,
        signal: init.signal ?? null,
        abortListener: null,
        headersReceived: false,
        responseResolved: false,
        noBody: false,
        nextSequence: 0,
        controller: null,
      };
      this.#pending.set(requestId, pending);

      if (pending.signal) {
        pending.abortListener = () => {
          this.#failPending(pending, abortedError(), true);
        };
        pending.signal.addEventListener('abort', pending.abortListener, { once: true });
      }

      try {
        void Promise.resolve(plugin.startRequest({ requestId, ...request })).catch(
          (error: unknown) => {
            this.#failPending(pending, rejectedRequestError(error), false);
          },
        );
      } catch (error) {
        this.#failPending(pending, rejectedRequestError(error), false);
      }
    });
  }

  async #ensureListener(): Promise<void> {
    if (this.#listenerHandle) return;
    if (!this.#plugin) throw new Error('Android local backend bridge unavailable.');
    if (!this.#listenerPromise) {
      const listenerPromise = Promise.resolve(
        this.#plugin.addListener(RESPONSE_EVENT, (event) => this.#handleEvent(event)),
      ).then((handle) => {
        this.#listenerHandle = handle;
      });
      this.#listenerPromise = listenerPromise.catch((error: unknown) => {
        this.#listenerPromise = null;
        throw error;
      });
    }
    await this.#listenerPromise;
  }

  #handleEvent(event: unknown): void {
    if (!isRecord(event) || typeof event.requestId !== 'string') return;
    const pending = this.#pending.get(event.requestId);
    if (!pending) return;

    switch (event.type) {
      case 'headers':
        this.#handleHeaders(pending, event);
        break;
      case 'chunk':
        this.#handleChunk(pending, event);
        break;
      case 'complete':
        this.#handleComplete(pending);
        break;
      case 'error':
        this.#failPending(pending, nativeEventError(event.code), false);
        break;
      default:
        this.#failPending(pending, protocolError('unknown response event'), true);
        break;
    }
  }

  #handleHeaders(pending: PendingRequest, event: Record<string, unknown>): void {
    try {
      if (pending.headersReceived) throw new Error('duplicate headers event');
      if (
        !Number.isInteger(event.status) ||
        Number(event.status) < 200 ||
        Number(event.status) > 599
      ) {
        throw new Error('invalid response status');
      }
      if (typeof event.statusText !== 'string' || /[^\x20-\x7e]/u.test(event.statusText)) {
        throw new Error('invalid response status text');
      }
      const headers = readResponseHeaders(event.headers);
      headers.set(TRANSPORT_HEADER, 'local');
      pending.noBody = responseHasNoBody(Number(event.status));

      let body: ReadableStream<Uint8Array> | null = null;
      if (!pending.noBody) {
        body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            pending.controller = controller;
          },
          cancel: () => {
            this.#cancelFromConsumer(pending);
          },
        });
      }
      const response = new Response(body, {
        status: Number(event.status),
        statusText: event.statusText,
        headers,
      });
      pending.headersReceived = true;
      pending.responseResolved = true;
      if (headers.get('Content-Type')?.includes('text/event-stream')) {
        this.diagnostics.streams += 1;
      }
      this.diagnostics.lastErrorCode = null;
      pending.resolve(response);
    } catch (error) {
      this.#failPending(pending, protocolError('invalid response headers', error), true);
    }
  }

  #handleChunk(pending: PendingRequest, event: Record<string, unknown>): void {
    try {
      if (!pending.headersReceived || pending.noBody || !pending.controller) {
        throw new Error('body chunk arrived before response headers');
      }
      if (
        !Number.isSafeInteger(event.sequence) ||
        Number(event.sequence) !== pending.nextSequence ||
        typeof event.data !== 'string' ||
        event.data.length > MAX_ENCODED_CHUNK_SIZE
      ) {
        throw new Error('invalid body chunk sequence');
      }
      const chunk = decodeBase64(event.data);
      if (chunk.byteLength > MAX_DECODED_CHUNK_SIZE) {
        throw new Error('body chunk exceeds the protocol limit');
      }
      pending.nextSequence += 1;
      pending.controller.enqueue(chunk);
    } catch (error) {
      this.#failPending(pending, protocolError('invalid response body chunk', error), true);
    }
  }

  #handleComplete(pending: PendingRequest): void {
    if (!pending.headersReceived) {
      this.#failPending(pending, protocolError('response completed before headers'), true);
      return;
    }
    try {
      pending.controller?.close();
      this.#cleanup(pending);
    } catch (error) {
      this.#failPending(pending, protocolError('response stream could not close', error), true);
    }
  }

  #cancelFromConsumer(pending: PendingRequest): void {
    if (this.#pending.get(pending.requestId) !== pending) return;
    const error = abortedError();
    this.#recordFailure(error);
    this.#cleanup(pending);
    this.#cancelNative(pending.requestId);
  }

  #failPending(
    pending: PendingRequest,
    error: GenerationProviderError,
    cancelNative: boolean,
  ): void {
    if (this.#pending.get(pending.requestId) !== pending) return;
    this.#recordFailure(error);
    this.#cleanup(pending);
    if (pending.responseResolved) {
      try {
        pending.controller?.error(error);
      } catch {
        // The stream may already have been canceled by its consumer.
      }
    } else {
      pending.reject(error);
    }
    if (cancelNative) this.#cancelNative(pending.requestId);
  }

  #cleanup(pending: PendingRequest): void {
    if (this.#pending.get(pending.requestId) === pending) {
      this.#pending.delete(pending.requestId);
    }
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener);
      pending.abortListener = null;
    }
  }

  #cancelNative(requestId: string): void {
    if (!this.#plugin) return;
    try {
      void Promise.resolve(this.#plugin.cancelRequest({ requestId })).catch(() => undefined);
    } catch {
      // Cancellation is best-effort after the frontend request has already settled.
    }
  }

  #recordFailure(error: GenerationProviderError): void {
    this.diagnostics.failures += 1;
    if (error.code === 'aborted') this.diagnostics.aborted += 1;
    this.diagnostics.lastErrorCode = error.code;
  }
}

function defaultPlugin(): AndroidLocalBackendPlugin | null {
  const scope = globalThis as AndroidLocalBackendScope;
  if (!isAndroidLocalBackendAvailable(scope)) return null;
  return scope.Capacitor?.Plugins?.PureTavernLocalServer as AndroidLocalBackendPlugin;
}

function isAndroidLocalBackendPlugin(value: unknown): value is AndroidLocalBackendPlugin {
  if (!isRecord(value)) return false;
  return (
    typeof value.startRequest === 'function' &&
    typeof value.cancelRequest === 'function' &&
    typeof value.addListener === 'function'
  );
}

function createRequestId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // Fall through to a non-secret uniqueness fallback for older WebViews.
  }
  fallbackRequestId += 1;
  return `pt-${Date.now().toString(36)}-${fallbackRequestId.toString(36)}`;
}

function readResponseHeaders(value: unknown): Headers {
  if (!isRecord(value)) throw new Error('response headers are missing');
  const headers = new Headers();
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== 'string') throw new Error('response header value is invalid');
    headers.append(name, headerValue);
  }
  return headers;
}

function decodeBase64(value: string): Uint8Array {
  const decoded = globalThis.atob(value);
  const result = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    result[index] = decoded.charCodeAt(index);
  }
  return result;
}

function rejectedRequestError(cause: unknown): GenerationProviderError {
  return new GenerationProviderError(
    'local-backend-protocol',
    'The Android local backend rejected the provider request.',
    502,
    { cause },
  );
}

function nativeEventError(code: unknown): GenerationProviderError {
  if (code === 'aborted') return abortedError();
  if (code === 'network') {
    return new GenerationProviderError(
      'local-backend-network',
      'The Android local backend could not reach the provider.',
      502,
    );
  }
  return protocolError('native proxy error');
}

function signalAborted(signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true;
}

function normalizeBeforeStartError(
  error: unknown,
  signal: AbortSignal | null | undefined,
): GenerationProviderError {
  if (error instanceof GenerationProviderError) return error;
  if (signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError')) {
    return abortedError(error);
  }
  return new GenerationProviderError(
    'local-backend-unavailable',
    'The Android local backend bridge could not be initialized.',
    503,
    { cause: error },
  );
}

function abortedError(cause?: unknown): GenerationProviderError {
  return new GenerationProviderError(
    'aborted',
    'The Android local backend request was aborted.',
    499,
    cause === undefined ? undefined : { cause },
  );
}

function protocolError(reason: string, cause?: unknown): GenerationProviderError {
  return new GenerationProviderError(
    'local-backend-protocol',
    `The Android local backend returned an invalid ${reason}.`,
    502,
    cause === undefined ? undefined : { cause },
  );
}

function responseHasNoBody(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
