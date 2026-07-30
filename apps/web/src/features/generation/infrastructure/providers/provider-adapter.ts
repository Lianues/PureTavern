import type {
  LegacyGenerationRequest,
  ModelCatalogResult,
  ProviderDescriptor,
} from '../../domain/provider';
import type { ProviderHttpClient } from '../../ports/provider-http-client';

export interface ProviderAdapterContext {
  descriptor: ProviderDescriptor;
  request: LegacyGenerationRequest;
  credential: string | null;
  resolveCredential(key: string): Promise<string | null>;
  client: ProviderHttpClient;
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  listModels(context: ProviderAdapterContext): Promise<ModelCatalogResult>;
  generate(context: ProviderAdapterContext): Promise<Response>;
}
