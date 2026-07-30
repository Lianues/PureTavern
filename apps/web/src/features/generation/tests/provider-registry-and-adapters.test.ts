import { describe, expect, it, vi } from 'vitest';

import type { CredentialResolverCapability } from '@/platform/features/standard-capabilities';

import { GenerationService } from '../application/generation-service';
import { listProviderDescriptors } from '../application/provider-registry';
import { CHAT_COMPLETION_SOURCES } from '../domain/provider';
import { DirectFetchClient } from '../infrastructure/direct-fetch-client';
import { BrowserStreamingGeneration } from '../ports/streaming-generation';

const credentials: CredentialResolverCapability = {
  async resolveCredential(key) {
    return `credential-for-${key}`;
  },
  async hasCredential() {
    return true;
  },
};

function createService(
  fetchImplementation: typeof window.fetch,
  credentialResolver: CredentialResolverCapability = credentials,
) {
  return new GenerationService(
    credentialResolver,
    new DirectFetchClient(fetchImplementation),
    new BrowserStreamingGeneration(),
  );
}

describe('chat completion provider registry', () => {
  it('covers all 26 upstream sources through four protocol adapters', () => {
    const descriptors = listProviderDescriptors();
    expect(descriptors).toHaveLength(26);
    expect(new Set(descriptors.map((entry) => entry.source))).toEqual(
      new Set(CHAT_COMPLETION_SOURCES),
    );
    expect(new Set(descriptors.map((entry) => entry.protocol))).toEqual(
      new Set(['openai-compatible', 'anthropic', 'google', 'cohere']),
    );
    expect(descriptors.find((entry) => entry.source === 'openai')).toMatchObject({
      secretKey: 'api_key_openai',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(descriptors.find((entry) => entry.source === 'custom')?.keyOptional).toBe(true);
  });
});

describe('GenerationService provider adapters', () => {
  it('cleans and forwards OpenAI-compatible model and generation requests', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (String(input).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'browser-model', opaque: true }] }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello' } }] }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof window.fetch;
    const service = createService(nativeFetch);
    const base = {
      chat_completion_source: 'openai',
      reverse_proxy: 'http://127.0.0.1:43123/v1',
      proxy_password: 'proxy-secret',
      secret_id: 'must-not-leak',
    };

    await expect(service.listModels(base)).resolves.toEqual({
      data: [{ id: 'browser-model', opaque: true }],
    });
    const response = await service.generate({
      ...base,
      model: 'browser-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: false,
      temperature: 0.5,
    });
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: 'Hello' } }],
    });
    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:43123/v1/models',
      'http://127.0.0.1:43123/v1/chat/completions',
    ]);
    expect(new Headers(calls[1]!.init.headers).get('Authorization')).toBe('Bearer proxy-secret');
    const body = JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'browser-model', temperature: 0.5 });
    expect(body).not.toHaveProperty('secret_id');
    expect(body).not.toHaveProperty('proxy_password');
    expect(body).not.toHaveProperty('reverse_proxy');
  });

  it('applies upstream Custom YAML and lets user values override controllable fields', async () => {
    let sentUrl = '';
    let sentInit: RequestInit = {};
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sentUrl = String(input);
      sentInit = init ?? {};
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof window.fetch;
    const service = createService(nativeFetch);

    await service.generate({
      chat_completion_source: 'custom',
      custom_url: 'https://custom.example/v1',
      model: 'custom-model',
      messages: [{ role: 'user', content: 'Hi' }],
      reasoning_effort: 'high',
      verbosity: 'high',
      custom_include_headers:
        'Authorization: Custom user-token\nContent-Type: application/vnd.custom+json\nX-Numeric-Header: 7',
      custom_include_body: 'top_k: 42\nmodel: overridden-model\nreasoning_effort: low',
      custom_exclude_body: '- reasoning_effort\n- verbosity',
    });

    expect(sentUrl).toBe('https://custom.example/v1/chat/completions');
    const headers = new Headers(sentInit.headers);
    expect(headers.get('Authorization')).toBe('Custom user-token');
    expect(headers.get('Content-Type')).toBe('application/vnd.custom+json');
    expect(headers.get('X-Numeric-Header')).toBe('7');
    const body = JSON.parse(String(sentInit.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'overridden-model', top_k: 42 });
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('verbosity');
  });

  it('matches SillyTavern attribution and method-specific headers', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      const payload = String(input).endsWith('/models')
        ? { data: [{ id: 'header-model' }] }
        : { choices: [{ message: { content: 'ok' } }] };
      return new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof window.fetch;
    const service = createService(nativeFetch);

    await service.listModels({ chat_completion_source: 'openrouter' });
    await service.generate({
      chat_completion_source: 'openrouter',
      model: 'header-model',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    await service.generate({
      chat_completion_source: 'aimlapi',
      model: 'header-model',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    await service.generate({
      chat_completion_source: 'ai21',
      model: 'header-model',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(calls[0]).toEqual({
      url: 'https://openrouter.ai/api/v1/models',
      headers: {
        authorization: 'Bearer credential-for-api_key_openrouter',
        'http-referer': 'https://sillytavern.app',
        'x-title': 'SillyTavern',
      },
    });
    expect(calls[1]!.headers).toEqual({
      authorization: 'Bearer credential-for-api_key_openrouter',
      'content-type': 'application/json',
      'http-referer': 'https://sillytavern.app',
      'x-title': 'SillyTavern',
    });
    expect(calls[2]!.headers).toEqual({
      authorization: 'Bearer credential-for-api_key_aimlapi',
      'content-type': 'application/json',
      'http-referer': 'https://sillytavern.app',
      'x-title': 'SillyTavern',
    });
    expect(calls[3]!.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer credential-for-api_key_ai21',
      'content-type': 'application/json',
    });
  });

  it('matches SillyTavern NanoGPT provider and paygo headers', async () => {
    let sentInit: RequestInit = {};
    const nativeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentInit = init ?? {};
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof window.fetch;
    const service = createService(nativeFetch);

    await service.generate({
      chat_completion_source: 'nanogpt',
      model: 'nanogpt-model',
      messages: [{ role: 'user', content: 'Hi' }],
      nanogpt_provider: 'preferred-provider',
      nanogpt_payg_override: true,
    });

    expect(Object.fromEntries(new Headers(sentInit.headers).entries())).toEqual({
      authorization: 'Bearer credential-for-api_key_nanogpt',
      'content-type': 'application/json',
      'x-billing-mode': 'paygo',
      'x-provider': 'preferred-provider',
    });
    expect(JSON.parse(String(sentInit.body))).toMatchObject({ billing_mode: 'paygo' });
  });

  it('accepts YAML object and scalar custom exclusion variants', async () => {
    const bodies: Record<string, unknown>[] = [];
    const nativeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    }) as typeof window.fetch;
    const service = createService(nativeFetch);
    const base = {
      chat_completion_source: 'custom',
      custom_url: 'https://custom.example/v1',
      model: 'custom-model',
      messages: [{ role: 'user', content: 'Hi' }],
    };

    await service.generate({
      ...base,
      temperature: 0.4,
      seed: 42,
      custom_exclude_body: 'temperature: false\nseed: null',
    });
    await service.generate({
      ...base,
      top_p: 0.9,
      custom_exclude_body: 'top_p',
    });

    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(bodies[0]).not.toHaveProperty('seed');
    expect(bodies[1]).not.toHaveProperty('top_p');
  });

  it('surfaces provider error details while capping the returned text', async () => {
    const providerDetail = `reasoning_effort is not supported: ${'x'.repeat(600)}-tail`;
    const nativeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: providerDetail } }), {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as typeof window.fetch;
    const service = createService(nativeFetch);

    const error = await service
      .generate({
        chat_completion_source: 'custom',
        custom_url: 'https://custom.example/v1',
        model: 'custom-model',
        messages: [{ role: 'user', content: 'Hi' }],
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'provider-error', status: 400 });
    expect((error as Error).message).toContain('reasoning_effort is not supported');
    expect((error as Error).message).not.toContain('-tail');
    expect((error as Error).message.length).toBeLessThanOrEqual(540);
  });

  it('converts Anthropic, Google and Cohere text chat bodies', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        headers: new Headers(init?.headers),
      });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof window.fetch;
    const service = createService(nativeFetch);
    const messages = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer' },
    ];

    await service.generate({
      chat_completion_source: 'claude',
      model: 'claude-opus-4-6',
      messages,
      max_tokens: 100,
      reasoning_effort: 'auto',
      use_sysprompt: true,
      verbosity: 'high',
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Look up a value',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    });
    await service.generate({
      chat_completion_source: 'makersuite',
      model: 'gemini-browser',
      messages,
      max_tokens: 100,
      use_sysprompt: true,
    });
    await service.generate({
      chat_completion_source: 'cohere',
      model: 'command-browser',
      messages,
      max_tokens: 100,
    });

    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(Object.fromEntries(calls[0]!.headers.entries())).toEqual({
      'anthropic-beta':
        'output-128k-2025-02-19,context-1m-2025-08-07,tools-2024-05-16,effort-2025-11-24',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': 'credential-for-api_key_claude',
    });
    expect(calls[0]!.body).toMatchObject({
      system: [{ type: 'text', text: 'System' }],
      max_tokens: 100,
    });
    expect(calls[1]!.url).toContain(
      'generativelanguage.googleapis.com/v1beta/models/gemini-browser:generateContent',
    );
    expect(calls[1]!.url).toContain('key=credential-for-api_key_makersuite');
    expect(calls[1]!.body).toHaveProperty('systemInstruction');
    expect(calls[2]!.url).toBe('https://api.cohere.ai/v2/chat');
    expect(calls[2]!.body).toMatchObject({ model: 'command-browser', max_tokens: 100 });
  });

  it('uses Authorization for Vertex AI reverse proxy mode, matching SillyTavern', async () => {
    let sentUrl = '';
    let sentHeaders = new Headers();
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sentUrl = String(input);
      sentHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as typeof window.fetch;
    const service = createService(nativeFetch);

    await service.generate({
      chat_completion_source: 'vertexai',
      reverse_proxy: 'https://vertex-proxy.example',
      proxy_password: 'vertex-proxy-secret',
      model: 'gemini-proxy',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(sentUrl).toBe(
      'https://vertex-proxy.example/v1/publishers/google/models/gemini-proxy:generateContent',
    );
    expect(sentUrl).not.toContain('key=');
    expect(sentHeaders.get('Authorization')).toBe('Bearer vertex-proxy-secret');
    expect(sentHeaders.get('Content-Type')).toBe('application/json');
  });

  it('honors zai reverse_proxy over the zai_endpoint=coding default', async () => {
    const calls: string[] = [];
    const nativeFetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof window.fetch;
    const service = createService(nativeFetch);

    await service.generate({
      chat_completion_source: 'zai',
      zai_endpoint: 'coding',
      reverse_proxy: 'https://proxy.example/v1',
      proxy_password: 'proxy-secret',
      model: 'glm-4.6',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(calls[0]).toBe('https://proxy.example/v1/chat/completions');
  });

  it('still routes zai to the coding endpoint when no reverse_proxy is set', async () => {
    const calls: string[] = [];
    const nativeFetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof window.fetch;
    const service = createService(nativeFetch);

    await service.generate({
      chat_completion_source: 'zai',
      zai_endpoint: 'coding',
      model: 'glm-4.6',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(calls[0]).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
  });

  it('ignores legacy proxy fields for Cohere, matching the upstream provider behavior', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ models: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof window.fetch;
    const service = createService(nativeFetch);

    await service.listModels({
      chat_completion_source: 'cohere',
      reverse_proxy: 'https://proxy.example/v1',
      proxy_password: 'must-not-be-used',
    });

    expect(calls[0]!.url).toBe('https://api.cohere.ai/v1/models');
    expect(calls[0]!.headers.get('Authorization')).toBe('Bearer credential-for-api_key_cohere');
    expect(calls[0]!.headers.has('Content-Type')).toBe(false);
  });

  it('routes DeepSeek through reverse_proxy with proxy_password, matching upstream', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof window.fetch;
    const service = createService(nativeFetch);

    await service.generate({
      chat_completion_source: 'deepseek',
      reverse_proxy: 'https://proxy.example/v1',
      proxy_password: 'proxy-secret',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(calls[0]!.url).toBe('https://proxy.example/v1/chat/completions');
    expect(calls[0]!.headers.get('Authorization')).toBe('Bearer proxy-secret');
  });

  it('normalizes Pollinations arrays, Workers results and Azure configured deployments', async () => {
    const nativeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('pollinations')) {
        return new Response(JSON.stringify([{ name: 'pollinations-model' }]));
      }
      if (url.includes('example.openai.azure.com/openai/models')) {
        return Response.json({ data: [] });
      }
      if (url.includes('example.openai.azure.com/openai/deployments/deployment')) {
        return Response.json({ model: 'deployment' });
      }
      return new Response(JSON.stringify({ result: [{ name: '@cf/browser-model' }] }));
    }) as typeof window.fetch;
    const service = createService(nativeFetch);

    await expect(service.listModels({ chat_completion_source: 'pollinations' })).resolves.toEqual({
      data: [{ id: 'pollinations-model', name: 'pollinations-model' }],
    });
    await expect(
      service.listModels({
        chat_completion_source: 'workers_ai',
        workers_ai_account_id: 'account',
      }),
    ).resolves.toEqual({ data: [{ id: '@cf/browser-model', name: '@cf/browser-model' }] });
    await expect(
      service.listModels({
        chat_completion_source: 'azure_openai',
        azure_base_url: 'https://example.openai.azure.com',
        azure_deployment_name: 'deployment',
        azure_api_version: '2024-10-21',
      }),
    ).resolves.toEqual({ data: [{ id: 'deployment' }] });
  });

  it('forwards SSE without buffering and propagates abort/network errors safely', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
        controller.close();
      },
    });
    const streamFetch = vi.fn(
      async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
    ) as typeof window.fetch;
    const service = createService(streamFetch);
    const response = await service.generate({
      chat_completion_source: 'custom',
      custom_url: 'http://localhost:43123/v1',
      model: 'stream-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    await expect(response.text()).resolves.toContain('data:');

    const abortedFetch = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as typeof window.fetch;
    const abortedService = createService(abortedFetch);
    const controller = new AbortController();
    controller.abort();
    await expect(
      abortedService.generate(
        {
          chat_completion_source: 'custom',
          custom_url: 'http://localhost:43123/v1',
          model: 'stream-model',
          messages: [{ role: 'user', content: 'Hi' }],
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'aborted', status: 499 });
  });

  it('uses only explicit numeric IDs for logit bias and validates Vertex full auth honestly', async () => {
    const service = createService(vi.fn() as unknown as typeof window.fetch);
    expect(
      service.createBiasMap([
        { text: '[12, 34]', value: -5 },
        { text: 'ordinary text', value: 2 },
      ]),
    ).toEqual({ '12': -5, '34': -5 });
    expect(service.diagnostics.biasTextEntriesSkipped).toBe(1);
    await expect(
      service.generate({
        chat_completion_source: 'vertexai',
        vertexai_auth_mode: 'full',
        model: 'gemini',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({
      code: 'invalid-request',
      status: 400,
    });
  });
});
