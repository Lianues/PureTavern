import type { FeatureModule } from '@/platform/features/feature-module';
import { registerArchiveModule } from '@/platform/features/register-archive-module';
import {
  assetServiceWorkerCapability,
  characterIdentityCapability,
  chatOwnerLifecycleCapability,
} from '@/platform/features/standard-capabilities';

import { CharacterService } from './application/character-service';
import { IndexedDbCharacterAssetRepository } from './infrastructure/indexeddb-character-asset-repository';
import { IndexedDbCharacterRepository } from './infrastructure/indexeddb-character-repository';
import { ResilientCharacterAssetRepository } from './infrastructure/resilient-character-asset-repository';
import { ResilientCharacterRepository } from './infrastructure/resilient-character-repository';
import { registerCharactersLegacyRoutes } from './legacy/register-routes';

export const charactersFeature: FeatureModule = {
  id: 'characters',
  install(context) {
    const { router, nativeFetch, records, blobs, capabilities } = context;
    registerArchiveModule(context, { moduleId: 'characters', displayName: 'Characters' });
    const repository = new ResilientCharacterRepository(new IndexedDbCharacterRepository(records));
    const assets = new ResilientCharacterAssetRepository(
      new IndexedDbCharacterAssetRepository(blobs),
    );
    const avatarWorkerReady =
      capabilities.get(assetServiceWorkerCapability)?.ready ?? Promise.resolve('skipped');
    const service = new CharacterService(
      repository,
      assets,
      async () => {
        const response = await nativeFetch('/img/ai4.png');
        if (!response.ok) throw new Error(`Default avatar failed to load: HTTP ${response.status}`);
        return response.blob();
      },
      avatarWorkerReady,
      undefined,
      async (ownerId) => {
        await capabilities.get(chatOwnerLifecycleCapability)?.deleteChatsForOwner(ownerId);
      },
    );

    capabilities.register(characterIdentityCapability, {
      resolveAvatarUrl: (avatarUrl) => service.resolveStableIdentity(avatarUrl),
      getAvatarUrl: (ownerId) => service.getAvatarForStableIdentity(ownerId),
    });

    registerCharactersLegacyRoutes(router, service);

    return {
      diagnostics: {
        storage: repository.diagnostics,
        assets: assets.diagnostics,
        service: service.diagnostics,
      },
    };
  },
};
