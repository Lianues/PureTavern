import type { LegacyGenerationRequest, ModelCatalogResult } from '../domain/provider';

export interface ModelCatalogGateway {
  listModels(request: LegacyGenerationRequest, signal?: AbortSignal): Promise<ModelCatalogResult>;
}
