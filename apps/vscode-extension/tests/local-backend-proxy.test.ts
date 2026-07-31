import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createVscodeLocalBackendBridgeScript,
  VSCODE_LOCAL_BACKEND_PROXY_PATH,
} from '../src/local-backend-proxy.js';
import { PackagedWebServer } from '../src/static-server.js';

interface TestBridge {
  protocol: string;
  protocolVersion: number;
  startRequest(options: Record<string, unknown>): Promise<unknown>;
  cancelRequest(requestId: string): Promise<void>;
  listen(listener: (event: unknown) => void): Promise<{ remove(): Promise<void> }>;
}

interface ProxyEnvelope {
  requestId: string;
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body: string | null;
}

const roots: string[] = [];
const packagedServers: PackagedWebServer[] = [];
const upstreamServers: Server[] = [];
const pendingReleases: Array<() => void> = [];

afterEach(async () => {
  for (const release of pendingReleases.splice(0)) release();
  await Promise.all(packagedServers.splice(0).map((server) => server.stop()));
  await Promise.all(
    upstreamServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function startPackagedServer(): Promise<{ port: number; token: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'pure-tavern-vscode-proxy-'));
  roots.push(root);
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><html><head><script src="/__pure_tavern/legacy-hook.js"></script></head></html>',
    'utf8',
  );
  const server = new PackagedWebServer(root);
  packagedServers.push(server);
  const port = await server.start();
  const script = await fetch(`http://127.0.0.1:${port}/__pure_tavern/vscode-local-backend.js`).then(
    (response) => response.text(),
  );
  const tokenLiteral = /const TOKEN = ("[A-Za-z0-9_-]+");/u.exec(script)?.[1];
  if (!tokenLiteral) throw new Error('VS Code local backend token was not embedded.');
  return { port, token: JSON.parse(tokenLiteral) as string };
}

async function startUpstream(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ origin: string; server: Server }> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => response.destroy());
  });
  upstreamServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Upstream server has no port.');
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

function proxyRequest(port: number, token: string, envelope: ProxyEnvelope): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${VSCODE_LOCAL_BACKEND_PROXY_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pure-Tavern-VSCode-Token': token,
    },
    body: JSON.stringify(envelope),
  });
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function bridgeContext(
  fetchImplementation: typeof fetch,
  pageUrl = 'http://127.0.0.1:4567/forwarded/',
  scriptUrl = new URL('__pure_tavern/vscode-local-backend.js', pageUrl).toString(),
) {
  const location = new URL(pageUrl);
  return {
    AbortController,
    DOMException,
    Headers,
    ReadableStream,
    Response,
    URL,
    btoa,
    document: {
      currentScript: {
        src: scriptUrl,
      },
    },
    fetch: fetchImplementation,
    location,
  } as Record<string, unknown>;
}

describe('VS Code local backend bridge', () => {
  it('installs only at the script origin and emits the shared streaming protocol', async () => {
    const nativeFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        'http://127.0.0.1:4567/forwarded/__pure_tavern/vscode-local-backend/proxy',
      );
      expect(init?.headers).toMatchObject({
        'X-Pure-Tavern-VSCode-Token': 'test-token',
      });
      const payload = JSON.parse(String(init?.body)) as ProxyEnvelope;
      expect(payload).toMatchObject({
        requestId: 'request-1',
        url: 'http://provider.test/v1/chat',
        method: 'POST',
      });
      return new Response('data: {"ok":true}\n\n', {
        headers: {
          'Access-Control-Allow-Origin': '*',
          Connection: 'X-Transport-Hop',
          'Content-Type': 'text/event-stream',
          'Set-Cookie': 'session=secret',
          'X-Transport-Hop': 'remove',
          'X-Visible': 'yes',
        },
      });
    });
    const context = bridgeContext(nativeFetch);
    runInNewContext(createVscodeLocalBackendBridgeScript('test-token'), context);
    const bridge = context.__PURE_TAVERN_LOCAL_BACKEND__ as TestBridge;

    expect(bridge).toMatchObject({
      protocol: 'pure-tavern-local-backend',
      protocolVersion: 1,
    });
    const events: Array<Record<string, unknown>> = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await bridge.listen((event) => {
      events.push(event as Record<string, unknown>);
      if ((event as { type?: string }).type === 'complete') finish();
    });
    await bridge.startRequest({
      requestId: 'request-1',
      url: 'http://provider.test/v1/chat',
      method: 'POST',
      headers: { Authorization: 'Bearer provider-key' },
      body: '{}',
    });
    await completed;

    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual(['headers', 'chunk', 'complete']);
    expect(events[0]?.headers).toMatchObject({
      'content-type': 'text/event-stream',
      'x-visible': 'yes',
    });
    expect(events[0]?.headers).not.toHaveProperty('connection');
    expect(events[0]?.headers).not.toHaveProperty('set-cookie');
    expect(events[0]?.headers).not.toHaveProperty('x-transport-hop');
    expect(Buffer.from(String(events[1]?.data), 'base64').toString('utf8')).toContain('data:');

    const foreignContext = bridgeContext(
      nativeFetch,
      'https://attacker.example/',
      'http://127.0.0.1:4567/__pure_tavern/vscode-local-backend.js',
    );
    runInNewContext(createVscodeLocalBackendBridgeScript('test-token'), foreignContext);
    expect(foreignContext.__PURE_TAVERN_LOCAL_BACKEND__).toBeUndefined();
  });

  it('maps browser-side cancellation to an aborted bridge event', async () => {
    const nativeFetch = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const context = bridgeContext(nativeFetch);
    runInNewContext(createVscodeLocalBackendBridgeScript('test-token'), context);
    const bridge = context.__PURE_TAVERN_LOCAL_BACKEND__ as TestBridge;

    let finish!: (event: Record<string, unknown>) => void;
    const failed = new Promise<Record<string, unknown>>((resolve) => {
      finish = resolve;
    });
    await bridge.listen((event) => {
      if ((event as { type?: string }).type === 'error') {
        finish(event as Record<string, unknown>);
      }
    });
    await bridge.startRequest({
      requestId: 'request-cancel',
      url: 'https://provider.test/v1/chat',
      method: 'GET',
      headers: {},
      body: null,
    });
    await bridge.cancelRequest('request-cancel');

    await expect(failed).resolves.toMatchObject({
      requestId: 'request-cancel',
      type: 'error',
      code: 'aborted',
    });
  });
});

