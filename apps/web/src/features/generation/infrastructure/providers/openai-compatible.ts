import { parse as parseYaml } from 'yaml';

import {
  GenerationProviderError,
  type LegacyGenerationRequest,
  type ModelCatalogResult,
} from '../../domain/provider';
import { joinProviderUrl, resolveProviderBaseUrl } from '../provider-url';
import {
  compactObject,
  getRequest,
  normalizeModels,
  readMessages,
  readModel,
  requestInit,
  requireOk,
} from './adapter-utils';
import type { ProviderAdapter, ProviderAdapterContext } from './provider-adapter';

const BODY_KEYS = [
  'temperature',
  'max_tokens',
  'max_completion_tokens',
  'stream',
  'presence_penalty',
  'frequency_penalty',
  'top_p',
  'top_k',
  'stop',
  'logit_bias',
  'seed',
  'n',
  'tools',
  'tool_choice',
  'response_format',
  'reasoning_effort',
  'verbosity',
  'parallel_tool_calls',
  'logprobs',
  'top_logprobs',
] as const;

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  async listModels(context: ProviderAdapterContext): Promise<ModelCatalogResult> {
    if (context.descriptor.source === 'azure_openai') {
      const deployment = requiredSetting(
        context.request.azure_deployment_name,
        'Azure deployment name',
      );
      return { data: [{ id: deployment }] };
    }

    const base = resolveProviderBaseUrl(context.descriptor, context.request);
    const url = modelsUrl(context, base);
    const response = await context.client.send(
      context.descriptor.source,
      url,
      getRequest(context.signal, this.#headers(context)),
    );
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
    const source = context.descriptor.source;
    if (source === 'pollinations' && Array.isArray(data)) {
      return { data: normalizeModels(data) };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new GenerationProviderError(
        'invalid-response',
        'The provider model response is invalid.',
        502,
      );
    }
    const record = data as Record<string, unknown>;
    const models =
      source === 'workers_ai'
        ? normalizeModels(record.result)
        : normalizeModels(record.data ?? record.models ?? record);
    return { data: models };
  }

  async generate(context: ProviderAdapterContext): Promise<Response> {
    const base = resolveProviderBaseUrl(context.descriptor, context.request);
    const url = generationUrl(context, base);
    const body = buildOpenAiBody(context.request);
    const response = await context.client.send(
      context.descriptor.source,
      url,
      requestInit(this.#headers(context), body, context.signal),
    );
    return requireOk(response);
  }

  #headers(context: ProviderAdapterContext): HeadersInit {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (context.descriptor.source === 'azure_openai') {
      if (context.credential) headers['api-key'] = context.credential;
    } else if (context.credential) {
      headers.Authorization = `Bearer ${context.credential}`;
    }
    if (context.descriptor.source === 'openrouter') {
      headers['HTTP-Referer'] = window.location.origin;
      headers['X-Title'] = 'PureTavern';
    }
    if (context.descriptor.source === 'zai') headers['Accept-Language'] = 'en-US,en';
    if (context.descriptor.source === 'custom') {
      Object.assign(headers, parseCustomHeaders(context.request.custom_include_headers));
    }
    return headers;
  }
}

function buildOpenAiBody(request: LegacyGenerationRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages: readMessages(request),
    model: readModel(request),
  };
  for (const key of BODY_KEYS) body[key] = request[key];
  if (request.json_schema && !body.response_format) {
    body.response_format = {
      type: 'json_schema',
      json_schema: request.json_schema,
    };
  }
  if (request.chat_completion_source === 'workers_ai') {
    body.repetition_penalty = request.repetition_penalty;
  }
  if (request.chat_completion_source === 'moonshot' || request.chat_completion_source === 'zai') {
    body.thinking = { type: request.include_reasoning ? 'enabled' : 'disabled' };
  }
  if (request.chat_completion_source === 'custom') {
    Object.assign(body, parseCustomBody(request.custom_include_body));
    for (const key of parseCustomExclusions(request.custom_exclude_body)) {
      delete body[key];
    }
  }
  return compactObject(body);
}

function generationUrl(context: ProviderAdapterContext, base: URL): URL {
  if (context.descriptor.source === 'azure_openai') {
    const deployment = requiredSetting(
      context.request.azure_deployment_name,
      'Azure deployment name',
    );
    const version = requiredSetting(context.request.azure_api_version, 'Azure API version');
    const url = joinProviderUrl(
      base,
      `/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`,
    );
    url.searchParams.set('api-version', version);
    return url;
  }
  if (context.descriptor.source === 'workers_ai') {
    const account = requiredSetting(context.request.workers_ai_account_id, 'Workers AI account ID');
    return joinProviderUrl(base, `/${encodeURIComponent(account)}/ai/v1/chat/completions`);
  }
  if (base.pathname.endsWith('/chat/completions')) return base;
  return joinProviderUrl(base, '/chat/completions');
}

function modelsUrl(context: ProviderAdapterContext, base: URL): URL {
  if (context.descriptor.source === 'workers_ai') {
    const account = requiredSetting(context.request.workers_ai_account_id, 'Workers AI account ID');
    const url = joinProviderUrl(base, `/${encodeURIComponent(account)}/ai/models/search`);
    url.searchParams.set('task', 'Text Generation');
    url.searchParams.set('per_page', '1000');
    return url;
  }
  if (base.pathname.endsWith('/chat/completions')) {
    const url = new URL(base);
    url.pathname = url.pathname.replace(/\/chat\/completions$/u, '/models');
    return url;
  }
  return joinProviderUrl(base, '/models');
}

function requiredSetting(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GenerationProviderError('invalid-request', `${label} is required.`, 400);
  }
  return value.trim();
}

function parseCustomHeaders(value: unknown): Record<string, string> {
  const parsed = parseCustomMerge(value);
  return Object.fromEntries(
    Object.entries(parsed)
      .filter(([, header]) => typeof header === 'string')
      .map(([key, header]) => [key, header as string]),
  );
}

function parseCustomBody(value: unknown): Record<string, unknown> {
  const parsed = parseCustomMerge(value);
  for (const key of [
    'chat_completion_source',
    'custom_url',
    'proxy_password',
    'reverse_proxy',
    'secret_id',
  ]) {
    delete parsed[key];
  }
  return parsed;
}

function parseCustomExclusions(value: unknown): string[] {
  const parsed = parseCustomYaml(value);
  if (Array.isArray(parsed)) {
    return parsed
      .filter((key): key is string | number => typeof key === 'string' || typeof key === 'number')
      .map(String);
  }
  if (isRecord(parsed)) return Object.keys(parsed);
  return typeof parsed === 'string' && parsed ? [parsed] : [];
}

function parseCustomMerge(value: unknown): Record<string, unknown> {
  const parsed = parseCustomYaml(value);
  const result: Record<string, unknown> = {};
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (isRecord(item)) Object.assign(result, item);
    }
  } else if (isRecord(parsed)) {
    Object.assign(result, parsed);
  }
  return result;
}

function parseCustomYaml(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (!value.trim()) return undefined;
  try {
    return parseYaml(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
