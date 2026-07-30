import { convertCohereMessages } from '../../compatibility/upstream-prompt-converters';
import { isRecord } from '../../compatibility/upstream-utils';
import { GenerationProviderError, type ModelCatalogResult } from '../../domain/provider';
import { joinProviderUrl, resolveProviderBaseUrl } from '../provider-url';
import { normalizeModels, parseJson, requestInit, requireOk } from './adapter-utils';
import type { ProviderAdapter, ProviderAdapterContext } from './provider-adapter';

export class CohereAdapter implements ProviderAdapter {
  async listModels(context: ProviderAdapterContext): Promise<ModelCatalogResult> {
    const url = joinProviderUrl(
      resolveProviderBaseUrl(context.descriptor, context.request),
      '/v1/models',
    );
    const response = await context.client.send(context.descriptor.source, url, {
      method: 'GET',
      headers: this.#headers(context, false),
      signal: context.signal ?? null,
    });
    const data = await parseJson(response);
    return { data: normalizeModels(data.models) };
  }

  async generate(context: ProviderAdapterContext): Promise<Response> {
    const request = context.request;
    if (!Array.isArray(request.messages)) {
      throw new GenerationProviderError(
        'invalid-request',
        'Chat completion messages are required.',
        400,
      );
    }
    const converted = convertCohereMessages(
      structuredClone(request.messages),
      promptNames(request),
    ) as { chatHistory: Array<Record<string, unknown>> };
    const tools = Array.isArray(request.tools)
      ? structuredClone(request.tools).map((tool) => {
          if (isRecord(tool) && isRecord(tool.function) && isRecord(tool.function.parameters)) {
            delete tool.function.parameters.$schema;
          }
          return tool;
        })
      : [];
    const body: Record<string, unknown> = {
      stream: Boolean(request.stream),
      model: request.model,
      messages: converted.chatHistory,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      k: request.top_k,
      p: request.top_p,
      seed: request.seed,
      stop_sequences: request.stop,
      frequency_penalty: request.frequency_penalty,
      presence_penalty: request.presence_penalty,
      documents: [],
      tools,
    };
    if (String(request.model).endsWith('08-2024')) body.safety_mode = 'OFF';
    if (isRecord(request.json_schema)) {
      body.response_format = {
        type: 'json_schema',
        schema: request.json_schema.value,
      };
    }
    const url = joinProviderUrl(resolveProviderBaseUrl(context.descriptor, request), '/v2/chat');
    const response = await context.client.send(
      context.descriptor.source,
      url,
      requestInit(this.#headers(context, true), body, context.signal),
    );
    if (request.stream === true) return response;
    return requireOk(response);
  }

  #headers(context: ProviderAdapterContext, contentType: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${context.credential ?? ''}`,
      ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    };
  }
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
