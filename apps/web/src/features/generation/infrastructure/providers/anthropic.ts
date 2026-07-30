import {
  calculateClaudeBudgetTokens,
  cachingAtDepthForClaude,
  convertClaudeMessages,
} from '../../compatibility/upstream-prompt-converters';
import { getUpstreamGenerationConfig } from '../../compatibility/upstream-config';
import { flattenSchema, isRecord } from '../../compatibility/upstream-utils';
import { GenerationProviderError, type ModelCatalogResult } from '../../domain/provider';
import { joinProviderUrl, resolveProviderBaseUrl } from '../provider-url';
import { getRequest, normalizeModels, parseJson, requestInit, requireOk } from './adapter-utils';
import type { ProviderAdapter, ProviderAdapterContext } from './provider-adapter';

export class AnthropicAdapter implements ProviderAdapter {
  async listModels(context: ProviderAdapterContext): Promise<ModelCatalogResult> {
    const url = joinProviderUrl(
      resolveProviderBaseUrl(context.descriptor, context.request),
      '/models',
    );
    const response = await context.client.send(
      context.descriptor.source,
      url,
      getRequest(context.signal, this.#baseHeaders(context)),
    );
    const data = await parseJson(response);
    return { data: normalizeModels(data.data) };
  }

  async generate(context: ProviderAdapterContext): Promise<Response> {
    const request = context.request;
    if (!context.credential) {
      throw new GenerationProviderError('missing-credential', 'Claude API key is missing.', 400);
    }
    const config = getUpstreamGenerationConfig();
    const messages = cloneMessages(request.messages);
    const tools = Array.isArray(request.tools) ? structuredClone(request.tools) : [];
    const useTools = tools.length > 0;
    const useSystemPrompt = Boolean(request.use_sysprompt);
    const converted = convertClaudeMessages(
      messages,
      typeof request.assistant_prefill === 'string' ? request.assistant_prefill : '',
      useSystemPrompt,
      useTools,
      promptNames(request),
    ) as { messages: Array<Record<string, unknown>>; systemPrompt: Array<Record<string, unknown>> };
    const model = requiredString(request.model, 'Model');
    const useThinking =
      /^claude-(3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)/u.test(model);
    const useWebSearch =
      /^claude-(3-5|3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)/u.test(
        model,
      ) && Boolean(request.enable_web_search);
    const limitedSampling =
      /^claude-(opus-4-1|sonnet-4-5|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6)/u.test(model);
    const useVerbosity = /^claude-(opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)/u.test(model);
    const noPrefill = /^claude-(opus-4-6|sonnet-4-6|opus-4-7)/u.test(model);
    const adaptiveModel =
      /^claude-opus-4-7/u.test(model) ||
      (config.claude.enableAdaptiveThinking && /^claude-(opus-4-6|sonnet-4-6)/u.test(model));
    const noSampling = /^claude-opus-4-7/u.test(model);
    const betaHeaders = ['output-128k-2025-02-19', 'context-1m-2025-08-07'];
    const stop = Array.isArray(request.stop) ? structuredClone(request.stop) : [];
    const body: Record<string, unknown> = {
      system: [],
      messages: converted.messages,
      model,
      max_tokens: request.max_tokens,
      stop_sequences: stop,
      temperature: request.temperature,
      top_p: request.top_p,
      top_k: request.top_k,
      stream: request.stream,
    };

    if (useSystemPrompt) {
      if (config.claude.enableSystemPromptCache && converted.systemPrompt.length > 0) {
        converted.systemPrompt.at(-1)!.cache_control = {
          type: 'ephemeral',
          ttl: config.claude.extendedTTL ? '1h' : '5m',
        };
      }
      body.system = converted.systemPrompt;
    } else {
      delete body.system;
    }

    if (useTools) {
      betaHeaders.push('tools-2024-05-16');
      body.tool_choice = { type: request.tool_choice };
      body.tools = tools
        .filter((tool) => isRecord(tool) && tool.type === 'function' && isRecord(tool.function))
        .map((tool) => tool.function as Record<string, unknown>)
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: flattenSchema(tool.parameters, 'claude'),
        }));
      const convertedTools = body.tools as Array<Record<string, unknown>>;
      if (config.claude.enableSystemPromptCache && convertedTools.length > 0) {
        convertedTools.at(-1)!.cache_control = {
          type: 'ephemeral',
          ttl: config.claude.extendedTTL ? '1h' : '5m',
        };
      }
    }

    if (isRecord(request.json_schema)) {
      const schema = request.json_schema;
      const jsonTool = {
        name: schema.name,
        description:
          typeof schema.description === 'string' && schema.description
            ? schema.description
            : 'Well-formed JSON object',
        input_schema: schema.value,
      };
      body.tools = [...(Array.isArray(body.tools) ? body.tools : []), jsonTool];
      body.tool_choice = { type: 'tool', name: schema.name };
    }

    if (useWebSearch) {
      body.tools = [
        { type: 'web_search_20250305', name: 'web_search' },
        ...(Array.isArray(body.tools) ? body.tools : []),
      ];
    }

    const ttl = config.claude.extendedTTL ? '1h' : '5m';
    if (config.claude.cachingAtDepth >= 0) {
      cachingAtDepthForClaude(converted.messages, config.claude.cachingAtDepth, ttl);
    }
    if (config.claude.enableSystemPromptCache || config.claude.cachingAtDepth >= 0) {
      betaHeaders.push('prompt-caching-2024-07-31', 'extended-cache-ttl-2025-04-11');
    }

    if (limitedSampling) {
      if (typeof body.top_p === 'number' && body.top_p < 1) delete body.temperature;
      else delete body.top_p;
    }
    if (noSampling) {
      delete body.temperature;
      delete body.top_p;
      delete body.top_k;
    }

    let fixThinkingPrefill = false;
    const budget = calculateClaudeBudgetTokens(
      Number(body.max_tokens),
      request.reasoning_effort,
      Boolean(body.stream),
      adaptiveModel,
    ) as number | string | null;
    if (useThinking && typeof budget === 'string') {
      fixThinkingPrefill = true;
      body.thinking = {
        type: 'adaptive',
        ...(noSampling && request.include_reasoning ? { display: 'summarized' } : {}),
      };
      body.output_config = { effort: budget };
      delete body.top_k;
    } else if (useThinking && Number.isInteger(budget)) {
      fixThinkingPrefill = true;
      const numericBudget = Number(budget);
      if (Number(body.max_tokens) <= 1024) body.max_tokens = Number(body.max_tokens) + 1024;
      body.thinking = { type: 'enabled', budget_tokens: numericBudget };
      delete body.temperature;
      delete body.top_p;
      delete body.top_k;
    }

    if ((fixThinkingPrefill || noPrefill) && converted.messages.at(-1)?.role === 'assistant') {
      converted.messages.at(-1)!.role = 'user';
    }
    if (useVerbosity && request.verbosity && !isRecord(body.output_config)) {
      betaHeaders.push('effort-2025-11-24');
      body.output_config = { effort: request.verbosity };
    }

    const url = joinProviderUrl(resolveProviderBaseUrl(context.descriptor, request), '/messages');
    const response = await context.client.send(
      context.descriptor.source,
      url,
      requestInit(
        {
          ...this.#baseHeaders(context),
          'Content-Type': 'application/json',
          'anthropic-beta': betaHeaders.join(','),
        },
        body,
        context.signal,
      ),
    );
    if (request.stream === true) return response;
    await requireOk(response);

    const data = (await response.json()) as unknown;
    if (!isRecord(data)) {
      throw new GenerationProviderError('invalid-response', 'Claude returned invalid JSON.', 502);
    }
    const content = Array.isArray(data.content) ? data.content : [];
    const first = content[0];
    return responseWithJson(response, {
      choices: [
        {
          message: {
            content: isRecord(first) && typeof first.text === 'string' ? first.text : '',
          },
        },
      ],
      content,
    });
  }

  #baseHeaders(context: ProviderAdapterContext): Record<string, string> {
    return {
      'anthropic-version': '2023-06-01',
      'x-api-key': context.credential ?? '',
    };
  }
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

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GenerationProviderError('invalid-request', `${label} is required.`, 400);
  }
  return value;
}

function responseWithJson(upstream: Response, data: unknown): Response {
  const headers = new Headers(upstream.headers);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
