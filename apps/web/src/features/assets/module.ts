import type { FeatureModule } from '@/platform/features/feature-module';
import { registerArchiveModule } from '@/platform/features/register-archive-module';
import {
  assetServiceWorkerCapability,
  characterIdentityCapability,
  extensionPackageAssetsCapability,
  personaAvatarAssetsCapability,
} from '@/platform/features/standard-capabilities';

import { AssetService } from './application/asset-service';
import {
  IndexedDbAssetBlobRepository,
  ResilientBlobRepository,
} from './infrastructure/asset-blob-repositories';
import {
  IndexedDbAssetIndex,
  ResilientAssetIndex,
} from './infrastructure/asset-index-repositories';
import { registerAssetServiceWorker } from './infrastructure/asset-service-worker-registration';
import { BrowserImageProcessor } from './infrastructure/browser-image-processor';
import {
  seedDefaultBackgrounds,
  type DefaultBackgroundSeedDiagnostics,
} from './infrastructure/default-background-seeder';
import { registerAssetsLegacyRoutes } from './legacy/register-routes';
import type { AssetOwnerResolver } from './ports/asset-owner-resolver';

export const ASSET_RESOURCE_NAMESPACES = Object.freeze([
  '/backgrounds/',
  '/User Avatars/',
  '/user/files/',
  '/user/images/',
  '/characters/',
  '/assets/',
  '/scripts/extensions/third-party/',
]);

export interface AssetsFeatureOptions {
  ownerResolver?: AssetOwnerResolver;
}

export function createAssetsFeature(options: AssetsFeatureOptions = {}): FeatureModule {
  return {
    id: 'assets',
    install(context) {
      const { router, nativeFetch, records, blobs, capabilities } = context;
      registerArchiveModule(context, { moduleId: 'assets', displayName: 'Assets & Attachments' });
      const blobRepository = new ResilientBlobRepository(
        new IndexedDbAssetBlobRepository(blobs, records),
      );
      const index = new ResilientAssetIndex(new IndexedDbAssetIndex(records));
      const imageProcessor = new BrowserImageProcessor();
      const serviceWorker = {
        status: 'pending' as 'pending' | 'ready' | 'skipped' | 'error',
        message: null as string | null,
      };
      const serviceWorkerReady = registerAssetServiceWorker()
        .then((status) => {
          serviceWorker.status = status;
          return status;
        })
        .catch((error: unknown) => {
          serviceWorker.status = 'error';
          serviceWorker.message = error instanceof Error ? error.message : String(error);
          throw error;
        });
      capabilities.register(assetServiceWorkerCapability, { ready: serviceWorkerReady });

      const ownerResolver =
        options.ownerResolver ??
        ({
          async resolveOwner(ownerAlias: string) {
            const identity = capabilities.get(characterIdentityCapability);
            if (!identity) return null;
            const candidates = ownerAlias.toLowerCase().endsWith('.png')
              ? [ownerAlias]
              : [ownerAlias, `${ownerAlias}.png`];
            for (const candidate of candidates) {
              try {
                const resolved = await identity.resolveAvatarUrl(candidate);
                if (resolved) return resolved.ownerId;
              } catch {
                // The Assets service retains its own stable alias when no character matches.
              }
            }
            return null;
          },
        } satisfies AssetOwnerResolver);
      const service = new AssetService(
        blobRepository,
        index,
        imageProcessor,
        nativeFetch,
        ownerResolver,
      );
      capabilities.register(personaAvatarAssetsCapability, {
        hasAvatar: (avatarAlias) => service.hasAvatar(avatarAlias),
        ensureAvatar: (avatarAlias) => service.hasAvatar(avatarAlias),
        createAvatar: (preferredAlias, image) => service.uploadAvatar(image, preferredAlias),
        replaceAvatar: async (avatarAlias, image) => {
          await service.uploadAvatar(image, avatarAlias, avatarAlias);
        },
        moveAvatarAlias: (fromAlias, preferredAlias) =>
          service.renameAvatar(fromAlias, preferredAlias),
        deleteAvatar: (avatarAlias) => service.deleteAvatar(avatarAlias),
      });
      capabilities.register(extensionPackageAssetsCapability, {
        savePackage: (asset) => service.saveExtensionPackage(asset),
        removePackage: (extensionId) => service.removeExtensionPackage(extensionId),
        resolveAssetUrl: (extensionId, path) =>
          service.resolveExtensionPackageAssetUrl(extensionId, path),
      });
      const defaultBackgrounds: DefaultBackgroundSeedDiagnostics = {
        status: 'pending',
        seeded: 0,
        message: null,
      };
      const backgroundsReady = seedDefaultBackgrounds(
        service,
        records,
        nativeFetch,
        defaultBackgrounds,
      );
      registerAssetsLegacyRoutes(router, service, { backgroundsReady });

      return {
        diagnostics: {
          blobs: blobRepository.diagnostics,
          index: index.diagnostics,
          imageProcessor: imageProcessor.diagnostics,
          service: service.diagnostics,
          defaultBackgrounds,
          resourceNamespaces: ASSET_RESOURCE_NAMESPACES,
          personaAvatarBridge: 'ready',
          extensionPackageBridge: 'ready',
          serviceWorker,
        },
      };
    },
  };
}

export const assetsFeature = createAssetsFeature();
