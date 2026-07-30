import {
  AZURE_OPENAI_KEYS,
  GEMINI_SAFETY,
  NANOGPT_REASONING_EFFORT_MAP,
  OPENAI_FIXED_REASONING_EFFORT,
  OPENAI_REASONING_EFFORT_MAP,
  OPENAI_REASONING_EFFORT_MODELS,
  OPENAI_VERBOSITY_MODELS,
} from '../../compatibility/upstream-constants';
import {
  addAssistantPrefix,
  addOpenRouterSignatures,
  addReasoningContentToToolCalls,
  cachingAtDepthForOpenRouterClaude,
  cachingSystemPromptForOpenRouter,
  convertAI21Messages,
  convertMistralMessages,
  convertXAIMessages,
  embedOpenRouterMedia,
  postProcessPrompt,
  PROMPT_PROCESSING_TYPE,
} from '../../compatibility/upstream-prompt-converters';
import { getUpstreamGenerationConfig } from '../../compatibility/upstream-config';
import {
  excludeKeysByYaml,
  isRecord,
  mergeObjectWithYaml,
  trimTrailingSlash,
} from '../../compatibility/upstream-utils';
import {
  GenerationProviderError,
  type LegacyGenerationRequest,
  type ModelCatalogResult,
} from '../../domain/provider';
import { resolveProviderBaseUrl } from '../provider-url';
import { normalizeModels, requireOk } from './adapter-utils';
import type { ProviderAdapter, ProviderAdapterContext } from './provider-adapter';

const ATTRIBUTION_HEADERS = {
  'HTTP-Referer': 'https://sillytavern.app',
  'X-Title': 'SillyTavern',
} as const;
const openRouterCacheableModels = new Set<string>();

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  async listModels(context: ProviderAdapterContext): Promise<ModelCatalogResult> {
    const source = context.descriptor.source;
    if (source === 'azure_openai') return this.#listAzureModels(context);
    if (source === 'cometapi') {
      throw new GenerationProviderError(
        'unsupported-capability',
        'This provider is temporarily disabled by SillyTavern 1.18.0.',
        501,
      );
    }
    const url = modelsUrl(context);
    const response = await context.client.send(source, url, {
      method: 'GET',
      headers: this.#headers(context, false),
      signal: context.signal ?? null,
    });
    await requireOk(response);
    let data: unknown;
    try {
      data = (await response.json()) as unknown;
    } catch (error) {
      throw new GenerationProviderError(
        'invalid-response',
        'The provider returned invalid model JSON.',
        502,
        { cause: error },
      );
    }
    if (source === 'pollinations' && Array.isArray(data)) {
      return { data: normalizeModels(data) };
    }
    if (!isRecord(data)) {
      throw new GenerationProviderError(
        'invalid-response',
        'Invalid provider model response.',
        502,
      );
    }
    let models: unknown = data.data ?? data.models;
    if (source === 'workers_ai') models = data.result;
    if (source === 'chutes' && Array.isArray(data.data)) {
      models = data.data.map((model) => {
        if (!isRecord(model) || !isRecord(model.pricing)) return model;
        return {
          ...model,
          pricing: {
            ...model.pricing,
            input: model.pricing.prompt,
            output: model.pricing.completion,
          },
        };
      });
    }
    return { data: normalizeModels(models) };
  }

  async generate(context: ProviderAdapterContext): Promise<Response> {
    if (context.descriptor.source === 'cometapi') {
      throw new GenerationProviderError(
        'unsupported-capability',
        'This provider is temporarily disabled by SillyTavern 1.18.0.',
        501,
      );
    }
    if (context.descriptor.source === 'mistralai' && !context.credential) {
      throw new GenerationProviderError('missing-credential', 'MistralAI API key is missing.', 400);
    }
    const request = context.request;
    const messages = cloneMessages(request.messages);
    const body = await buildProviderBody(context, messages);
    const url = generationUrl(context);
    const response = await context.client.send(context.descriptor.source, url, {
      method: 'POST',
      headers: this.#headers(context, true),
      body: JSON.stringify(body),
      signal: context.signal ?? null,
    });
    if (request.stream === true) return response;
    return requireOk(response);
  }

  #headers(context: ProviderAdapterContext, generation: boolean): Record<string, string> {
    const source = context.descriptor.source;
    const headers: Record<string, string> = {};
    if (generation) headers['Content-Type'] = 'application/json';
    if (source === 'azure_openai') {
      if (context.credential) headers['api-key'] = context.credential;
    } else {
      headers.Authorization = `Bearer ${context.credential ?? ''}`;
    }
    if (source === 'openrouter' || source === 'aimlapi')
      Object.assign(headers, ATTRIBUTION_HEADERS);
    if (source === 'ai21' && generation) headers.Accept = 'application/json';
    if (source === 'zai') headers['Accept-Language'] = 'en-US,en';
    if (source === 'nanogpt' && generation) {
      if (
        typeof context.request.nanogpt_provider === 'string' &&
        context.request.nanogpt_provider
      ) {
        headers['X-Provider'] = context.request.nanogpt_provider;
      }
      if (context.request.nanogpt_payg_override) headers['X-Billing-Mode'] = 'paygo';
    }
    if (source === 'custom') mergeObjectWithYaml(headers, context.request.custom_include_headers);
    return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
  }

  async #listAzureModels(context: ProviderAdapterContext): Promise<ModelCatalogResult> {
    const request = context.request;
    const base = requiredUrl(request.azure_base_url, 'Azure base URL');
    const deployment = requiredString(request.azure_deployment_name, 'Azure deployment name');
    const version = requiredString(request.azure_api_version, 'Azure API version');
    const models = new URL('/openai/models', base);
    models.searchParams.set('api-version', version);
    const probe = await context.client.send('azure_openai', models, {
      method: 'GET',
      headers: { 'api-key': context.credential ?? '', Accept: 'application/json' },
      signal: context.signal ?? null,
    });
    await requireOk(probe);
    const chat = new URL(
      `/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`,
      base,
    );
    chat.searchParams.set('api-version', version);
    const response = await context.client.send('azure_openai', chat, {
      method: 'POST',
      headers: {
        'api-key': context.credential ?? '',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Say word Hi' }],
        stream: false,
        max_completion_tokens: 5,
      }),
      signal: context.signal ?? null,
    });
    await requireOk(response);
    const data = (await response.json()) as unknown;
    const model = isRecord(data) && typeof data.model === 'string' ? data.model : null;
    return { data: model ? [{ id: model }] : [] };
  }
}

