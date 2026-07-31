import { describe, expect, it, vi } from 'vitest';

import {
  AndroidLocalBackendClient,
  isAndroidLocalBackendAvailable,
  type AndroidLocalBackendPlugin,
  type AndroidLocalBackendPluginListenerHandle,
} from '../infrastructure/android-local-backend-client';

class FakeAndroidLocalBackendPlugin implements AndroidLocalBackendPlugin {
  readonly requests: Array<Parameters<AndroidLocalBackendPlugin['startRequest']>[0]> = [];
  readonly cancellations: string[] = [];
  listener: ((event: unknown) => void) | null = null;

  async startRequest(
    options: Parameters<AndroidLocalBackendPlugin['startRequest']>[0],
  ): Promise<{ requestId: string }> {
    this.requests.push(options);
    return { requestId: options.requestId };
  }

  async cancelRequest(options: { requestId: string }): Promise<void> {
    this.cancellations.push(options.requestId);
  }

  async addListener(
    _eventName: 'pureTavernLocalServerResponse',
    listener: (event: unknown) => void,
  ): Promise<AndroidLocalBackendPluginListenerHandle> {
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

describe('Android local backend client', () => {
  it('serializes the final provider request and reconstructs a non-stream response', async () => {
    const plugin = new FakeAndroidLocalBackendPlugin();
    const client = new AndroidLocalBackendClient(plugin);
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
    await vi.waitFor(() => expect(plugin.requests).toHaveLength(1));
    const request = plugin.requests[0]!;

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
    plugin.emit({
      requestId: request.requestId,
      type: 'headers',
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json', 'X-Upstream': 'kept' },
    });
    const response = await responsePromise;
    const bodyPromise = response.text();
    plugin.emit({
      requestId: request.requestId,
      type: 'chunk',
      sequence: 0,
      data: encodeBase64('{"ok":true}'),
    });
    plugin.emit({ requestId: request.requestId, type: 'complete' });

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
  });

  it('preserves ordered SSE chunks through a ReadableStream', async () => {
    const plugin = new FakeAndroidLocalBackendPlugin();
    const client = new AndroidLocalBackendClient(plugin);
    const responsePromise = client.send('claude', new URL('https://provider.example/v1/messages'), {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    });
    await vi.waitFor(() => expect(plugin.requests).toHaveLength(1));
    const requestId = plugin.requests[0]!.requestId;
    plugin.emit({
      requestId,
      type: 'headers',
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    });
    const response = await responsePromise;
    const bodyPromise = response.text();
    plugin.emit({
      requestId,
      type: 'chunk',
      sequence: 0,
      data: encodeBase64('data: {"delta":"A"}\n'),
    });
    plugin.emit({
      requestId,
      type: 'chunk',
      sequence: 1,
      data: encodeBase64('\n'),
    });
    plugin.emit({ requestId, type: 'complete' });

    await expect(bodyPromise).resolves.toBe('data: {"delta":"A"}\n\n');
    expect(client.diagnostics.streams).toBe(1);
  });

  it('forwards AbortSignal cancellation to the native request', async () => {
    const plugin = new FakeAndroidLocalBackendPlugin();
    const client = new AndroidLocalBackendClient(plugin);
    const controller = new AbortController();
    const responsePromise = client.send('makersuite', new URL('https://provider.example/models'), {
      method: 'GET',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(plugin.requests).toHaveLength(1));
    const requestId = plugin.requests[0]!.requestId;

    controller.abort();

    await expect(responsePromise).rejects.toMatchObject({ code: 'aborted', status: 499 });
    await vi.waitFor(() => expect(plugin.cancellations).toEqual([requestId]));
    expect(client.diagnostics).toMatchObject({ failures: 1, aborted: 1 });
  });

  it('errors the reconstructed stream on an out-of-order native chunk', async () => {
    const plugin = new FakeAndroidLocalBackendPlugin();
    const client = new AndroidLocalBackendClient(plugin);
    const responsePromise = client.send('openrouter', new URL('https://provider.example/chat'), {
      method: 'POST',
      body: '{}',
    });
    await vi.waitFor(() => expect(plugin.requests).toHaveLength(1));
    const requestId = plugin.requests[0]!.requestId;
    plugin.emit({
      requestId,
      type: 'headers',
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const response = await responsePromise;
    const bodyPromise = response.text();

    plugin.emit({ requestId, type: 'chunk', sequence: 1, data: encodeBase64('bad') });

    await expect(bodyPromise).rejects.toMatchObject({ code: 'local-backend-protocol' });
    await vi.waitFor(() => expect(plugin.cancellations).toEqual([requestId]));
    expect(client.diagnostics.lastErrorCode).toBe('local-backend-protocol');
  });

  it('detects only an Android Capacitor runtime with the complete plugin', () => {
    const plugin = new FakeAndroidLocalBackendPlugin();
    expect(
      isAndroidLocalBackendAvailable({
        Capacitor: { getPlatform: () => 'android', Plugins: { PureTavernLocalServer: plugin } },
      }),
    ).toBe(true);
    expect(
      isAndroidLocalBackendAvailable({
        Capacitor: { getPlatform: () => 'web', Plugins: { PureTavernLocalServer: plugin } },
      }),
    ).toBe(false);
    expect(
      isAndroidLocalBackendAvailable({ Capacitor: { getPlatform: () => 'android', Plugins: {} } }),
    ).toBe(false);
  });
});

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
