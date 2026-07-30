import { GenerationProviderError, type ModelCatalogResult } from '../../domain/provider';
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

export class GoogleAdapter implements ProviderAdapter {
  async listModels(context: ProviderAdapterContext): Promise<ModelCatalogResult> {
    const base = resolveProviderBaseUrl(context.descriptor, context.request);
    const url =
      context.descriptor.source === 'vertexai'
        ? joinProviderUrl(base, '/v1/publishers/google/models')
        : joinProviderUrl(base, '/v1beta/models');
    const authenticationHeaders = this.#authenticate(url, context);
    const response = await context.client.send(
      context.descriptor.source,
      url,
      getRequest(context.signal, authenticationHeaders),
    );
    const data = await parseJson(response);
    return {
      data: normalizeModels(data.models).map((model) => ({
        ...model,
        id: model.id.replace(/^models\//u, ''),
      })),
    };
  }

  async generate(context: ProviderAdapterContext): Promise<Response> {
    if (context.descriptor.source === 'vertexai' && context.request.vertexai_auth_mode === 'full') {
      throw new GenerationProviderError(
        'unsupported-capability',
        'Vertex AI service-account authentication requires a CORS-capable token bridge and is not enabled.',
        501,
      );
    }
    const messages = readMessages(context.request);
    const systemText = messages
      .filter((message) => message.role === 'system')
      .map(messageText)
      .join('\n\n');
    const contents = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: messageText(message) }],
      }));
    const body = compactObject({
      systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
      contents,
      generationConfig: compactObject({
        maxOutputTokens: context.request.max_tokens ?? context.request.max_completion_tokens,
        temperature: context.request.temperature,
        topP: context.request.top_p,
        topK: context.request.top_k,
        stopSequences: context.request.stop,
        candidateCount: context.request.n,
      }),
    });
    const base = resolveProviderBaseUrl(context.descriptor, context.request);
    const model = readModel(context.request).replace(/^models\//u, '');
    const operation = context.request.stream ? 'streamGenerateContent' : 'generateContent';
    const prefix =
      context.descriptor.source === 'vertexai' ? '/v1/publishers/google/models' : '/v1beta/models';
    const url = joinProviderUrl(base, `${prefix}/${encodeURIComponent(model)}:${operation}`);
    if (context.request.stream) url.searchParams.set('alt', 'sse');
    const authenticationHeaders = this.#authenticate(url, context);
    const response = await context.client.send(
      context.descriptor.source,
      url,
      requestInit(
        { 'Content-Type': 'application/json', ...authenticationHeaders },
        body,
        context.signal,
      ),
    );
    return requireOk(response);
  }

  #authenticate(url: URL, context: ProviderAdapterContext): Record<string, string> {
    const usesVertexProxy =
      context.descriptor.source === 'vertexai' &&
      typeof context.request.reverse_proxy === 'string' &&
      Boolean(context.request.reverse_proxy.trim());
    if (usesVertexProxy) {
      return context.credential ? { Authorization: `Bearer ${context.credential}` } : {};
    }
    if (context.credential) url.searchParams.set('key', context.credential);
    return {};
  }
}