async function buildProviderBody(
  context: ProviderAdapterContext,
  messages: Array<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const source = context.descriptor.source;
  const request = context.request;
  switch (source) {
    case 'claude':
    case 'makersuite':
    case 'vertexai':
    case 'cohere':
      throw new GenerationProviderError('unsupported-source', 'Incorrect provider adapter.', 500);
    case 'ai21':
      return ai21Body(request, messages);
    case 'mistralai':
      return mistralBody(request, messages);
    case 'deepseek':
      return deepSeekBody(request, messages);
    case 'xai':
      return xaiBody(request, messages);
    case 'aimlapi':
      return aimlBody(request, messages);
    case 'electronhub':
      return electronHubBody(request, messages);
    case 'chutes':
      return chutesBody(request, messages);
    case 'minimax':
      return minimaxBody(request, messages);
    case 'azure_openai':
      return azureBody(request);
    case 'openrouter':
      return openRouterBody(context, messages);
    case 'custom':
      return customBody(request, messages);
    case 'perplexity':
      return perplexityBody(request, messages);
    case 'groq':
    case 'fireworks':
      return jsonSchemaOpenAiBody(request, messages);
    case 'nanogpt':
      return nanoGptBody(request, messages);
    case 'pollinations':
      return pollinationsBody(request, messages);
    case 'moonshot':
      return moonshotBody(request, messages);
    case 'zai':
      return zaiBody(request, messages);
    case 'workers_ai':
      return workersAiBody(request, messages);
    case 'openai':
      return openAiBody(request, messages);
    case 'siliconflow':
      return siliconFlowBody(request, messages);
    default:
      return standardBody(request, messages);
  }
}

function standardBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
  additions: Record<string, unknown> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages,
    model: request.model,
    temperature: request.temperature,
    max_tokens: request.max_tokens,
    max_completion_tokens: request.max_completion_tokens,
    stream: request.stream,
    presence_penalty: request.presence_penalty,
    frequency_penalty: request.frequency_penalty,
    top_p: request.top_p,
    top_k: request.top_k,
    stop: request.stop,
    logit_bias: request.logit_bias,
    seed: request.seed,
    n: request.n,
    ...additions,
  };
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    body.tools = structuredClone(request.tools);
    body.tool_choice = request.tool_choice;
  }
  if (Array.isArray(request.stop) && request.stop.length > 0)
    body.stop = structuredClone(request.stop);
  return body;
}

function openAiBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  embedOpenRouterMedia(messages, { audio: true, video: false });
  const body = standardBody(request, messages);
  body.logprobs = request.logprobs;
  body.top_logprobs = undefined;
  applyOpenAiLogprobs(body, request);
  const model = String(request.model ?? '');
  if (request.reasoning_effort && OPENAI_REASONING_EFFORT_MODELS.includes(model as never)) {
    body.reasoning_effort =
      OPENAI_FIXED_REASONING_EFFORT[model] ??
      OPENAI_REASONING_EFFORT_MAP[String(request.reasoning_effort)] ??
      request.reasoning_effort;
  }
  if (request.verbosity && OPENAI_VERBOSITY_MODELS.test(model)) body.verbosity = request.verbosity;
  if (isRecord(request.json_schema)) body.response_format = schemaResponse(request.json_schema);
  if (getUpstreamGenerationConfig().openai.randomizeUserId) body.user = crypto.randomUUID();
  return body;
}

async function openRouterBody(
  context: ProviderAdapterContext,
  messages: Array<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const request = context.request;
  const body = standardBody(request, messages, {
    transforms:
      request.middleout === 'on' ? ['middle-out'] : request.middleout === 'off' ? [] : undefined,
    plugins: request.enable_web_search ? [{ id: 'web' }] : [],
    reasoning: { exclude: !request.include_reasoning },
  });
  if (request.min_p !== undefined) body.min_p = request.min_p;
  if (request.top_a !== undefined) body.top_a = request.top_a;
  if (request.repetition_penalty !== undefined)
    body.repetition_penalty = request.repetition_penalty;
  if (Array.isArray(request.provider) && request.provider.length > 0) {
    body.provider = { allow_fallbacks: request.allow_fallbacks ?? true, order: request.provider };
  }
  if (Array.isArray(request.quantizations) && request.quantizations.length > 0) {
    body.provider = {
      ...(isRecord(body.provider) ? body.provider : {}),
      quantizations: request.quantizations,
    };
  }
  if (request.use_fallback) body.route = 'fallback';
  if (request.reasoning_effort && isRecord(body.reasoning))
    body.reasoning.effort = request.reasoning_effort;
  if (request.verbosity) body.verbosity = request.verbosity;
  if (isRecord(request.json_schema)) body.response_format = schemaResponse(request.json_schema);

  const model = String(request.model ?? '');
  const claude = /^anthropic\/claude/u.test(model);
  const gemini = /google\/gemini/u.test(model);
  const config = getUpstreamGenerationConfig();
  embedOpenRouterMedia(messages, { audio: true, video: true });
  addOpenRouterSignatures(messages, model);
  const ttl = config.claude.extendedTTL ? '1h' : '5m';
  if (claude && config.claude.enableSystemPromptCache)
    cachingSystemPromptForOpenRouter(messages, ttl);
  if (claude && config.claude.cachingAtDepth >= 0) {
    cachingAtDepthForOpenRouterClaude(messages, config.claude.cachingAtDepth, ttl);
  }
  if (gemini) {
    const cacheable = await isOpenRouterModelCacheable(context, model);
    if (cacheable && config.gemini.enableSystemPromptCache)
      cachingSystemPromptForOpenRouter(messages);
    body.safety_settings = GEMINI_SAFETY;
  }
  return body;
}

function customBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  embedOpenRouterMedia(messages, { audio: true, video: false });
  const body = standardBody(request, messages);
  body.logprobs = request.logprobs;
  body.top_logprobs = undefined;
  applyOpenAiLogprobs(body, request);
  mergeObjectWithYaml(body, request.custom_include_body);
  if (isRecord(request.json_schema)) body.response_format = schemaResponse(request.json_schema);
  if (Array.isArray(request.stop) && request.stop.length > 0) {
    body.stop = structuredClone(request.stop);
  }
  copyTools(body, request);
  const model = String(request.model ?? '');
  if (request.reasoning_effort && /^koboldcpp\//u.test(model))
    body.reasoning_effort = request.reasoning_effort;
  if (request.verbosity && OPENAI_VERBOSITY_MODELS.test(model)) body.verbosity = request.verbosity;
  excludeKeysByYaml(body, request.custom_exclude_body);
  return body;
}

function ai21Body(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  if (isRecord(request.json_schema)) appendJsonSchemaPrompt(messages, request.json_schema);
  return {
    messages: convertAI21Messages(messages, promptNames(request)),
    model: request.model,
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    stop: request.stop,
    stream: request.stream,
    tools: request.tools,
    ...(isRecord(request.json_schema) ? { response_format: { type: 'json_object' } } : {}),
  };
}

function mistralBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: convertMistralMessages(messages, promptNames(request)),
    temperature: request.temperature,
    top_p: request.top_p,
    frequency_penalty: request.frequency_penalty,
    presence_penalty: request.presence_penalty,
    max_tokens: request.max_tokens,
    stream: request.stream,
    safe_prompt: request.safe_prompt,
    random_seed: request.seed === -1 ? undefined : request.seed,
    stop: Array.isArray(request.stop) && request.stop.length > 0 ? request.stop : undefined,
  };
  copyTools(body, request);
  if (isRecord(request.json_schema))
    body.response_format = schemaResponse(request.json_schema, true);
  return body;
}

function deepSeekBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const bodyParams: Record<string, unknown> = {};
  if (typeof request.logprobs === 'number' && request.logprobs > 0) {
    bodyParams.top_logprobs = request.logprobs;
    bodyParams.logprobs = true;
  }
  const tools = Array.isArray(request.tools) ? structuredClone(request.tools) : [];
  for (const tool of tools) {
    if (
      isRecord(tool) &&
      isRecord(tool.function) &&
      isRecord(tool.function.parameters) &&
      Array.isArray(tool.function.parameters.required) &&
      tool.function.parameters.required.length === 0
    ) {
      delete tool.function.parameters.required;
    }
  }
  if (tools.length > 0) {
    bodyParams.tools = tools;
    bodyParams.tool_choice = request.tool_choice;
  }
  if (isRecord(request.json_schema)) {
    bodyParams.response_format = { type: 'json_object' };
    appendJsonSchemaPrompt(messages, request.json_schema);
  }
  const processed = addAssistantPrefix(
    postProcessPrompt(messages, PROMPT_PROCESSING_TYPE.SEMI_TOOLS, promptNames(request)),
    tools,
    'prefix',
  );
  addReasoningContentToToolCalls(processed);
  if (request.include_reasoning && request.reasoning_effort) {
    bodyParams.reasoning_effort = request.reasoning_effort;
  }
  return {
    messages: processed,
    model: request.model,
    temperature: request.temperature,
    max_tokens: request.max_tokens,
    stream: request.stream,
    presence_penalty: request.presence_penalty,
    frequency_penalty: request.frequency_penalty,
    top_p: request.top_p,
    stop: request.stop,
    seed: request.seed,
    thinking: { type: request.include_reasoning ? 'enabled' : 'disabled' },
    ...bodyParams,
  };
}

function xaiBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const bodyParams: Record<string, unknown> = {};
  applyOpenAiLogprobs(bodyParams, request);
  copyTools(bodyParams, request);
  if (Array.isArray(request.stop) && request.stop.length > 0) {
    bodyParams.stop = structuredClone(request.stop);
  }
  if (request.reasoning_effort) {
    bodyParams.reasoning_effort = request.reasoning_effort === 'high' ? 'high' : 'low';
  }
  if (isRecord(request.json_schema))
    bodyParams.response_format = schemaResponse(request.json_schema);
  return {
    messages: convertXAIMessages(messages, promptNames(request)),
    model: request.model,
    temperature: request.temperature,
    max_tokens: request.max_tokens,
    max_completion_tokens: request.max_completion_tokens,
    stream: request.stream,
    presence_penalty: request.presence_penalty,
    frequency_penalty: request.frequency_penalty,
    top_p: request.top_p,
    seed: request.seed,
    n: request.n,
    ...bodyParams,
  };
}

function aimlBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const bodyParams: Record<string, unknown> = {};
  applyOpenAiLogprobs(bodyParams, request);
  copyTools(bodyParams, request);
  if (Array.isArray(request.stop) && request.stop.length > 0) {
    bodyParams.stop = structuredClone(request.stop);
  }
  if (request.reasoning_effort) bodyParams.reasoning_effort = request.reasoning_effort;
  if (isRecord(request.json_schema)) {
    bodyParams.response_format = schemaResponse(request.json_schema, true);
  }
  return {
    messages,
    model: request.model,
    temperature: request.temperature,
    max_tokens: request.max_tokens,
    stream: request.stream,
    presence_penalty: request.presence_penalty,
    frequency_penalty: request.frequency_penalty,
    top_p: request.top_p,
    seed: request.seed,
    n: request.n,
    ...bodyParams,
  };
}

function electronHubBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const bodyParams: Record<string, unknown> = {
    web_search: request.enable_web_search ? true : undefined,
    reasoning_effort: request.reasoning_effort,
  };
  copyTools(bodyParams, request);
  if (isRecord(request.json_schema)) {
    bodyParams.response_format = schemaResponse(request.json_schema, true);
  }
  const model = String(request.model ?? '');
  const config = getUpstreamGenerationConfig();
  if (/^claude-/u.test(model)) {
    const ttl = config.claude.extendedTTL ? '1h' : '5m';
    if (config.claude.enableSystemPromptCache) cachingSystemPromptForOpenRouter(messages, ttl);
    if (config.claude.cachingAtDepth >= 0) {
      cachingAtDepthForOpenRouterClaude(messages, config.claude.cachingAtDepth, ttl);
    }
  }
  return {
    messages,
    model: request.model,
    temperature: request.temperature,
    max_tokens: request.max_tokens,
    stream: request.stream,
    presence_penalty: request.presence_penalty,
    frequency_penalty: request.frequency_penalty,
    top_p: request.top_p,
    top_k: request.top_k,
    logit_bias: request.logit_bias,
    seed: request.seed,
    ...bodyParams,
  };
}

function chutesBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const bodyParams: Record<string, unknown> = {};
  applyOpenAiLogprobs(bodyParams, request);
  copyTools(bodyParams, request);
  if (isRecord(request.json_schema)) {
    bodyParams.response_format = schemaResponse(request.json_schema, true);
  }
  return {
    messages,
    model: request.model,
    temperature: request.temperature,
    max_tokens: request.max_tokens,
    stream: request.stream,
    presence_penalty: request.presence_penalty,
    frequency_penalty: request.frequency_penalty,
    repetition_penalty: request.repetition_penalty,
    min_p: request.min_p,
    top_p: request.top_p,
    top_k: request.top_k,
    seed: request.seed,
    stop: request.stop,
    reasoning_effort: request.reasoning_effort,
    logit_bias: request.logit_bias,
    ...bodyParams,
  };
}

function minimaxBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    messages: postProcessPrompt(messages, PROMPT_PROCESSING_TYPE.MERGE_TOOLS, promptNames(request)),
    model: request.model,
    temperature: request.temperature,
    max_tokens:
      request.model === 'M2-her' ? Math.min(Number(request.max_tokens), 2048) : request.max_tokens,
    stream: request.stream,
    top_p: request.top_p,
    stop: request.stop,
    ...(Array.isArray(request.tools) && request.tools.length > 0
      ? { tools: request.tools, tool_choice: request.tool_choice }
      : {}),
  };
}

