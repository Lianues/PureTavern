import { describe, expect, it } from 'vitest';

import {
  EXTENSION_SANDBOX_PROTOCOL,
  SandboxProtocolHost,
  SandboxTimeoutError,
  type SandboxEnvelope,
} from '../application/sandbox-protocol';
import { MemoryPluginPermissionBroker } from '../infrastructure/plugin-permission-broker';

describe('sandbox protocol', () => {
  it('rejects messages from the wrong source or origin', async () => {
    const source = {};
    const sent: SandboxEnvelope[] = [];
    const host = createHost(source, sent);
    const request = capabilityRequest('request-1', 'host:events');

    await expect(
      host.handleMessage({ data: request, source: {}, origin: 'https://app.example' }),
    ).resolves.toBe(false);
    await expect(
      host.handleMessage({ data: request, source, origin: 'https://evil.example' }),
    ).resolves.toBe(false);
    expect(sent).toEqual([]);
  });

  it('denies capability calls by default and runs explicitly granted handlers', async () => {
    const source = {};
    const sent: SandboxEnvelope[] = [];
    const permissions = new MemoryPluginPermissionBroker();
    const host = new SandboxProtocolHost({
      extensionId: 'org.example.sandbox',
      sessionId: 'session-1',
      expectedSource: source,
      expectedOrigin: 'https://app.example',
      send: (envelope) => {
        sent.push(envelope);
      },
      permissions,
      capabilityHandlers: {
        'host:events': (input) => ({ echoed: input }),
      },
    });

    await expect(
      host.handleMessage({
        data: capabilityRequest('request-denied', 'host:events'),
        source,
        origin: 'https://app.example',
      }),
    ).resolves.toBe(true);
    expect(sent.at(-1)).toMatchObject({
      kind: 'response',
      ok: false,
      error: { code: 'permission-denied' },
    });

    await permissions.grant('org.example.sandbox', 'host:events');
    await host.handleMessage({
      data: capabilityRequest('request-granted', 'host:events', { value: 7 }),
      source,
      origin: 'https://app.example',
    });
    expect(sent.at(-1)).toMatchObject({
      requestId: 'request-granted',
      kind: 'response',
      ok: true,
      result: { echoed: { value: 7 } },
    });
  });

  it('correlates responses by request ID and times out missing responses', async () => {
    const source = {};
    const sent: SandboxEnvelope[] = [];
    const host = createHost(source, sent, 10);

    const response = host.request('host.ping', { ping: true });
    await Promise.resolve();
    const outgoing = sent.at(-1);
    expect(outgoing).toMatchObject({ kind: 'request', method: 'host.ping' });
    await host.handleMessage({
      data: {
        protocol: EXTENSION_SANDBOX_PROTOCOL,
        extensionId: 'org.example.sandbox',
        sessionId: 'session-1',
        requestId: outgoing!.requestId,
        kind: 'response',
        ok: true,
        result: 'pong',
      },
      source,
      origin: 'https://app.example',
    });
    await expect(response).resolves.toBe('pong');

    await expect(host.request('host.never', null)).rejects.toBeInstanceOf(SandboxTimeoutError);
  });
});

function createHost(
  source: object,
  sent: SandboxEnvelope[],
  timeoutMs = 5_000,
): SandboxProtocolHost {
  return new SandboxProtocolHost({
    extensionId: 'org.example.sandbox',
    sessionId: 'session-1',
    expectedSource: source,
    expectedOrigin: 'https://app.example',
    send: (envelope) => {
      sent.push(envelope);
    },
    permissions: new MemoryPluginPermissionBroker(),
    timeoutMs,
  });
}

function capabilityRequest(
  requestId: string,
  capability: string,
  input: unknown = null,
): SandboxEnvelope {
  return {
    protocol: EXTENSION_SANDBOX_PROTOCOL,
    extensionId: 'org.example.sandbox',
    sessionId: 'session-1',
    requestId,
    kind: 'request',
    method: 'capability.call',
    payload: { capability, input },
  };
}
