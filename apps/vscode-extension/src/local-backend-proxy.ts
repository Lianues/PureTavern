import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const VSCODE_LOCAL_BACKEND_SCRIPT_PATH = '/__pure_tavern/vscode-local-backend.js';
export const VSCODE_LOCAL_BACKEND_PROXY_PATH = '/__pure_tavern/vscode-local-backend/proxy';

const TOKEN_HEADER = 'x-pure-tavern-vscode-token';
const ERROR_HEADER = 'x-pure-tavern-vscode-proxy-error';
const MAX_ACTIVE_REQUESTS = 4;
const MAX_REDIRECTS = 10;
const MAX_HEADERS = 128;
const MAX_HEADER_NAME_BYTES = 256;
const MAX_HEADER_VALUE_BYTES = 32 * 1024;
const MAX_URL_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = MAX_BODY_BYTES + 512 * 1024;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const BLOCKED_REQUEST_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const BLOCKED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-length',
  ERROR_HEADER,
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'set-cookie2',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const SENSITIVE_REDIRECT_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
const ENTITY_HEADERS = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-type',
  'transfer-encoding',
];

interface PreparedProxyRequest {
  requestId: string;
  url: URL;
  method: 'GET' | 'POST';
  headers: Headers;
  body: string | null;
}

type ProxyErrorCode = 'aborted' | 'network' | 'protocol';

class ProxyRequestError extends Error {
  readonly status: number;
  readonly code: ProxyErrorCode;

  constructor(status: number, code: ProxyErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProxyRequestError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Extension-host HTTP transport used only by the packaged VS Code shell.
 * The browser receives a versioned bridge while provider traffic stays in Node.
 */
export class VscodeLocalBackendProxy {
  readonly #token = randomBytes(32).toString('base64url');
  readonly #active = new Set<AbortController>();
  readonly #bridgeScript: string;

  constructor() {
    this.#bridgeScript = createVscodeLocalBackendBridgeScript(this.#token);
  }

  async handle(
    pathname: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (pathname === VSCODE_LOCAL_BACKEND_SCRIPT_PATH) {
      this.#serveBridgeScript(request.method ?? 'GET', response);
      return true;
    }
    if (pathname !== VSCODE_LOCAL_BACKEND_PROXY_PATH) return false;
    await this.#proxy(request, response);
    return true;
  }

  abortAll(): void {
    for (const controller of this.#active) controller.abort();
    this.#active.clear();
  }

  #serveBridgeScript(method: string, response: ServerResponse): void {
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    const body = Buffer.from(this.#bridgeScript, 'utf8');
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': String(body.byteLength),
      'Content-Type': 'application/javascript; charset=utf-8',
      'Service-Worker-Allowed': '/',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(method === 'HEAD' ? undefined : body);
  }

  async #proxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return;
    }
    if (!tokenMatches(request.headers[TOKEN_HEADER], this.#token)) {
      writeProxyError(response, 401, 'protocol');
      return;
    }
    if (this.#active.size >= MAX_ACTIVE_REQUESTS) {
      writeProxyError(response, 429, 'protocol');
      return;
    }

    const controller = new AbortController();
    this.#active.add(controller);
    let completed = false;
    const abortForDisconnectedClient = () => {
      if (!completed) controller.abort();
    };
    request.once('aborted', abortForDisconnectedClient);
    response.once('close', abortForDisconnectedClient);

    try {
      const prepared = await readProxyRequest(request);
      const upstream = await sendWithSafeRedirects(prepared, controller.signal);
      writeUpstreamHeaders(response, upstream);

      if (responseHasNoBody(upstream.status) || !upstream.body) {
        completed = true;
        response.end();
        return;
      }

      const reader = upstream.body.getReader();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          await writeWithBackpressure(response, Buffer.from(part.value), controller.signal);
        }
      } finally {
        reader.releaseLock();
      }
      completed = true;
      response.end();
    } catch (error) {
      if (response.headersSent) {
        if (!response.destroyed) response.destroy();
        return;
      }
      if (response.destroyed) return;
      const normalized = normalizeProxyError(error, controller.signal);
      writeProxyError(response, normalized.status, normalized.code);
    } finally {
      completed = true;
      request.off('aborted', abortForDisconnectedClient);
      response.off('close', abortForDisconnectedClient);
      this.#active.delete(controller);
    }
  }
}

