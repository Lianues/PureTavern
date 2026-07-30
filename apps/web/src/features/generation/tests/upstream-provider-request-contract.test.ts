import { describe, expect, it, vi } from 'vitest';

import type { CredentialResolverCapability } from '@/platform/features/standard-capabilities';

import { GenerationService } from '../application/generation-service';
import {
  DEFAULT_UPSTREAM_GENERATION_CONFIG,
  setUpstreamGenerationConfigForTesting,
} from '../compatibility/upstream-config';
import { DirectFetchClient } from '../infrastructure/direct-fetch-client';
import { BrowserStreamingGeneration } from '../ports/streaming-generation';

const defaultCredentials: CredentialResolverCapability = {
  async resolveCredential(key) {
    return `credential-for-${key}`;
  },
  async hasCredential() {
    return true;
  },
};

function createService(
  fetchImplementation: typeof window.fetch,
  credentials: CredentialResolverCapability = defaultCredentials,
): GenerationService {
  return new GenerationService(
    credentials,
    new DirectFetchClient(fetchImplementation),
    new BrowserStreamingGeneration(),
  );
}

function readJsonBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe('SillyTavern 1.18.0 provider request contracts', () => {
  it('applies Claude adaptive thinking, prefill protection and prompt caching in the browser', async () => {
    let sentInit: RequestInit | undefined;
    const nativeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentInit = init;
      return Response.json({ content: [{ type: 'text', text: 'ok' }] });
    }) as typeof window.fetch;
    const restore = setUpstreamGenerationConfigForTesting({
      ...DEFAULT_UPSTREAM_GENERATION_CONFIG,
      claude: {
        ...DEFAULT_UPSTREAM_GENERATION_CONFIG.claude,
        enableSystemPromptCache: true,
        cachingAtDepth: 0,
        extendedTTL: true,
        enableAdaptiveThinking: true,
      },
    });

    try {
      await createService(nativeFetch).generate({
        chat_completion_source: 'claude',
        model: 'claude-opus-4-6',
        messages: [
          { role: 'system', content: 'System policy' },
          { role: 'user', content: 'Question' },
          { role: 'assistant', content: 'Prefill' },
        ],
        use_sysprompt: true,
        max_tokens: 4096,
        top_p: 0.9,
        top_k: 40,
        reasoning_effort: 'high',
        include_reasoning: true,
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Look up a value',
              parameters: {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id'],
              },
            },
          },
        ],
        tool_choice: 'auto',
      });
    } finally {
      restore();
    }

    const headers = new Headers(sentInit?.headers);
    expect(headers.get('anthropic-beta')).toBe(
      'output-128k-2025-02-19,context-1m-2025-08-07,tools-2024-05-16,prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11',
    );
    const body = readJsonBody(sentInit);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(body).not.toHaveProperty('top_k');
    expect(body.system).toEqual([
      {
        type: 'text',
        text: 'System policy',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]);
    expect(body.tools).toEqual([
      expect.objectContaining({
        name: 'lookup',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      }),
    ]);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.at(-1)?.role).toBe('user');
  });

  it('matches Gemini tool, safety, thinking and image-generation request branches', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: readJsonBody(init) });
      return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    }) as typeof window.fetch;
    const service = createService(nativeFetch);

    await service.generate({
      chat_completion_source: 'makersuite',
      model: 'gemini-3-pro-preview',
      messages: [
        { role: 'system', content: 'System policy' },
        { role: 'user', content: 'Question' },
      ],
      use_sysprompt: true,
      max_tokens: 4096,
      reasoning_effort: 'high',
      include_reasoning: true,
      enable_web_search: true,
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Look up a value',
            parameters: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
            },
          },
        },
      ],
      tool_choice: 'required',
    });
    await service.generate({
      chat_completion_source: 'makersuite',
      model: 'gemini-3-pro-image-preview',
      messages: [
        { role: 'system', content: 'Must not become systemInstruction' },
        { role: 'user', content: 'Draw this' },
      ],
      use_sysprompt: true,
      request_images: true,
      request_image_aspect_ratio: '16:9',
      request_image_resolution: '2K',
      enable_web_search: true,
      tools: [
        {
          type: 'function',
          function: { name: 'ignored', parameters: { type: 'object', properties: {} } },
        },
      ],
    });

    expect(calls[0]?.url).toContain(
      '/v1beta/models/gemini-3-pro-preview:generateContent?key=credential-for-api_key_makersuite',
    );
    expect(calls[0]?.body.systemInstruction).toBeDefined();
    expect(calls[0]?.body.safetySettings).toHaveLength(5);
    expect((calls[0]?.body.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'high',
    });
    expect(calls[0]?.body.tools).toEqual([
      {
        function_declarations: [expect.objectContaining({ name: 'lookup' })],
      },
    ]);
    expect(calls[0]?.body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });

    const imageBody = calls[1]!.body;
    const imageConfig = imageBody.generationConfig as Record<string, unknown>;
    expect(imageConfig.responseModalities).toEqual(['text', 'image']);
    expect(imageConfig.imageConfig).toEqual({ imageSize: '2K', aspectRatio: '16:9' });
    expect(imageBody).not.toHaveProperty('systemInstruction');
    expect(imageBody).not.toHaveProperty('tools');
  });

  it('preserves OpenRouter routing, media, signatures and Claude cache controls', async () => {
    let sentBody: Record<string, unknown> = {};
    const nativeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = readJsonBody(init);
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof window.fetch;
    const restore = setUpstreamGenerationConfigForTesting({
      ...DEFAULT_UPSTREAM_GENERATION_CONFIG,
      claude: {
        ...DEFAULT_UPSTREAM_GENERATION_CONFIG.claude,
        enableSystemPromptCache: true,
        extendedTTL: true,
      },
    });

    try {
      await createService(nativeFetch).generate({
        chat_completion_source: 'openrouter',
        model: 'anthropic/claude-3.7-sonnet',
        messages: [
          { role: 'system', content: 'Cached system' },
          { role: 'assistant', content: 'Prior answer', signature: 'signed-reasoning' },
          {
            role: 'user',
            content: [
              {
                type: 'audio_url',
                audio_url: { url: 'data:audio/mpeg;base64,QUJD' },
              },
              {
                type: 'video_url',
                video_url: { url: 'data:video/mp4;base64,REVG' },
              },
            ],
          },
        ],
        middleout: 'on',
        enable_web_search: true,
        include_reasoning: true,
        reasoning_effort: 'high',
        verbosity: 'high',
        provider: ['Anthropic'],
        allow_fallbacks: false,
        quantizations: ['fp8'],
        use_fallback: true,
      });
    } finally {
      restore();
    }

    expect(sentBody).toMatchObject({
      transforms: ['middle-out'],
      plugins: [{ id: 'web' }],
      reasoning: { exclude: false, effort: 'high' },
      verbosity: 'high',
      provider: { allow_fallbacks: false, order: ['Anthropic'], quantizations: ['fp8'] },
      route: 'fallback',
    });
    const messages = sentBody.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toEqual([
      {
        type: 'text',
        text: 'Cached system',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]);
    expect(messages[1]).not.toHaveProperty('signature');
    expect(messages[1]?.reasoning_details).toEqual([
      expect.objectContaining({ data: 'signed-reasoning', format: 'anthropic-claude-v1' }),
    ]);
    expect(messages[2]?.content).toEqual([
      { type: 'input_audio', input_audio: { format: 'mp3', data: 'QUJD' } },
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,REVG' } },
    ]);
  });

  it('uses DeepSeek beta generation and preserves its sanitized, provider-specific body', async () => {
    let sentUrl = '';
    let sentBody: Record<string, unknown> = {};
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sentUrl = String(input);
      sentBody = readJsonBody(init);
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof window.fetch;

    await createService(nativeFetch).generate({
      chat_completion_source: 'deepseek',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'Question' }],
      max_tokens: 100,
      max_completion_tokens: 200,
      top_k: 30,
      logit_bias: { 1: -5 },
      n: 2,
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
      ],
      tool_choice: 'auto',
    });

    expect(sentUrl).toBe('https://api.deepseek.com/beta/chat/completions');
    expect(sentBody).not.toHaveProperty('max_completion_tokens');
    expect(sentBody).not.toHaveProperty('top_k');
    expect(sentBody).not.toHaveProperty('logit_bias');
    expect(sentBody).not.toHaveProperty('n');
    const tool = (sentBody.tools as Array<Record<string, unknown>>)[0]!;
    const fn = tool.function as Record<string, unknown>;
    expect(fn.parameters).not.toHaveProperty('required');
  });

  it('applies NanoGPT online, reasoning-map and Claude cache parameters', async () => {
    let sentBody: Record<string, unknown> = {};
    const nativeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = readJsonBody(init);
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof window.fetch;
    const restore = setUpstreamGenerationConfigForTesting({
      ...DEFAULT_UPSTREAM_GENERATION_CONFIG,
      claude: {
        ...DEFAULT_UPSTREAM_GENERATION_CONFIG.claude,
        enableSystemPromptCache: true,
        extendedTTL: true,
      },
    });

    try {
      await createService(nativeFetch).generate({
        chat_completion_source: 'nanogpt',
        model: 'vendor/claude-3.5-sonnet',
        messages: [{ role: 'user', content: 'Question' }],
        enable_web_search: true,
        reasoning_effort: 'min',
      });
    } finally {
      restore();
    }

    expect(sentBody.model).toBe('vendor/claude-3.5-sonnet:online');
    expect(sentBody.reasoning).toEqual({ effort: 'none' });
    expect(sentBody.cache_control).toEqual({ enabled: true, ttl: '1h' });
  });

  it('does not leak a stored provider key to a reverse proxy without proxy_password', async () => {
    let sentUrl = '';
    let sentHeaders = new Headers();
    const resolveCredential = vi.fn(async () => 'must-not-reach-proxy');
    const credentials: CredentialResolverCapability = {
      resolveCredential,
      async hasCredential() {
        return true;
      },
    };
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sentUrl = String(input);
      sentHeaders = new Headers(init?.headers);
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof window.fetch;

    await createService(nativeFetch, credentials).generate({
      chat_completion_source: 'openai',
      reverse_proxy: 'http://192.168.1.20:5000/v1',
      model: 'proxy-model',
      messages: [{ role: 'user', content: 'Question' }],
    });

    expect(sentUrl).toBe('http://192.168.1.20:5000/v1/chat/completions');
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(sentHeaders.get('Authorization')).not.toContain('must-not-reach-proxy');
  });

  it('filters Google model status and forwards non-2xx SSE without consuming it', async () => {
    const modelFetch = vi.fn(async () =>
      Response.json({
        models: [
          {
            name: 'models/gemini-chat',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/embedding-only',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      }),
    ) as typeof window.fetch;
    await expect(
      createService(modelFetch).listModels({ chat_completion_source: 'makersuite' }),
    ).resolves.toEqual({
      data: [
        {
          id: 'gemini-chat',
          name: 'models/gemini-chat',
          supportedGenerationMethods: ['generateContent'],
        },
      ],
    });

    const errorStreamFetch = vi.fn(
      async () =>
        new Response('data: {"error":"rate limited"}\n\n', {
          status: 429,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    ) as typeof window.fetch;
    const response = await createService(errorStreamFetch).generate({
      chat_completion_source: 'openai',
      model: 'stream-model',
      messages: [{ role: 'user', content: 'Question' }],
      stream: true,
    });
    expect(response.status).toBe(429);
    await expect(response.text()).resolves.toContain('rate limited');
  });

  it('keeps Custom YAML precedence and exclusions identical to the upstream route', async () => {
    let sentBody: Record<string, unknown> = {};
    const nativeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = readJsonBody(init);
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof window.fetch;

    await createService(nativeFetch).generate({
      chat_completion_source: 'custom',
      custom_url: 'https://custom.example/v1',
      model: 'koboldcpp/model',
      messages: [{ role: 'user', content: 'Question' }],
      stop: ['request-stop'],
      tools: [
        {
          type: 'function',
          function: { name: 'request_tool', parameters: { type: 'object', properties: {} } },
        },
      ],
      tool_choice: 'auto',
      reasoning_effort: 'high',
      json_schema: {
        name: 'answer',
        description: 'Must not be forwarded by this upstream branch',
        value: { type: 'object', properties: { answer: { type: 'string' } } },
      },
      custom_include_body:
        'stop: [yaml-stop]\ntools: []\nreasoning_effort: yaml\nresponse_format: { type: text }',
      custom_exclude_body: '- reasoning_effort',
    });

    expect(sentBody.stop).toEqual(['request-stop']);
    expect(sentBody.tools).toEqual([
      expect.objectContaining({ function: expect.objectContaining({ name: 'request_tool' }) }),
    ]);
    expect(sentBody).not.toHaveProperty('reasoning_effort');
    expect(sentBody.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'answer',
        strict: true,
        schema: { type: 'object', properties: { answer: { type: 'string' } } },
      },
    });
  });

  it('omits and includes provider-specific fields exactly for dedicated OpenAI-style routes', async () => {
    const bodies: Record<string, unknown>[] = [];
    const nativeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(readJsonBody(init));
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    }) as typeof window.fetch;
    const service = createService(nativeFetch);
    const base = {
      model: 'provider-model',
      messages: [{ role: 'user', content: 'Question' }],
      max_tokens: 100,
      max_completion_tokens: 200,
      top_k: 40,
      logit_bias: { 1: -5 },
      n: 2,
      stop: ['stop'],
      json_schema: {
        name: 'answer',
        description: 'Schema description',
        value: { type: 'object', properties: { answer: { type: 'string' } } },
      },
    };

    await service.generate({ ...base, chat_completion_source: 'xai' });
    await service.generate({ ...base, chat_completion_source: 'aimlapi' });
    await service.generate({ ...base, chat_completion_source: 'electronhub' });
    await service.generate({ ...base, chat_completion_source: 'chutes' });

    expect(bodies[0]).toMatchObject({ max_completion_tokens: 200, n: 2, stop: ['stop'] });
    expect(bodies[0]).not.toHaveProperty('top_k');
    expect(bodies[0]).not.toHaveProperty('logit_bias');
    expect(
      (bodies[0]?.response_format as Record<string, Record<string, unknown>>).json_schema,
    ).not.toHaveProperty('description');

    expect(bodies[1]).toMatchObject({ n: 2, stop: ['stop'] });
    expect(bodies[1]).not.toHaveProperty('max_completion_tokens');
    expect(bodies[1]).not.toHaveProperty('top_k');
    expect(bodies[1]).not.toHaveProperty('logit_bias');
    expect(
      (bodies[1]?.response_format as Record<string, Record<string, unknown>>).json_schema,
    ).toHaveProperty('description', 'Schema description');

    expect(bodies[2]).toMatchObject({ top_k: 40, logit_bias: { 1: -5 } });
    expect(bodies[2]).not.toHaveProperty('max_completion_tokens');
    expect(bodies[2]).not.toHaveProperty('n');
    expect(bodies[2]).not.toHaveProperty('stop');

    expect(bodies[3]).toMatchObject({ top_k: 40, logit_bias: { 1: -5 }, stop: ['stop'] });
    expect(bodies[3]).not.toHaveProperty('max_completion_tokens');
    expect(bodies[3]).not.toHaveProperty('n');
  });

  it('implements Vertex Full Service Account auth entirely in the frontend', async () => {
    const serviceAccount = await createServiceAccountJson();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const nativeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'browser-oauth-token' });
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    }) as typeof window.fetch;
    const credentials: CredentialResolverCapability = {
      async resolveCredential(key) {
        return key === 'vertexai_service_account_json' ? serviceAccount : `credential-for-${key}`;
      },
      async hasCredential() {
        return true;
      },
    };

    await createService(nativeFetch, credentials).generate({
      chat_completion_source: 'vertexai',
      vertexai_auth_mode: 'full',
      vertexai_region: 'europe-west4',
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'Question' }],
      max_tokens: 100,
      reasoning_effort: 'auto',
    });

    expect(calls).toHaveLength(2);
    const tokenBody = new URLSearchParams(String(calls[0]?.init?.body));
    expect(tokenBody.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(tokenBody.get('assertion')?.split('.')).toHaveLength(3);
    expect(calls[1]?.url).toBe(
      'https://europe-west4-aiplatform.googleapis.com/v1/projects/browser-project/locations/europe-west4/publishers/google/models/gemini-2.5-pro:generateContent',
    );
    expect(new Headers(calls[1]?.init?.headers).get('Authorization')).toBe(
      'Bearer browser-oauth-token',
    );
  });
});

async function createServiceAccountJson(): Promise<string> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 1024,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const privateKey = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  return JSON.stringify({
    client_email: 'browser-service-account@example.test',
    private_key: toPem(privateKey),
    project_id: 'browser-project',
  });
}

function toPem(value: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/gu) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
}
