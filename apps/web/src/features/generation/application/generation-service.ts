import type { CredentialResolverCapability } from '@/platform/features/standard-capabilities';

import {
  GenerationProviderError,
  readChatCompletionSource,
  type LegacyGenerationRequest,
  type ModelCatalogResult,
} from '../domain/provider';
import type { GenerationGateway } from '../ports/generation-gateway';
import type { ModelCatalogGateway } from '../ports/model-catalog-gateway';
import type { StreamingGeneration } from '../ports/streaming-generation';
import { DirectFetchClient } from '../infrastructure/direct-fetch-client';
import { AnthropicAdapter } from '../infrastructure/providers/anthropic';
import { CohereAdapter } from '../infrastructure/providers/cohere';
import { GoogleAdapter } from '../infrastructure/providers/google';
import { OpenAiCompatibleAdapter } from '../infrastructure/providers/openai-compatible';
import type {
  ProviderAdapter,
  ProviderAdapterContext,
} from '../infrastructure/providers/provider-adapter';
import { getProviderDescriptor, listProviderDescriptors } from './provider-registry';

export interface GenerationDiagnostics {
  status: 'ready' | 'degraded';
  providerCount: number;
  protocolCount: number;
  generations: number;
  modelCatalogRequests: number;
  biasTextEntriesSkipped: number;
  lastSource: string | null;
  lastErrorCode: string | null;
}

export class GenerationService implements GenerationGateway, ModelCatalogGateway {
  readonly diagnostics: GenerationDiagnostics = {
    status: 'ready',
    providerCount: listProviderDescriptors().length,
    protocolCount: 4,
    generations: 0,
    modelCatalogRequests: 0,
    biasTextEntriesSkipped: 0,
    lastSource: null,
    lastErrorCode: null,
  };

  readonly #credentials: CredentialResolverCapability;
  readonly #client: DirectFetchClient;
  readonly #streaming: StreamingGeneration;
  readonly #adapters: Record<string, ProviderAdapter>;

  constructor(
    credentials: CredentialResolverCapability,
    client: DirectFetchClient,
    streaming: StreamingGeneration,
  ) {
    this.#credentials = credentials;
    this.#client = client;
    this.#streaming = streaming;
    this.#adapters = {
      'openai-compatible': new OpenAiCompatibleAdapter(),
      anthropic: new AnthropicAdapter(),
      google: new GoogleAdapter(),
      cohere: new CohereAdapter(),
    };
  }

  listSources() {
    return listProviderDescriptors();
  }

  async listModels(
    request: LegacyGenerationRequest,
    signal?: AbortSignal,
  ): Promise<ModelCatalogResult> {
    this.diagnostics.modelCatalogRequests += 1;
    return this.#execute(request, signal, (adapter, context) => adapter.listModels(context));
  }

  async generate(request: LegacyGenerationRequest, signal?: AbortSignal): Promise<Response> {
    this.diagnostics.generations += 1;
    const response = await this.#execute(request, signal, (adapter, context) =>
      adapter.generate(context),
    );
    if (request.stream === true) return this.#streaming.forward(response);
    const headers = new Headers();
    headers.set('Content-Type', response.headers.get('Content-Type') ?? 'application/json');
    headers.set('X-Pure-Tavern-Hook', '1');
    headers.set('X-Pure-Tavern-Provider', 'direct');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  createBiasMap(value: unknown): Record<string, number> {
    if (!Array.isArray(value)) {
      throw new GenerationProviderError('invalid-request', 'Bias preset must be an array.', 400);
    }
    const result: Record<string, number> = {};
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as { text?: unknown; value?: unknown };
      if (typeof record.text !== 'string' || typeof record.value !== 'number') continue;
      const ids = parseExplicitTokenIds(record.text);
      if (!ids) {
        this.diagnostics.biasTextEntriesSkipped += 1;
        continue;
      }
      for (const id of ids) result[String(id)] = record.value;
    }
    return result;
  }

  async #execute<T>(
    request: LegacyGenerationRequest,
    signal: AbortSignal | undefined,
    operation: (adapter: ProviderAdapter, context: ProviderAdapterContext) => Promise<T>,
  ): Promise<T> {
    const source = readChatCompletionSource(request.chat_completion_source);
    const descriptor = getProviderDescriptor(source);
    const adapter = this.#adapters[descriptor.protocol];
    if (!adapter) {
      throw new GenerationProviderError(
        'unsupported-source',
        'The provider protocol adapter is unavailable.',
        501,
      );
    }
    this.diagnostics.lastSource = source;
    try {
      const credential = await this.#resolveCredential(
        descriptor.secretKey,
        descriptor.keyOptional,
        descriptor.supportsReverseProxy,
        request,
      );
      const context: ProviderAdapterContext = {
        descriptor,
        request,
        credential,
        client: this.#client,
      };
      if (signal) context.signal = signal;
      return await operation(adapter, context);
    } catch (error) {
      const code = error instanceof GenerationProviderError ? error.code : 'provider-error';
      this.diagnostics.status = code === 'aborted' ? this.diagnostics.status : 'degraded';
      this.diagnostics.lastErrorCode = code;
      throw error;
    }
  }

  async #resolveCredential(
    secretKey: string | null,
    keyOptional: boolean,
    supportsReverseProxy: boolean,
    request: LegacyGenerationRequest,
  ): Promise<string | null> {
    if (
      supportsReverseProxy &&
      typeof request.reverse_proxy === 'string' &&
      request.reverse_proxy.trim() &&
      typeof request.proxy_password === 'string' &&
      request.proxy_password
    ) {
      return request.proxy_password;
    }
    if (!secretKey) return null;
    const id =
      typeof request.secret_id === 'string' && request.secret_id ? request.secret_id : undefined;
    const credential = await this.#credentials.resolveCredential(secretKey, id);
    if (credential === null && !keyOptional) {
      throw new GenerationProviderError(
        'missing-credential',
        'The selected provider credential is missing.',
        400,
      );
    }
    return credential;
  }
}

function parseExplicitTokenIds(value: string): number[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) && parsed.every((id) => Number.isSafeInteger(id) && id >= 0)
      ? parsed
      : null;
  } catch {
    return null;
  }
}