export function injectVscodeLocalBackendBridge(html: string): string {
  const relativeScriptPath = VSCODE_LOCAL_BACKEND_SCRIPT_PATH.replace(/^\//u, '');
  const tag = `<script src="${relativeScriptPath}" data-pure-tavern-vscode-local-backend="1"></script>`;
  if (html.includes(tag)) return html;
  const firstScript = html.indexOf('<script');
  if (firstScript >= 0) return `${html.slice(0, firstScript)}${tag}\n${html.slice(firstScript)}`;
  const headEnd = html.indexOf('</head>');
  if (headEnd >= 0) return `${html.slice(0, headEnd)}${tag}\n${html.slice(headEnd)}`;
  return `${tag}\n${html}`;
}

export function createVscodeLocalBackendBridgeScript(token: string): string {
  const serializedToken = JSON.stringify(token);
  const serializedProxyPath = JSON.stringify('./vscode-local-backend/proxy');
  const serializedErrorHeader = JSON.stringify(ERROR_HEADER);
  return `(() => {
  'use strict';

  const script = document.currentScript;
  if (!script || typeof script.src !== 'string') return;
  const scriptUrl = new URL(script.src, globalThis.location.href);
  if (scriptUrl.origin !== globalThis.location.origin) return;

  const BRIDGE_KEY = '__PURE_TAVERN_LOCAL_BACKEND__';
  if (Object.prototype.hasOwnProperty.call(globalThis, BRIDGE_KEY)) return;

  const TOKEN = ${serializedToken};
  const PROXY_URL = new URL(${serializedProxyPath}, scriptUrl).toString();
  const ERROR_HEADER = ${serializedErrorHeader};
  const CHUNK_SIZE = 32 * 1024;
  const listeners = new Set();
  const active = new Map();

  function emit(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // One frontend listener must not interrupt the transport.
      }
    }
  }

  function encodeBase64(bytes) {
    let binary = '';
    for (let index = 0; index < bytes.byteLength; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    return globalThis.btoa(binary);
  }

  function filterResponseHeaders(input) {
    const entries = [];
    const connectionTokens = new Set();
    input.forEach((value, name) => {
      entries.push([name, value]);
      if (name.toLowerCase() === 'connection') {
        for (const token of value.split(',')) {
          const normalized = token.trim().toLowerCase();
          if (normalized) connectionTokens.add(normalized);
        }
      }
    });
    const blocked = new Set([
      'connection',
      'content-length',
      ERROR_HEADER,
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'set-cookie',
      'set-cookie2',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      ...connectionTokens,
    ]);
    const result = Object.create(null);
    for (const [name, value] of entries) {
      const normalized = name.toLowerCase();
      if (blocked.has(normalized) || normalized.startsWith('access-control-')) continue;
      result[name] = value;
    }
    return result;
  }

  async function run(requestId, options, controller) {
    try {
      const response = await globalThis.fetch(PROXY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Pure-Tavern-VSCode-Token': TOKEN,
        },
        body: JSON.stringify({
          requestId,
          url: options.url,
          method: options.method,
          headers: options.headers,
          body: options.body,
        }),
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });

      const proxyError = response.headers.get(ERROR_HEADER);
      if (proxyError !== null) {
        emit({ requestId, type: 'error', code: proxyError });
        return;
      }

      const headers = filterResponseHeaders(response.headers);
      emit({
        requestId,
        type: 'headers',
        status: response.status,
        statusText: response.statusText,
        headers,
      });

      if (response.body !== null) {
        const reader = response.body.getReader();
        let sequence = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            for (let offset = 0; offset < part.value.byteLength; offset += CHUNK_SIZE) {
              const chunk = part.value.subarray(offset, Math.min(offset + CHUNK_SIZE, part.value.byteLength));
              emit({ requestId, type: 'chunk', sequence, data: encodeBase64(chunk) });
              sequence += 1;
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      emit({ requestId, type: 'complete' });
    } catch {
      emit({
        requestId,
        type: 'error',
        code: controller.signal.aborted ? 'aborted' : 'network',
      });
    } finally {
      if (active.get(requestId) === controller) active.delete(requestId);
    }
  }

  const bridge = Object.freeze({
    protocol: 'pure-tavern-local-backend',
    protocolVersion: 1,
    async startRequest(options) {
      const requestId = options?.requestId;
      if (typeof requestId !== 'string' || active.has(requestId)) {
        throw new Error('A unique local backend request ID is required.');
      }
      const controller = new AbortController();
      active.set(requestId, controller);
      void run(requestId, options, controller);
      return { requestId };
    },
    async cancelRequest(requestId) {
      active.get(requestId)?.abort();
    },
    async listen(listener) {
      if (typeof listener !== 'function') throw new TypeError('A local backend listener is required.');
      listeners.add(listener);
      return Object.freeze({
        async remove() {
          listeners.delete(listener);
        },
      });
    },
  });

  Object.defineProperty(globalThis, BRIDGE_KEY, {
    value: bridge,
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
`;
}

async function readProxyRequest(request: IncomingMessage): Promise<PreparedProxyRequest> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new ProxyRequestError(415, 'protocol', 'The local backend envelope must be JSON.');
  }
  const contentLength = request.headers['content-length'];
  if (
    typeof contentLength === 'string' &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_ENVELOPE_BYTES)
  ) {
    throw new ProxyRequestError(413, 'protocol', 'The local backend envelope is too large.');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
    size += chunk.byteLength;
    if (size > MAX_ENVELOPE_BYTES) {
      throw new ProxyRequestError(413, 'protocol', 'The local backend envelope is too large.');
    }
    chunks.push(chunk);
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
  } catch (error) {
    throw new ProxyRequestError(400, 'protocol', 'The local backend envelope is invalid.', {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new ProxyRequestError(400, 'protocol', 'The local backend envelope is invalid.');
  }

  const requestId = value.requestId;
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new ProxyRequestError(400, 'protocol', 'A valid local backend request ID is required.');
  }

  if (typeof value.url !== 'string' || Buffer.byteLength(value.url, 'utf8') > MAX_URL_BYTES) {
    throw new ProxyRequestError(400, 'protocol', 'The provider URL is invalid.');
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch (error) {
    throw new ProxyRequestError(400, 'protocol', 'The provider URL is invalid.', { cause: error });
  }
  if (!isSafeUrl(url)) {
    throw new ProxyRequestError(
      400,
      'protocol',
      'The provider URL must be absolute HTTP or HTTPS without credentials or a fragment.',
    );
  }

  if (typeof value.method !== 'string') {
    throw new ProxyRequestError(400, 'protocol', 'The provider method is invalid.');
  }
  const normalizedMethod = value.method.toUpperCase();
  if (normalizedMethod !== 'GET' && normalizedMethod !== 'POST') {
    throw new ProxyRequestError(400, 'protocol', 'Only GET and POST requests are supported.');
  }
  const method: 'GET' | 'POST' = normalizedMethod;

  if (value.body !== null && typeof value.body !== 'string') {
    throw new ProxyRequestError(400, 'protocol', 'The provider request body is invalid.');
  }
  const body = value.body as string | null;
  if (body !== null && Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    throw new ProxyRequestError(413, 'protocol', 'The provider request body is too large.');
  }
  if (method === 'GET' && body !== null) {
    throw new ProxyRequestError(400, 'protocol', 'GET provider requests must not contain a body.');
  }

  const headers = prepareRequestHeaders(value.headers);
  return { requestId, url, method, headers, body };
}

function prepareRequestHeaders(value: unknown): Headers {
  if (!isRecord(value)) {
    throw new ProxyRequestError(400, 'protocol', 'The provider request headers are invalid.');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_HEADERS) {
    throw new ProxyRequestError(400, 'protocol', 'The provider request contains too many headers.');
  }

  const connectionTokens = readConnectionTokens(entries);
  const headers = new Headers();
  for (const [name, rawValue] of entries) {
    if (
      typeof rawValue !== 'string' ||
      Buffer.byteLength(name, 'utf8') > MAX_HEADER_NAME_BYTES ||
      Buffer.byteLength(rawValue, 'utf8') > MAX_HEADER_VALUE_BYTES ||
      !HEADER_NAME_PATTERN.test(name) ||
      rawValue.includes('\r') ||
      rawValue.includes('\n') ||
      rawValue.includes('\0')
    ) {
      throw new ProxyRequestError(
        400,
        'protocol',
        'The provider request contains an invalid header.',
      );
    }
    const normalized = name.toLowerCase();
    if (BLOCKED_REQUEST_HEADERS.has(normalized) || connectionTokens.has(normalized)) continue;
    headers.set(name, rawValue);
  }
  headers.set('Accept-Encoding', 'identity');
  return headers;
}

async function sendWithSafeRedirects(
  initial: PreparedProxyRequest,
  signal: AbortSignal,
): Promise<Response> {
  let url = initial.url;
  let method = initial.method;
  let headers = new Headers(initial.headers);
  let body = initial.body;

  for (let redirectCount = 0; ; redirectCount += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ProxyRequestError(
        502,
        'network',
        'The VS Code local backend could not reach the provider.',
        {
          cause: error,
        },
      );
    }

    if (!isRedirect(response.status) || response.headers.get('location') === null) {
      if (response.status < 200) {
        await response.body?.cancel();
        throw new ProxyRequestError(502, 'protocol', 'The provider returned an invalid response.');
      }
      return response;
    }
    if (redirectCount >= MAX_REDIRECTS) {
      await response.body?.cancel();
      throw new ProxyRequestError(502, 'protocol', 'The provider returned too many redirects.');
    }

    const location = response.headers.get('location');
    let target: URL;
    try {
      target = new URL(location ?? '', url);
    } catch (error) {
      await response.body?.cancel();
      throw new ProxyRequestError(502, 'protocol', 'The provider returned an invalid redirect.', {
        cause: error,
      });
    }
    await response.body?.cancel();
    if (!isSafeUrl(target)) {
      throw new ProxyRequestError(502, 'protocol', 'The provider returned an unsafe redirect.');
    }

    if (!sameOrigin(url, target)) {
      headers = new Headers(headers);
      for (const name of SENSITIVE_REDIRECT_HEADERS) headers.delete(name);
    }
    if (method === 'POST' && [301, 302, 303].includes(response.status)) {
      method = 'GET';
      body = null;
      headers = new Headers(headers);
      for (const name of ENTITY_HEADERS) headers.delete(name);
    }
    url = target;
  }
}