function azureBody(request: LegacyGenerationRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of AZURE_OPENAI_KEYS) {
    if (Object.hasOwn(request, key)) body[key] = request[key];
  }
  if (isRecord(request.json_schema)) body.response_format = schemaResponse(request.json_schema);
  applyOpenAiLogprobs(body, request);
  const model = String(request.model ?? '');
  body.reasoning_effort = OPENAI_REASONING_EFFORT_MODELS.includes(model as never)
    ? (OPENAI_FIXED_REASONING_EFFORT[model] ??
      OPENAI_REASONING_EFFORT_MAP[String(request.reasoning_effort)] ??
      request.reasoning_effort)
    : undefined;
  return body;
}

function perplexityBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const processed = postProcessPrompt(
    messages,
    PROMPT_PROCESSING_TYPE.STRICT,
    promptNames(request),
  );
  const body = standardBody(request, processed, { reasoning_effort: request.reasoning_effort });
  if (isRecord(request.json_schema)) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { schema: request.json_schema.value },
    };
  }
  return body;
}

function jsonSchemaOpenAiBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const body = standardBody(request, messages);
  if (isRecord(request.json_schema)) {
    body.response_format = schemaResponse(request.json_schema, true);
  }
  return body;
}

function nanoGptBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const body = standardBody(request, messages, {
    min_p: request.min_p,
    top_a: request.top_a,
    repetition_penalty: request.repetition_penalty,
    billing_mode: request.nanogpt_payg_override ? 'paygo' : undefined,
  });
  const model = String(request.model ?? '');
  if (request.enable_web_search && !/:online$/u.test(model)) body.model = `${model}:online`;
  if (request.reasoning_effort) {
    body.reasoning = {
      effort: NANOGPT_REASONING_EFFORT_MAP[String(request.reasoning_effort)],
    };
  }
  const config = getUpstreamGenerationConfig();
  if (config.claude.enableSystemPromptCache && /(?:^|\/)claude[-_]/u.test(model)) {
    body.cache_control = {
      enabled: true,
      ttl: config.claude.extendedTTL ? '1h' : '5m',
    };
  }
  return body;
}

function pollinationsBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const body = standardBody(request, messages, {
    reasoning_effort: request.reasoning_effort,
    seed: request.seed ?? Math.floor(Math.random() * 99_999_999),
  });
  if (isRecord(request.json_schema)) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { schema: request.json_schema.value },
    };
  }
  return body;
}

function moonshotBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const body = standardBody(request, messages, {
    thinking: { type: request.include_reasoning ? 'enabled' : 'disabled' },
  });
  if (isRecord(request.json_schema)) setJsonObjectFormat(body, messages, request.json_schema);
  else addAssistantPrefix(messages, [], 'partial');
  return body;
}

function zaiBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const body = standardBody(request, messages, {
    thinking: { type: request.include_reasoning ? 'enabled' : 'disabled' },
  });
  if (isRecord(request.json_schema)) setJsonObjectFormat(body, messages, request.json_schema);
  return body;
}

function siliconFlowBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const body = standardBody(request, messages);
  if (isRecord(request.json_schema)) setJsonObjectFormat(body, messages, request.json_schema);
  return body;
}

function workersAiBody(
  request: LegacyGenerationRequest,
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const body = standardBody(request, messages, {
    repetition_penalty: request.repetition_penalty,
  });
  if (isRecord(request.json_schema)) {
    body.response_format = { type: 'json_schema', json_schema: request.json_schema.value };
  }
  return body;
}

