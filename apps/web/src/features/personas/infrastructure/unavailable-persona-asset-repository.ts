import { PersonaAssetUnavailableError } from '../application/persona-errors';
import type { PersonaAssetRepository } from '../ports/persona-asset-repository';

/** Metadata-only fallback used until M13 injects the real adapter. It never stores avatar blobs. */
export class UnavailablePersonaAssetRepository implements PersonaAssetRepository {
  async hasAvatar(): Promise<boolean> {
    return false;
  }

  async ensureAvatar(): Promise<boolean> {
    return false;
  }

  async createAvatar(): Promise<string> {
    throw new PersonaAssetUnavailableError('Persona Assets adapter is not configured.');
  }

  async replaceAvatar(): Promise<void> {
    throw new PersonaAssetUnavailableError('Persona Assets adapter is not configured.');
  }

  async moveAvatarAlias(): Promise<string> {
    throw new PersonaAssetUnavailableError('Persona Assets adapter is not configured.');
  }

  async deleteAvatar(): Promise<void> {
    throw new PersonaAssetUnavailableError('Persona Assets adapter is not configured.');
  }
}
