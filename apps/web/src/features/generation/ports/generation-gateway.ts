import type { LegacyGenerationRequest } from '../domain/provider';

export interface GenerationGateway {
  generate(request: LegacyGenerationRequest, signal?: AbortSignal): Promise<Response>;
}
