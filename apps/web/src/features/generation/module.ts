import type { FeatureModule } from '@/platform/features/feature-module';
import {
  credentialResolverCapability,
  generationProviderCapability,
  type GenerationProviderCapability,
} from '@/platform/features/standard-capabilities';

import { GenerationService } from './application/generation-service';
import { DirectFetchClient } from './infrastructure/direct-fetch-client';
import { registerGenerationLegacyRoutes } from './legacy/register-routes';
import { BrowserStreamingGeneration } from './ports/streaming-generation';

export const generationFeature: FeatureModule = {
  id: 'generation',
  install({ router, nativeFetch, capabilities }) {
    const credentials = capabilities.get(credentialResolverCapability);
    if (!credentials) throw new Error('Generation requires the M14 CredentialResolver capability.');

    const client = new DirectFetchClient(nativeFetch);
    const service = new GenerationService(credentials, client, new BrowserStreamingGeneration());
    const capability: GenerationProviderCapability = {
      listSources: () => service.listSources().map((descriptor) => descriptor.source),
      listModels: (request, signal) => service.listModels(request, signal),
      generate: (request, signal) => service.generate(request, signal),
    };
    capabilities.register(generationProviderCapability, capability);
    registerGenerationLegacyRoutes(router, service);

    return {
      diagnostics: {
        service: service.diagnostics,
        transport: client.diagnostics,
        scope: 'chat-completion-only',
        directBrowserRequests: true,
        optionalBackend: false,
        providerSources: service.listSources().map((descriptor) => descriptor.source),
      },
    };
  },
};