function generationUrl(context: ProviderAdapterContext): URL {
  const request = context.request;
  const source = context.descriptor.source;
  if (source === 'azure_openai') {
    const base = requiredUrl(request.azure_base_url, 'Azure base URL');
    const deployment = requiredString(request.azure_deployment_name, 'Azure deployment name');
    const version = requiredString(request.azure_api_version, 'Azure API version');
    const url = new URL(
      `/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`,
      base,
    );
    url.searchParams.set('api-version', version);
    return url;
  }
  if (source === 'workers_ai') {
    const account = requiredString(request.workers_ai_account_id, 'Workers AI Account ID');
    return new URL(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/v1/chat/completions`,
    );
  }
  let base = trimTrailingSlash(resolveProviderBaseUrl(context.descriptor, request));
  if (
    source === 'deepseek' &&
    !(typeof request.reverse_proxy === 'string' && request.reverse_proxy.trim())
  ) {
    base = `${base}/beta`;
  }
  if (base.endsWith('/chat/completions')) return new URL(base);
  return new URL(`${base}/chat/completions`);
}

function modelsUrl(context: ProviderAdapterContext): URL {
  const request = context.request;
  const source = context.descriptor.source;
  if (source === 'workers_ai') {
    const account = requiredString(request.workers_ai_account_id, 'Workers AI Account ID');
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/models/search`,
    );
    url.searchParams.set('task', 'Text Generation');
    url.searchParams.set('per_page', '1000');
    return url;
  }
  if (source === 'pollinations') return new URL('https://gen.pollinations.ai/text/models');
  const base = trimTrailingSlash(resolveProviderBaseUrl(context.descriptor, request));
  const url = new URL(
    base.endsWith('/chat/completions')
      ? base.replace(/\/chat\/completions$/u, '/models')
      : `${base}/models`,
  );
  if (source === 'nanogpt') url.searchParams.set('detailed', 'true');
  if (source === 'siliconflow') {
    url.searchParams.set('type', 'text');
    url.searchParams.set('sub_type', 'chat');
  }
  return url;
}

async function isOpenRouterModelCacheable(
  context: ProviderAdapterContext,
  modelId: string,
): Promise<boolean> {
  if (openRouterCacheableModels.has(modelId)) return true;
  try {
    const response = await context.client.send(
      'openrouter',
      new URL('https://openrouter.ai/api/v1/models'),
      { method: 'GET', headers: { Accept: 'application/json' }, signal: context.signal ?? null },
    );
    if (!response.ok) return false;
    const data = (await response.json()) as unknown;
    if (!isRecord(data) || !Array.isArray(data.data)) return false;
    const model = data.data.find((item) => isRecord(item) && item.id === modelId);
    const supported =
      isRecord(model) && isRecord(model.pricing) && model.pricing.input_cache_write != null;
    if (supported) openRouterCacheableModels.add(modelId);
    return supported;
  } catch {
    return false;
  }
}

function applyOpenAiLogprobs(
  body: Record<string, unknown>,
  request: LegacyGenerationRequest,
): void {
  if (typeof request.logprobs === 'number' && request.logprobs > 0) {
    body.top_logprobs = request.logprobs;
    body.logprobs = true;
  }
}

function copyTools(body: Record<string, unknown>, request: LegacyGenerationRequest): void {
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    body.tools = structuredClone(request.tools);
    body.tool_choice = request.tool_choice;
  }
}

function schemaResponse(
  schema: Record<string, unknown>,
  includeDescription = false,
): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: schema.name,
      ...(includeDescription ? { description: schema.description } : {}),
      strict: schema.strict ?? true,
      schema: schema.value,
    },
  };
}

function setJsonObjectFormat(
  body: Record<string, unknown>,
  messages: Array<Record<string, unknown>>,
  schema: Record<string, unknown>,
): void {
  body.response_format = { type: 'json_object' };
  appendJsonSchemaPrompt(messages, schema);
}

function appendJsonSchemaPrompt(
  messages: Array<Record<string, unknown>>,
  schema: Record<string, unknown>,
): void {
  messages.push({
    role: 'user',
    content: `JSON schema for the response:\n${JSON.stringify(schema.value, null, 4)}`,
  });
}

function promptNames(request: Record<string, unknown>) {
  const groupNames = Array.isArray(request.group_names) ? request.group_names.map(String) : [];
  return {
    charName: String(request.char_name ?? ''),
    userName: String(request.user_name ?? ''),
    groupNames,
    startsWithGroupName(message: string) {
      return groupNames.some((name) => message.startsWith(`${name}: `));
    },
  };
}

function cloneMessages(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new GenerationProviderError(
      'invalid-request',
      'Chat completion messages are required.',
      400,
    );
  }
  return structuredClone(value) as Array<Record<string, unknown>>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GenerationProviderError('invalid-request', `${label} is required.`, 400);
  }
  return value.trim();
}

function requiredUrl(value: unknown, label: string): URL {
  const string = requiredString(value, label);
  try {
    return new URL(string);
  } catch (error) {
    throw new GenerationProviderError('invalid-endpoint', `${label} is invalid.`, 400, {
      cause: error,
    });
  }
}
