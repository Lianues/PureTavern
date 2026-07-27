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
      getRequest(context.signal, this.#headers(context, false)),
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
      requestInit(this.#headers(context, true), body, context.signal),
    );
    return requireOk(response);
  }

  #headers(context: ProviderAdapterContext, generation: boolean): HeadersInit {
    const headers: Record<string, string> = {
      'anthropic-version': '2023-06-01',
      'x-api-key': context.credential ?? '',
    };
    if (!generation) return headers;
    headers['Content-Type'] = 'application/json';

    // SillyTavern 1.18.0 starts every Claude generation with these beta capabilities.
    const betaHeaders = ['output-128k-2025-02-19', 'context-1m-2025-08-07'];
    if (Array.isArray(context.request.tools) && context.request.tools.length > 0) {
      betaHeaders.push('tools-2024-05-16');
    }
    const model = typeof context.request.model === 'string' ? context.request.model : '';
    if (
      context.request.verbosity &&
      /^claude-(opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)/u.test(model)
    ) {
      betaHeaders.push('effort-2025-11-24');
    }
    headers['anthropic-beta'] = betaHeaders.join(',');
    return headers;
  }
}
