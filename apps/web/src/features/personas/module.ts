import type { FeatureInstallContext, FeatureModule } from '@/platform/features/feature-module';
import {
  legacyPersonaStateCapability,
  personaAvatarAssetsCapability,
} from '@/platform/features/standard-capabilities';

import { PersonaService, type PersonaServiceOptions } from './application/persona-service';
import { IndexedDbPersonaRepository } from './infrastructure/indexeddb-persona-repository';
import { ResilientPersonaRepository } from './infrastructure/resilient-persona-repository';
import { UnavailablePersonaAssetRepository } from './infrastructure/unavailable-persona-asset-repository';
import type { LegacyPersonaStateAdapter } from './ports/legacy-persona-state';
import type { PersonaAssetRepository } from './ports/persona-asset-repository';

export interface PersonasModuleRuntime {
  service: PersonaService;
  assets: PersonaAssetRepository;
}

export interface PersonasFeatureOptions {
  /** M13-owned adapter. A factory can consume runtime context without registering a capability here. */
  createAssetRepository?: (context: FeatureInstallContext) => PersonaAssetRepository;
  /** Later Settings wiring attaches the provider/composer to its own serialized pipeline. */
  legacyStateAdapter?: LegacyPersonaStateAdapter;
  service?: PersonaServiceOptions;
  onInstall?: (runtime: PersonasModuleRuntime) => void;
}

export function createPersonasFeature(options: PersonasFeatureOptions = {}): FeatureModule {
  return {
    id: 'personas',
    install(context) {
      const repository = new ResilientPersonaRepository(
        new IndexedDbPersonaRepository(context.records),
      );
      const assets =
        options.createAssetRepository?.(context) ?? new UnavailablePersonaAssetRepository();
      const service = new PersonaService(repository, assets, options.service);

      context.capabilities.register(legacyPersonaStateCapability, service);
      // Personas has no dedicated Legacy HTTP routes; Settings and Assets consume the typed bridges.
      options.legacyStateAdapter?.attach(service, service);
      options.onInstall?.({ service, assets });

      return {
        diagnostics: {
          storage: repository.diagnostics,
          service: service.diagnostics,
          assets: {
            status: options.createAssetRepository ? 'configured' : 'unavailable',
            message: options.createAssetRepository
              ? null
              : 'Inject the M13 PersonaAssetRepository adapter to enable avatar operations.',
          },
        },
      };
    },
  };
}

export const personasFeature = createPersonasFeature({
  createAssetRepository({ capabilities }) {
    return (
      capabilities.get(personaAvatarAssetsCapability) ?? new UnavailablePersonaAssetRepository()
    );
  },
});
