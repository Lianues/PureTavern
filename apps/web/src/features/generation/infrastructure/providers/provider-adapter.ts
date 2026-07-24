import type {
  LegacyGenerationRequest,
  ModelCatalogResult,
  ProviderDescriptor,
} from '../../domain/provider';
import type { DirectFetchClient } from '../direct-fetch-client';

export interface ProviderAdapterContext {
  descriptor: ProviderDescriptor;
  request: LegacyGenerationRequest;
  credential: string | null;
  client: DirectFetchClient;
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  listModels(context: ProviderAdapterContext): Promise<ModelCatalogResult>;
  generate(context: ProviderAdapterContext): Promise<Response>;
}