describe('VS Code extension-host provider proxy', () => {
  it('requires its per-session token and validates the final request envelope', async () => {
    const { port, token } = await startPackagedServer();
    const endpoint = `http://127.0.0.1:${port}${VSCODE_LOCAL_BACKEND_PROXY_PATH}`;

    const unauthorized = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(unauthorized.status).toBe(401);

    const invalid = await proxyRequest(port, token, {
      requestId: 'request-invalid',
      url: 'file:///private/provider',
      method: 'GET',
      headers: {},
      body: null,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('x-pure-tavern-vscode-proxy-error')).toBe('protocol');
  });

  it('forwards HTTP POST and SSE incrementally while filtering transport headers', async () => {
    let received:
      { method: string | undefined; body: string; headers: IncomingMessage['headers'] } | undefined;
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
      pendingReleases.push(resolve);
    });
    const upstream = await startUpstream(async (request, response) => {
      received = {
        method: request.method,
        body: await readRequestBody(request),
        headers: request.headers,
      };
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        Connection: 'X-Upstream-Hop',
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Set-Cookie': 'provider-session=secret',
        'X-Upstream-Hop': 'remove',
        'X-Visible': 'yes',
      });
      response.write('data: first\n\n');
      await streamGate;
      response.end('data: second\n\n');
    });
    const { port, token } = await startPackagedServer();

    const response = await proxyRequest(port, token, {
      requestId: 'request-stream',
      url: `${upstream.origin}/stream`,
      method: 'POST',
      headers: {
        Authorization: 'Bearer provider-key',
        Connection: 'X-Client-Hop',
        'Content-Length': '999',
        'Content-Type': 'application/json',
        Host: 'attacker.example',
        'X-Client-Hop': 'remove',
      },
      body: '{}',
    });

    try {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('x-visible')).toBe('yes');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('x-upstream-hop')).toBeNull();
      expect(received).toMatchObject({ method: 'POST', body: '{}' });
      expect(received?.headers.authorization).toBe('Bearer provider-key');
      expect(received?.headers['content-type']).toBe('application/json');
      expect(received?.headers['accept-encoding']).toBe('identity');
      expect(received?.headers.host).not.toBe('attacker.example');
      expect(received?.headers['x-client-hop']).toBeUndefined();

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Proxy response did not expose a stream.');
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('data: first');
      releaseStream();
      const chunks: Uint8Array[] = [];
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        chunks.push(part.value);
      }
      expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')).toContain(
        'data: second',
      );
    } finally {
      releaseStream();
    }
  });

  it('drops credentials and entity headers on a cross-origin POST redirect', async () => {
    let targetRequest:
      { method: string | undefined; body: string; headers: IncomingMessage['headers'] } | undefined;
    const target = await startUpstream(async (request, response) => {
      targetRequest = {
        method: request.method,
        body: await readRequestBody(request),
        headers: request.headers,
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"redirected":true}');
    });
    const source = await startUpstream((_request, response) => {
      response.writeHead(302, { Location: `${target.origin}/final` });
      response.end();
    });
    const { port, token } = await startPackagedServer();

    const response = await proxyRequest(port, token, {
      requestId: 'request-redirect',
      url: `${source.origin}/redirect`,
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'session=secret',
        'Content-Type': 'application/json',
        'X-Keep': 'yes',
      },
      body: '{"prompt":"hello"}',
    });

    await expect(response.json()).resolves.toEqual({ redirected: true });
    expect(targetRequest).toMatchObject({ method: 'GET', body: '' });
    expect(targetRequest?.headers.authorization).toBeUndefined();
    expect(targetRequest?.headers.cookie).toBeUndefined();
    expect(targetRequest?.headers['content-type']).toBeUndefined();
    expect(targetRequest?.headers['x-keep']).toBe('yes');
  });
});
