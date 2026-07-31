import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const REMOTE_BACKEND_PROTOCOL = 'pure-tavern-generation-proxy';
export const REMOTE_BACKEND_PROTOCOL_VERSION = 1;
export const PROXY_HEADER = 'X-Pure-Tavern-Proxy';
export const PROXY_ERROR_HEADER = 'X-Pure-Tavern-Proxy-Error';

const MAX_ENVELOPE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const REQUEST_BLOCKED_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'accept-encoding',
  'content-length',
  'host',
]);
const RESPONSE_BLOCKED_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-encoding',
  'content-length',
  'set-cookie',
  'set-cookie2',
]);
const CROSS_ORIGIN_SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'cookie2',
  'proxy-authorization',
];
const CONTENT_HEADERS = [
  'content-encoding',
  'content-language',
  'content-location',
  'content-type',
];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class InvalidProxyRequestError extends Error {}
export class UpstreamProxyError extends Error {}

export function readSettings(environment = process.env) {
  const accessKey = String(environment.PURE_TAVERN_PROXY_KEY ?? '').trim();
  if (!accessKey) {
    throw new Error('PURE_TAVERN_PROXY_KEY is required before the remote backend can start.');
  }

  const host = String(environment.PURE_TAVERN_PROXY_HOST ?? '0.0.0.0').trim() || '0.0.0.0';
  const rawPort = String(environment.PURE_TAVERN_PROXY_PORT ?? '8000').trim();
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('PURE_TAVERN_PROXY_PORT must be an integer between 0 and 65535.');
  }

  return {
    accessKey,
    host,
    port,
    allowedOrigins: parseAllowedOrigins(environment.PURE_TAVERN_ALLOWED_ORIGINS),
  };
}

export function parseAllowedOrigins(value) {
  const origins = String(value ?? '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length === 0 || origins.includes('*') ? ['*'] : [...new Set(origins)];
}

export function createRemoteServer(settings, { fetchImpl = globalThis.fetch } = {}) {
  const normalized = normalizeSettings(settings);
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('A Fetch-compatible implementation is required.');
  }

  return createServer(async (request, response) => {
    applyCors(request, response, normalized.allowedOrigins);
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (request.method === 'OPTIONS') {
      response.statusCode = 200;
      response.end();
      return;
    }

    if (request.method === 'GET' && pathname === '/v1/health') {
      if (!isAuthorized(request.headers.authorization, normalized.accessKey)) {
        writeAuthenticationError(response);
        return;
      }
      writeJson(response, 200, {
        status: 'ok',
        service: 'pure-tavern-remote-backend',
        protocol: REMOTE_BACKEND_PROTOCOL,
        protocolVersion: REMOTE_BACKEND_PROTOCOL_VERSION,
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/v1/proxy') {
      if (!isAuthorized(request.headers.authorization, normalized.accessKey)) {
        writeAuthenticationError(response);
        return;
      }
      await handleProxy(request, response, fetchImpl);
      return;
    }

    writeJson(
      response,
      404,
      {
        error: { code: 'not-found', message: 'The requested remote backend route does not exist.' },
      },
      'request',
    );
  });
}

function normalizeSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new TypeError('Remote backend settings are required.');
  }
  const accessKey = typeof settings.accessKey === 'string' ? settings.accessKey.trim() : '';
  if (!accessKey) {
    throw new Error('PURE_TAVERN_PROXY_KEY is required before the remote backend can start.');
  }
  const allowedOrigins = Array.isArray(settings.allowedOrigins)
    ? parseAllowedOrigins(settings.allowedOrigins.join(','))
    : parseAllowedOrigins(settings.allowedOrigins);
  return { accessKey, allowedOrigins };
}

async function handleProxy(request, response, fetchImpl) {
  let target;
  try {
    const payload = JSON.parse(await readRequestBody(request));
    target = validateEnvelope(payload);
  } catch {
    writeJson(
      response,
      422,
      {
        error: {
          code: 'invalid-proxy-request',
          message: 'The proxy request does not match protocol version 1.',
        },
      },
      'request',
    );
    return;
  }

  const controller = new AbortController();
  const abortUpstream = () => controller.abort();
  request.once('aborted', abortUpstream);
  response.once('close', () => {
    if (!response.writableEnded) abortUpstream();
  });

  let upstream;
  try {
    upstream = await fetchWithSafeRedirects(fetchImpl, target, controller.signal);
  } catch {
    if (controller.signal.aborted) {
      if (!response.destroyed) response.destroy();
      return;
    }
    writeJson(
      response,
      502,
      {
        error: {
          code: 'upstream-unreachable',
          message: 'The remote backend could not reach the upstream provider.',
        },
      },
      'upstream',
    );
    return;
  } finally {
    request.off('aborted', abortUpstream);
  }

  response.statusCode = upstream.status;
  copyResponseHeaders(upstream.headers, response);
  response.setHeader(PROXY_HEADER, '1');

  if (!upstream.body) {
    response.end();
    return;
  }

  try {
    await pipeline(Readable.fromWeb(upstream.body), response);
  } catch {
    await cancelBody(upstream);
    if (!response.destroyed) response.destroy();
  }
}

