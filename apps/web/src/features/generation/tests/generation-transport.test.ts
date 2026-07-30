import { describe, expect, it, vi } from 'vitest';

import { GenerationTransportState } from '../application/generation-transport-state';
import {
  REMOTE_BACKEND_PROTOCOL,
  REMOTE_BACKEND_PROTOCOL_VERSION,
  type RemoteBackendProxyRequest,
} from '../domain/remote-backend-protocol';
import { DirectFetchClient } from '../infrastructure/direct-fetch-client';
import {
  normalizeRemoteBackendUrl,
  RemoteBackendClient,
} from '../infrastructure/remote-backend-client';
import { RoutingFetchClient } from '../infrastructure/routing-fetch-client';

function healthResponse(): Response {
  return Response.json({
    status: 'ok',
    service: 'pure-tavern-remote-backend',
    protocol: REMOTE_BACKEND_PROTOCOL,
    protocolVersion: REMOTE_BACKEND_PROTOCOL_VERSION,
  });
}

describe('generation transport routing', () => {
  it('keeps frontend mode on the existing direct fetch and bounds the local placeholder', async () => {
    const nativeFetch = vi.fn(async () => Response.json({ direct: true })) as typeof window.fetch;
    const state = new GenerationTransportState();
    const direct = new DirectFetchClient(nativeFetch);
    const remote = new RemoteBackendClient(nativeFetch, state);
    const routing = new RoutingFetchClient(state, direct, remote);

    const response = await routing.send('openai', new URL('https://provider.example/v1/models'), {
      method: 'GET',
    });
    await expect(response.json()).resolves.toEqual({ direct: true });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(direct.diagnostics.requests).toBe(1);
    expect(remote.diagnostics.requests).toBe(0);

    state.setMode('local');
    await expect(
      routing.send('openai', new URL('https://provider.example/v1/models'), { method: 'GET' }),
    ).rejects.toMatchObject({
      code: 'unsupported-capability',
      status: 501,
    });
  });

  it('checks the backend protocol and proxies the final provider request including SSE', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === 'http://192.168.1.8:8000/v1/health') return healthResponse();
      if (url === 'http://192.168.1.8:8000/v1/proxy') {
        return new Response('data: {"ok":true}\n\n', {
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof window.fetch;
    const state = new GenerationTransportState();
    const remote = new RemoteBackendClient(nativeFetch, state);

    state.updateRemoteConfig('http://192.168.1.8:8000', ' backend-access-key ');
    await remote.connect();
    state.setMode('remote');

    const response = await remote.send(
      'openai',
      new URL('https://api.example/v1/chat/completions'),
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer provider-secret',
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://sillytavern.app',
          'X-Title': 'SillyTavern',
          'api-key': 'azure-provider-key',
          'x-api-key': 'anthropic-provider-key',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'tools-2024-05-16',
          'Accept-Language': 'en-US,en',
          'X-Provider': 'preferred-provider',
          'X-Billing-Mode': 'paygo',
        },
        body: JSON.stringify({ model: 'test-model', stream: true }),
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer backend-access-key',
    });
    expect(calls[1]?.init?.headers).toMatchObject({
      Authorization: 'Bearer backend-access-key',
      'Content-Type': 'application/json',
    });
    const payload = JSON.parse(String(calls[1]?.init?.body)) as RemoteBackendProxyRequest;
    expect(payload).toEqual({
      protocol: REMOTE_BACKEND_PROTOCOL,
      protocolVersion: REMOTE_BACKEND_PROTOCOL_VERSION,
      request: {
        url: 'https://api.example/v1/chat/completions',
        method: 'POST',
        headers: {
          authorization: 'Bearer provider-secret',
          'content-type': 'application/json',
          'accept-language': 'en-US,en',
          'anthropic-beta': 'tools-2024-05-16',
          'anthropic-version': '2023-06-01',
          'api-key': 'azure-provider-key',
          'http-referer': 'https://sillytavern.app',
          'x-api-key': 'anthropic-provider-key',
          'x-billing-mode': 'paygo',
          'x-provider': 'preferred-provider',
          'x-title': 'SillyTavern',
        },
        body: JSON.stringify({ model: 'test-model', stream: true }),
      },
    });
    expect(response.headers.get('X-Pure-Tavern-Transport')).toBe('remote');
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    await expect(response.text()).resolves.toContain('data:');
    expect(remote.diagnostics).toMatchObject({ requests: 1, streams: 1, failures: 0 });
    expect(state.snapshot.remote.status).toBe('connected');
    expect(JSON.stringify(state.diagnostics)).not.toContain('backend-access-key');
  });

  it('invalidates a connected backend as soon as URL or key input changes', async () => {
    const nativeFetch = vi.fn(async () => healthResponse()) as typeof window.fetch;
    const state = new GenerationTransportState();
    const remote = new RemoteBackendClient(nativeFetch, state);
    state.updateRemoteConfig('http://127.0.0.1:8000', 'first-key');
    await remote.connect();
    expect(state.getConnectedRemote()).not.toBeNull();

    state.updateRemoteConfig('http://127.0.0.1:8000', 'second-key');
    expect(state.snapshot.remote.status).toBe('disconnected');
    expect(state.getConnectedRemote()).toBeNull();
    await expect(
      remote.send('openai', new URL('https://api.example/v1/models'), { method: 'GET' }),
    ).rejects.toMatchObject({
      code: 'remote-backend-not-connected',
    });
  });

  it('reports authentication and protocol failures without retaining the access key in diagnostics', async () => {
    const nativeFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({ status: 'ok', service: 'another-service' }),
      ) as typeof window.fetch;
    const state = new GenerationTransportState();
    const remote = new RemoteBackendClient(nativeFetch, state);
    state.updateRemoteConfig('http://127.0.0.1:8000', 'do-not-log-this-key');

    await expect(remote.connect()).rejects.toMatchObject({
      code: 'remote-backend-authentication',
    });
    expect(state.snapshot.remote.status).toBe('error');
    await expect(remote.connect()).rejects.toMatchObject({
      code: 'remote-backend-protocol',
    });
    expect(JSON.stringify(remote.diagnostics)).not.toContain('do-not-log-this-key');
    expect(JSON.stringify(state.diagnostics)).not.toContain('do-not-log-this-key');
  });
});

describe('remote backend URL validation', () => {
  it('normalizes a root or path prefix and rejects unsafe URL forms', () => {
    expect(normalizeRemoteBackendUrl(' http://127.0.0.1:8000 ').toString()).toBe(
      'http://127.0.0.1:8000/',
    );
    expect(normalizeRemoteBackendUrl('https://proxy.example/base').toString()).toBe(
      'https://proxy.example/base/',
    );
    expect(() => normalizeRemoteBackendUrl('ftp://proxy.example')).toThrow(
      /must use HTTP or HTTPS/u,
    );
    expect(() => normalizeRemoteBackendUrl('https://user:pass@proxy.example')).toThrow(
      /embedded credentials/u,
    );
    expect(() => normalizeRemoteBackendUrl('https://proxy.example?key=value')).toThrow(
      /query string/u,
    );
  });
});
