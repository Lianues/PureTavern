import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import {
  PROXY_ERROR_HEADER,
  PROXY_HEADER,
  REMOTE_BACKEND_PROTOCOL,
  REMOTE_BACKEND_PROTOCOL_VERSION,
  createRemoteServer,
  readSettings,
} from '../app.mjs';

const ACCESS_KEY = 'test-remote-backend-key';
const AUTHORIZATION = `Bearer ${ACCESS_KEY}`;

function envelope(overrides = {}) {
  return {
    protocol: REMOTE_BACKEND_PROTOCOL,
    protocolVersion: REMOTE_BACKEND_PROTOCOL_VERSION,
    request: {
      url: 'https://provider.example/v1/chat/completions?api-version=1',
      method: 'POST',
      headers: {
        Authorization: 'Bearer provider-secret',
        'Content-Type': 'application/json',
      },
      body: '{"model":"test-model","stream":true}',
      ...overrides,
    },
  };
}

async function withServer(run, options = {}) {
  const server = createRemoteServer(
    {
      accessKey: ACCESS_KEY,
      allowedOrigins: ['http://127.0.0.1:8899'],
    },
    options,
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function proxy(baseUrl, payload, headers = {}) {
  return fetch(`${baseUrl}/v1/proxy`, {
    method: 'POST',
    headers: {
      Authorization: AUTHORIZATION,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

test('health requires the configured key and settings reject an empty key', async () => {
  assert.throws(
    () => createRemoteServer({ accessKey: '', allowedOrigins: ['*'] }),
    /PURE_TAVERN_PROXY_KEY/u,
  );
  assert.throws(() => readSettings({}), /PURE_TAVERN_PROXY_KEY/u);
  assert.deepEqual(
    readSettings({
      PURE_TAVERN_PROXY_KEY: ' key ',
      PURE_TAVERN_PROXY_HOST: '127.0.0.1',
      PURE_TAVERN_PROXY_PORT: '9000',
      PURE_TAVERN_ALLOWED_ORIGINS: 'http://a.example,http://b.example,http://a.example',
    }),
    {
      accessKey: 'key',
      host: '127.0.0.1',
      port: 9000,
      allowedOrigins: ['http://a.example', 'http://b.example'],
    },
  );

  await withServer(async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/v1/health`);
    const wrong = await fetch(`${baseUrl}/v1/health`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    const healthy = await fetch(`${baseUrl}/v1/health`, {
      headers: { Authorization: AUTHORIZATION },
    });

    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get(PROXY_ERROR_HEADER), 'authentication');
    assert.equal(wrong.status, 401);
    assert.equal(healthy.status, 200);
    assert.equal(healthy.headers.get(PROXY_HEADER), '1');
    assert.deepEqual(await healthy.json(), {
      status: 'ok',
      service: 'pure-tavern-remote-backend',
      protocol: REMOTE_BACKEND_PROTOCOL,
      protocolVersion: REMOTE_BACKEND_PROTOCOL_VERSION,
    });
  });
});

test('proxy forwards provider headers and streams SSE without buffering the whole body', async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ url: String(input), init });
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"delta":"one"}\n\n'));
          controller.enqueue(encoder.encode('data: {"delta":"two"}\n\n'));
          controller.close();
        },
      }),
      {
        status: 207,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Set-Cookie': 'must-not-reach-browser=true',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': 'https://provider.example',
          Vary: 'Accept-Encoding',
        },
      },
    );
  };

  await withServer(
    async (baseUrl) => {
      const response = await proxy(
        baseUrl,
        envelope({
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
            Host: 'attacker.example',
            Connection: 'upgrade',
            'Content-Length': '999999',
          },
        }),
        { Origin: 'http://127.0.0.1:8899' },
      );

      assert.equal(response.status, 207);
      assert.equal(response.headers.get(PROXY_HEADER), '1');
      assert.match(response.headers.get('content-type'), /^text\/event-stream/u);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8899');
      assert.match(response.headers.get('vary'), /Origin/iu);
      assert.match(response.headers.get('vary'), /Accept-Encoding/iu);
      assert.equal(await response.text(), 'data: {"delta":"one"}\n\ndata: {"delta":"two"}\n\n');
    },
    { fetchImpl },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://provider.example/v1/chat/completions?api-version=1');
  assert.equal(calls[0].init.method, 'POST');
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('authorization'), 'Bearer provider-secret');
  assert.equal(headers.get('http-referer'), 'https://sillytavern.app');
  assert.equal(headers.get('x-title'), 'SillyTavern');
  assert.equal(headers.get('api-key'), 'azure-provider-key');
  assert.equal(headers.get('x-api-key'), 'anthropic-provider-key');
  assert.equal(headers.get('anthropic-version'), '2023-06-01');
  assert.equal(headers.get('anthropic-beta'), 'tools-2024-05-16');
  assert.equal(headers.get('accept-language'), 'en-US,en');
  assert.equal(headers.get('x-provider'), 'preferred-provider');
  assert.equal(headers.get('x-billing-mode'), 'paygo');
  assert.equal(headers.get('host'), null);
  assert.equal(headers.get('content-length'), null);
  assert.equal(headers.get('accept-encoding'), 'identity');
  assert.equal(Buffer.from(calls[0].init.body).toString('utf8'), envelope().request.body);
});

test('proxy returns ordinary non-stream JSON unchanged', async () => {
  await withServer(
    async (baseUrl) => {
      const response = await proxy(baseUrl, envelope({ body: '{"stream":false}' }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    },
    {
      fetchImpl: async () =>
        Response.json({ ok: true }, { headers: { 'X-Upstream-Result': 'preserved' } }),
    },
  );
});

test('cross-origin redirects do not forward provider authorization', async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init.headers) });
    if (calls.length === 1) {
      return new Response(null, {
        status: 307,
        headers: { Location: 'https://redirected.example/final' },
      });
    }
    return Response.json({ ok: true });
  };

  await withServer(
    async (baseUrl) => {
      const response = await proxy(baseUrl, envelope());
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    },
    { fetchImpl },
  );

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://provider.example/v1/chat/completions?api-version=1',
      'https://redirected.example/final',
    ],
  );
  assert.equal(calls[0].headers.get('authorization'), 'Bearer provider-secret');
  assert.equal(calls[1].headers.get('authorization'), null);
});

test('invalid proxy requests are bounded and never echo provider secrets', async () => {
  const payloads = [
    envelope({ method: 'DELETE' }),
    envelope({ url: 'ftp://provider.example/model' }),
    envelope({ url: 'https://user:password@provider.example/model' }),
    envelope({ method: 'GET', body: 'must-not-have-a-body' }),
    envelope({ headers: { 'Bad Header': 'value' } }),
    envelope({ headers: { 'X-Test': 'value\r\ninjected' } }),
    { ...envelope(), protocolVersion: 999, providerSecret: 'must-not-be-echoed' },
  ];

  await withServer(async (baseUrl) => {
    for (const payload of payloads) {
      const response = await proxy(baseUrl, payload);
      const text = await response.text();
      assert.equal(response.status, 422);
      assert.equal(response.headers.get(PROXY_ERROR_HEADER), 'request');
      assert.equal(JSON.parse(text).error.code, 'invalid-proxy-request');
      assert.doesNotMatch(text, /must-not-be-echoed|provider-secret/u);
    }
  });
});

test('upstream network failures return a safe 502', async () => {
  await withServer(
    async (baseUrl) => {
      const response = await proxy(baseUrl, envelope());
      const text = await response.text();
      assert.equal(response.status, 502);
      assert.equal(response.headers.get(PROXY_ERROR_HEADER), 'upstream');
      assert.doesNotMatch(text, /private network detail|provider-secret/u);
      assert.equal(JSON.parse(text).error.code, 'upstream-unreachable');
    },
    {
      fetchImpl: async () => {
        throw new Error('private network detail');
      },
    },
  );
});

test('configured CORS origin and private-network preflight are returned', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/proxy`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:8899',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization,Content-Type',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8899');
    assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
    assert.match(response.headers.get('access-control-allow-headers'), /authorization/iu);
  });
});
