import { describe, expect, it, vi } from 'vitest';

import { LocalBackendClient } from '../infrastructure/local-backend-client';
import {
  LOCAL_BACKEND_BRIDGE_PROTOCOL,
  LOCAL_BACKEND_BRIDGE_PROTOCOL_VERSION,
  isLocalBackendBridgeAvailable,
  resolveLocalBackendBridge,
  type LocalBackendBridge,
  type LocalBackendBridgeListenerHandle,
} from '../ports/local-backend-bridge';

class FakeLocalBackendBridge implements LocalBackendBridge {
  readonly protocol = LOCAL_BACKEND_BRIDGE_PROTOCOL;
  readonly protocolVersion = LOCAL_BACKEND_BRIDGE_PROTOCOL_VERSION;
  readonly requests: Array<Parameters<LocalBackendBridge['startRequest']>[0]> = [];
  readonly cancellations: string[] = [];
  listener: ((event: unknown) => void) | null = null;

  async startRequest(options: Parameters<LocalBackendBridge['startRequest']>[0]): Promise<unknown> {
    this.requests.push(options);
    return { requestId: options.requestId };
  }

  async cancelRequest(requestId: string): Promise<void> {
    this.cancellations.push(requestId);
  }

  async listen(listener: (event: unknown) => void): Promise<LocalBackendBridgeListenerHandle> {
    this.listener = listener;
    return {
      remove: async () => {
        this.listener = null;
      },
    };
  }

  emit(event: unknown): void {
    this.listener?.(event);
  }
}

describe('shell-injected local backend client', () => {
  it('serializes the final provider request and reconstructs a non-stream response', async () => {
    const bridge = new FakeLocalBackendBridge();
    const client = new LocalBackendClient(bridge);
    const responsePromise = client.send(
      'openai',
      new URL('https://provider.example/v1/chat/completions?api-version=1'),
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer provider-secret',
          'Content-Type': 'application/json',
          'X-Provider': 'preferred',
        },
        body: '{"model":"test"}',
      },
    );
    await vi.waitFor(() => expect(bridge.requests).toHaveLength(1));
    const request = bridge.requests[0]!;

    expect(request).toMatchObject({
      url: 'https://provider.example/v1/chat/completions?api-version=1',
      method: 'POST',
      headers: {
        authorization: 'Bearer provider-secret',
        'content-type': 'application/json',
        'x-provider': 'preferred',
      },
      body: '{"model":"test"}',
    });
    bridge.emit({
      requestId: request.requestId,
      type: 'headers',
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json', 'X-Upstream': 'kept' },
    });
    const response = await responsePromise;
    const bodyPromise = response.text();
    bridge.emit({
      requestId: request.requestId,
      type: 'chunk',
      sequence: 0,
      data: encodeBase64('{"ok":true}'),
    });
    bridge.emit({ requestId: request.requestId, type: 'complete' });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Pure-Tavern-Transport')).toBe('local');
    expect(response.headers.get('X-Upstream')).toBe('kept');
    await expect(bodyPromise).resolves.toBe('{"ok":true}');
    expect(client.diagnostics).toMatchObject({
      available: true,
      requests: 1,
      streams: 0,
      failures: 0,
      lastSource: 'openai',
    });
    expect(JSON.stringify(client.diagnostics)).not.toContain('provider-secret');
  });

  it('preserves ordered SSE chunks through a ReadableStream', async () => {
    const bridge = new FakeLocalBackendBridge();
    const client = new LocalBackendClient(bridge);
    const responsePromise = client.send('claude', new URL('https://provider.example/v1/messages'), {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    });
    await vi.waitFor(() => expect(bridge.requests).toHaveLength(1));
    const requestId = bridge.requests[0]!.requestId;
    bridge.emit({
      requestId,
      type: 'headers',
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    });
    const response = await responsePromise;
    const bodyPromise = response.text();
    bridge.emit({
      requestId,
      type: 'chunk',
      sequence: 0,
      data: encodeBase64('data: {"delta":"A"}\n'),
    });
    bridge.emit({ requestId, type: 'chunk', sequence: 1, data: encodeBase64('\n') });
    bridge.emit({ requestId, type: 'complete' });

    await expect(bodyPromise).resolves.toBe('data: {"delta":"A"}\n\n');
    expect(client.diagnostics.streams).toBe(1);
  });

  it('forwards AbortSignal cancellation to the injected bridge', async () => {
    const bridge = new FakeLocalBackendBridge();
    const client = new LocalBackendClient(bridge);
    const controller = new AbortController();
    const responsePromise = client.send('makersuite', new URL('https://provider.example/models'), {
      method: 'GET',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(bridge.requests).toHaveLength(1));
    const requestId = bridge.requests[0]!.requestId;

    controller.abort();

    await expect(responsePromise).rejects.toMatchObject({ code: 'aborted', status: 499 });
    await vi.waitFor(() => expect(bridge.cancellations).toEqual([requestId]));
    expect(client.diagnostics).toMatchObject({ failures: 1, aborted: 1 });
  });

  it('errors the reconstructed stream on an out-of-order bridge chunk', async () => {
    const bridge = new FakeLocalBackendBridge();
    const client = new LocalBackendClient(bridge);
    const responsePromise = client.send('openrouter', new URL('https://provider.example/chat'), {
      method: 'POST',
      body: '{}',
    });
    await vi.waitFor(() => expect(bridge.requests).toHaveLength(1));
    const requestId = bridge.requests[0]!.requestId;
    bridge.emit({
      requestId,
      type: 'headers',
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const response = await responsePromise;
    const bodyPromise = response.text();

    bridge.emit({ requestId, type: 'chunk', sequence: 1, data: encodeBase64('bad') });

    await expect(bodyPromise).rejects.toMatchObject({ code: 'local-backend-protocol' });
    await vi.waitFor(() => expect(bridge.cancellations).toEqual([requestId]));
  });

  it('accepts only the versioned shell bridge contract', () => {
    const bridge = new FakeLocalBackendBridge();
    expect(resolveLocalBackendBridge({ __PURE_TAVERN_LOCAL_BACKEND__: bridge })).toBe(bridge);
    expect(isLocalBackendBridgeAvailable({ __PURE_TAVERN_LOCAL_BACKEND__: bridge })).toBe(true);
    expect(
      resolveLocalBackendBridge({
        __PURE_TAVERN_LOCAL_BACKEND__: { ...bridge, protocolVersion: 2 },
      }),
    ).toBeNull();
    expect(resolveLocalBackendBridge({})).toBeNull();
  });
});

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
