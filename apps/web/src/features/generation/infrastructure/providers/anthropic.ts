import type { ModelCatalogResult } from '../../domain/provider';
import { joinProviderUrl, resolveProviderBaseUrl } from '../provider-url';
import {
  compactObject,
  getRequest,
  messageText,
  normalizeModels,
  parseJson,
  readMessages,
  readModel,
  requestInit,
  requireOk,
} from './adapter-utils';
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
      getRequest(context.signal, this.#headers(context)),
    );
    const data = await parseJson(response);
    return { data: normalizeModels(data.data) };
  }

  async generate(context: ProviderAdapterContext): Promise<Response> {
    const messages = readMessages(context.request);
    const system = messages
      .filter((message) => message.role === 'system')
      .map(messageText)
      .join('\n\n');
    const converted = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: messageText(message),
      }));
    const tools = Array.isArray(context.request.tools)
      ? context.request.tools
          .filter((tool) => tool && typeof tool === 'object')
          .map((tool) => (tool as { function?: Record<string, unknown> }).function)
          .filter(Boolean)
          .map((tool) => ({
            name: tool!.name,
            description: tool!.description,
            input_schema: tool!.parameters,
          }))
      : undefined;
    const body = compactObject({
      model: readModel(context.request),
      system: system || undefined,
      messages: converted,
      max_tokens: context.request.max_tokens ?? context.request.max_completion_tokens ?? 1024,
      temperature: context.request.temperature,
      top_p: context.request.top_p,
      top_k: context.request.top_k,
      stop_sequences: context.request.stop,
      stream: context.request.stream,
      tools,
    });
    const url = joinProviderUrl(
      resolveProviderBaseUrl(context.descriptor, context.request),
      '/messages',
    );
    const response = await context.client.send(
      context.descriptor.source,
      url,
      requestInit(this.#headers(context), body, context.signal),
    );
    return requireOk(response);
  }

  #headers(context: ProviderAdapterContext): HeadersInit {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': context.credential ?? '',
    };
  }
}
