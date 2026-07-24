import type { FeatureModule } from '@/platform/features/feature-module';
import {
  tokenizerCapability,
  type TokenizerCapability,
} from '@/platform/features/standard-capabilities';

import { TokenizerService } from './application/tokenizer-service';
import { TokenizerWorkerClient } from './infrastructure/tokenizer-worker-client';
import { registerTokenizerLegacyRoutes } from './legacy/register-routes';

export const tokenizersFeature: FeatureModule = {
  id: 'tokenizers',
  install({ router, capabilities }) {
    const worker = TokenizerWorkerClient.createBrowser();
    const service = new TokenizerService({ primary: worker });
    const capability: TokenizerCapability = {
      id: 'tokenx',
      precision: 'approximate',
      async countText(text) {
        return (await service.countText(text)).count;
      },
      async countMessages(messages) {
        return (await service.countMessages(messages)).count;
      },
    };
    capabilities.register(tokenizerCapability, capability);
    registerTokenizerLegacyRoutes(router, service);

    return {
      diagnostics: {
        engine: service.diagnostics,
        workerRequested: Boolean(worker),
        semantics: 'unified-approximate-tokenx',
        modelSpecific: false,
        pseudoTokenIds: true,
      },
    };
  },
};