function writeUpstreamHeaders(response: ServerResponse, upstream: Response): void {
  response.statusCode = upstream.status;
  if (/^[\x20-\x7e]*$/u.test(upstream.statusText)) response.statusMessage = upstream.statusText;
  for (const [name, value] of filteredResponseHeaders(upstream.headers)) {
    response.setHeader(name, value);
  }
  response.flushHeaders();
}

function filteredResponseHeaders(headers: Headers): Map<string, string> {
  const entries = [...headers.entries()];
  const connectionTokens = readConnectionTokens(entries);
  const result = new Map<string, string>();
  for (const [name, value] of entries) {
    if (result.size >= MAX_HEADERS) break;
    const normalized = name.toLowerCase();
    if (
      BLOCKED_RESPONSE_HEADERS.has(normalized) ||
      connectionTokens.has(normalized) ||
      normalized.startsWith('access-control-') ||
      Buffer.byteLength(value, 'utf8') > MAX_HEADER_VALUE_BYTES ||
      value.includes('\r') ||
      value.includes('\n') ||
      value.includes('\0')
    ) {
      continue;
    }
    result.set(name, value);
  }
  return result;
}

function readConnectionTokens(entries: Array<[string, unknown]>): Set<string> {
  const result = new Set<string>();
  for (const [name, value] of entries) {
    if (name.toLowerCase() !== 'connection' || typeof value !== 'string') continue;
    for (const token of value.split(',')) {
      const normalized = token.trim().toLowerCase();
      if (normalized) result.add(normalized);
    }
  }
  return result;
}

