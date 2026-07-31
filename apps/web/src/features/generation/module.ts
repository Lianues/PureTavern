import type { FeatureModule } from '@/platform/features/feature-module';
import {
  credentialResolverCapability,
  generationProviderCapability,
  type GenerationProviderCapability,
} from '@/platform/features/standard-capabilities';

import { GenerationService } from './application/generation-service';
import { GenerationTransportState } from './application/generation-transport-state';
import { AndroidLocalBackendClient } from './infrastructure/android-local-backend-client';
import { DirectFetchClient } from './infrastructure/direct-fetch-client';
import { RemoteBackendClient } from './infrastructure/remote-backend-client';
import { RoutingFetchClient } from './infrastructure/routing-fetch-client';
import { registerGenerationLegacyRoutes } from './legacy/register-routes';
import { BrowserStreamingGeneration } from './ports/streaming-generation';
import { installGenerationTransportUi } from './runtime/generation-transport-ui';

export const generationFeature: FeatureModule = {
  id: 'generation',
  install({ router, nativeFetch, capabilities }) {
    const credentials = capabilities.get(credentialResolverCapability);
    if (!credentials) throw new Error('Generation requires the M14 CredentialResolver capability.');

    const transportState = new GenerationTransportState();
    const directClient = new DirectFetchClient(nativeFetch);
    const localClient = new AndroidLocalBackendClient();
    const remoteClient = new RemoteBackendClient(nativeFetch, transportState);
    const client = new RoutingFetchClient(transportState, directClient, localClient, remoteClient);
    const service = new GenerationService(credentials, client, new BrowserStreamingGeneration());
    const capability: GenerationProviderCapability = {
      listSources: () => service.listSources().map((descriptor) => descriptor.source),
      listModels: (request, signal) => service.listModels(request, signal),
      generate: (request, signal) => service.generate(request, signal),
    };
    capabilities.register(generationProviderCapability, capability);
    registerGenerationLegacyRoutes(router, service);
    installGenerationTransportUi(transportState, remoteClient);

    return {
      diagnostics: {
        service: service.diagnostics,
        transport: client.diagnostics,
        scope: 'chat-completion-only',
        directBrowserRequests: true,
        optionalBackend: true,
        transportModes: ['frontend', 'local-android', 'remote'],
        providerSources: service.listSources().map((descriptor) => descriptor.source),
      },
    };
  },
};
