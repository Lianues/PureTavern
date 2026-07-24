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

export class CohereAdapter implements ProviderAdapter {
  async listModels(context: ProviderAdapterContext): Promise<ModelCatalogResult> {
    const url = joinProviderUrl(
      resolveProviderBaseUrl(context.descriptor, context.request),
      '/v1/models',
    );
    const response = await context.client.send(
      context.descriptor.source,
      url,
      getRequest(context.signal, this.#headers(context)),
    );
    const data = await parseJson(response);
    return { data: normalizeModels(data.models) };
  }

  async generate(context: ProviderAdapterContext): Promise<Response> {
    const body = compactObject({
      model: readModel(context.request),
      messages: readMessages(context.request).map((message) => ({
        role: typeof message.role === 'string' ? message.role : 'user',
        content: messageText(message),
      })),
      stream: context.request.stream,
      temperature: context.request.temperature,
      p: context.request.top_p,
      k: context.request.top_k,
      max_tokens: context.request.max_tokens ?? context.request.max_completion_tokens,
      stop_sequences: context.request.stop,
      seed: context.request.seed,
      tools: context.request.tools,
    });
    const url = joinProviderUrl(
      resolveProviderBaseUrl(context.descriptor, context.request),
      '/v2/chat',
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
      Authorization: `Bearer ${context.credential ?? ''}`,
    };
  }
}
