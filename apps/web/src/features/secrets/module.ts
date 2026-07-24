import type { FeatureModule } from '@/platform/features/feature-module';
import {
  credentialResolverCapability,
  type CredentialResolverCapability,
} from '@/platform/features/standard-capabilities';

import { SecretService } from './application/secret-service';
import { IndexedDbSecretStore } from './infrastructure/indexeddb-secret-store';
import { ResilientSecretStore } from './infrastructure/resilient-secret-store';
import { registerSecretsLegacyRoutes } from './legacy/register-routes';

export const secretsFeature: FeatureModule = {
  id: 'secrets',
  install({ router, records, capabilities }) {
    const store = new ResilientSecretStore(new IndexedDbSecretStore(records));
    const service = new SecretService(store);
    const resolver: CredentialResolverCapability = {
      resolveCredential: (key, id) => service.resolveCredential(key, id),
      hasCredential: (key) => service.hasCredential(key),
    };

    capabilities.register(credentialResolverCapability, resolver);
    registerSecretsLegacyRoutes(router, service);

    return {
      diagnostics: {
        storage: store.diagnostics,
        security: {
          atRest: 'plaintext',
          encrypted: false,
          keyExposureAllowed: true,
          sameOriginSecurityBoundary: false,
        },
      },
    };
  },
};