async function fetchWithSafeRedirects(fetchImpl, target, signal) {
  let currentUrl = target.url;
  let method = target.method;
  let body = target.body === null ? undefined : Buffer.from(target.body, 'utf8');
  const headers = filterRequestHeaders(target.headers);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    let upstream;
    try {
      upstream = await fetchImpl(currentUrl, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      throw new UpstreamProxyError('Upstream request failed.', { cause: error });
    }

    const location = upstream.headers.get('location');
    if (!REDIRECT_STATUSES.has(upstream.status) || !location) return upstream;
    if (redirectCount === MAX_REDIRECTS) {
      await cancelBody(upstream);
      throw new UpstreamProxyError('The upstream provider returned too many redirects.');
    }

    let nextUrl;
    try {
      nextUrl = validateTargetUrl(new URL(location, currentUrl).toString());
    } catch (error) {
      await cancelBody(upstream);
      throw error;
    }

    if (currentUrl.origin !== nextUrl.origin) {
      for (const name of CROSS_ORIGIN_SENSITIVE_HEADERS) headers.delete(name);
    }
    if (
      upstream.status === 303 ||
      ((upstream.status === 301 || upstream.status === 302) && method === 'POST')
    ) {
      method = 'GET';
      body = undefined;
      for (const name of CONTENT_HEADERS) headers.delete(name);
    }

    await cancelBody(upstream);
    currentUrl = nextUrl;
  }

  throw new UpstreamProxyError('The upstream provider returned too many redirects.');
}

function validateEnvelope(value) {
  assertExactObject(value, ['protocol', 'protocolVersion', 'request']);
  if (value.protocol !== REMOTE_BACKEND_PROTOCOL) throw new InvalidProxyRequestError();
  if (value.protocolVersion !== REMOTE_BACKEND_PROTOCOL_VERSION) {
    throw new InvalidProxyRequestError();
  }

  assertExactObject(value.request, ['url', 'method'], ['headers', 'body']);
  const method = value.request.method;
  if (method !== 'GET' && method !== 'POST') throw new InvalidProxyRequestError();
  const url = validateTargetUrl(value.request.url);
  const headers = validateHeaders(value.request.headers ?? {});
  const body = value.request.body ?? null;
  if (body !== null && typeof body !== 'string') throw new InvalidProxyRequestError();
  if (method === 'GET' && body !== null) throw new InvalidProxyRequestError();

  return { url, method, headers, body };
}

function validateTargetUrl(value) {
  if (typeof value !== 'string' || !value) throw new InvalidProxyRequestError();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidProxyRequestError();
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new InvalidProxyRequestError();
  }
  return url;
}

function validateHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProxyRequestError();
  }
  const headers = {};
  try {
    for (const [name, headerValue] of Object.entries(value)) {
      if (typeof headerValue !== 'string') throw new InvalidProxyRequestError();
      new Headers({ [name]: headerValue });
      headers[name] = headerValue;
    }
  } catch {
    throw new InvalidProxyRequestError();
  }
  return headers;
}

function assertExactObject(value, requiredKeys, optionalKeys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProxyRequestError();
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (requiredKeys.some((key) => !Object.hasOwn(value, key))) {
    throw new InvalidProxyRequestError();
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new InvalidProxyRequestError();
  }
}

function filterRequestHeaders(input) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (!REQUEST_BLOCKED_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set('Accept-Encoding', 'identity');
  return headers;
}

function copyResponseHeaders(headers, response) {
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (RESPONSE_BLOCKED_HEADERS.has(lower) || lower.startsWith('access-control-')) continue;
    if (lower === 'vary' && response.hasHeader('Vary')) {
      const existing = response.getHeader('Vary');
      const values = Array.isArray(existing) ? existing : [String(existing)];
      response.setHeader('Vary', [...values, value]);
    } else {
      response.setHeader(name, value);
    }
  }
}

function applyCors(request, response, allowedOrigins) {
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
  if (origin && allowedOrigins.includes('*')) {
    response.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins.includes(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader(
    'Access-Control-Expose-Headers',
    `${PROXY_HEADER}, ${PROXY_ERROR_HEADER}, Content-Type`,
  );
  response.setHeader('Access-Control-Max-Age', '600');
  if (request.headers['access-control-request-private-network'] === 'true') {
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

function isAuthorized(authorization, expectedKey) {
  if (typeof authorization !== 'string') return false;
  const match = /^Bearer (.+)$/iu.exec(authorization);
  if (!match?.[1]) return false;
  const expected = createHash('sha256').update(expectedKey).digest();
  const supplied = createHash('sha256').update(match[1]).digest();
  return timingSafeEqual(expected, supplied);
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_ENVELOPE_BYTES) throw new InvalidProxyRequestError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeAuthenticationError(response) {
  response.setHeader('WWW-Authenticate', 'Bearer');
  writeJson(response, 401, { detail: 'Invalid remote backend access key.' }, 'authentication');
}

function writeJson(response, status, value, errorType = null) {
  if (response.headersSent || response.destroyed) return;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader(PROXY_HEADER, '1');
  if (errorType) response.setHeader(PROXY_ERROR_HEADER, errorType);
  response.end(JSON.stringify(value));
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The redirect/error response may already have closed its body.
  }
}