async function writeWithBackpressure(
  response: ServerResponse,
  chunk: Buffer,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed) throw abortError();
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', handleDrain);
      response.off('close', handleClose);
      signal.removeEventListener('abort', handleAbort);
    };
    const handleDrain = () => {
      cleanup();
      resolve();
    };
    const handleClose = () => {
      cleanup();
      reject(abortError());
    };
    const handleAbort = () => {
      cleanup();
      reject(abortError());
    };
    response.once('drain', handleDrain);
    response.once('close', handleClose);
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

function writeProxyError(response: ServerResponse, status: number, code: ProxyErrorCode): void {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': '0',
    [ERROR_HEADER]: code,
    'X-Content-Type-Options': 'nosniff',
  });
  response.end();
}

function normalizeProxyError(error: unknown, signal: AbortSignal): ProxyRequestError {
  if (error instanceof ProxyRequestError) return error;
  if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
    return new ProxyRequestError(499, 'aborted', 'The VS Code local backend request was aborted.', {
      cause: error,
    });
  }
  return new ProxyRequestError(502, 'network', 'The VS Code local backend request failed.', {
    cause: error,
  });
}

function tokenMatches(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== 'string') return false;
  const actualBytes = Buffer.from(value, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function isSafeUrl(url: URL): boolean {
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.hostname.length > 0 &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.hash.length === 0
  );
}

function sameOrigin(left: URL, right: URL): boolean {
  return (
    left.protocol.toLowerCase() === right.protocol.toLowerCase() &&
    left.hostname.toLowerCase() === right.hostname.toLowerCase() &&
    effectivePort(left) === effectivePort(right)
  );
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function responseHasNoBody(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function abortError(): DOMException {
  return new DOMException('The local backend request was aborted.', 'AbortError');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
