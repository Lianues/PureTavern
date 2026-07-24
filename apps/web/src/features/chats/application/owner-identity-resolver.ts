import type { CharacterIdentityCapability } from '@/platform/features/standard-capabilities';

import { normalizeAvatarUrl, type OwnerAlias } from '../domain/chat';
import type { OwnerAliasRepository } from '../ports/owner-alias-repository';

export interface ResolvedChatOwner {
  ownerId: string;
  avatarUrl: string;
}

export class OwnerIdentityResolver {
  readonly #aliases: OwnerAliasRepository;
  readonly #characters: CharacterIdentityCapability | null;
  readonly #pending = new Map<string, Promise<ResolvedChatOwner>>();

  constructor(
    aliases: OwnerAliasRepository,
    characters: CharacterIdentityCapability | null = null,
  ) {
    this.#aliases = aliases;
    this.#characters = characters;
  }

  resolve(avatarUrlInput: unknown): Promise<ResolvedChatOwner> {
    const avatarUrl = normalizeAvatarUrl(avatarUrlInput);
    const pending = this.#pending.get(avatarUrl);
    if (pending) return pending;

    const resolution = this.#resolveOnce(avatarUrl).finally(() => {
      if (this.#pending.get(avatarUrl) === resolution) this.#pending.delete(avatarUrl);
    });
    this.#pending.set(avatarUrl, resolution);
    return resolution;
  }

  async getCurrentAvatar(ownerId: string, fallback: string): Promise<string> {
    const current = await this.#characters?.getAvatarUrl(ownerId);
    return current ? normalizeAvatarUrl(current) : fallback;
  }

  async #resolveOnce(avatarUrl: string): Promise<ResolvedChatOwner> {
    const character = await this.#characters?.resolveAvatarUrl(avatarUrl);
    if (character) {
      const resolved = {
        ownerId: character.ownerId,
        avatarUrl: normalizeAvatarUrl(character.avatarUrl),
      };
      await this.#saveAlias(resolved);
      return resolved;
    }

    const existing = await this.#aliases.get(avatarUrl);
    if (existing) return { ownerId: existing.ownerId, avatarUrl };

    const resolved = { ownerId: crypto.randomUUID(), avatarUrl };
    await this.#saveAlias(resolved);
    return resolved;
  }

  async #saveAlias(owner: ResolvedChatOwner): Promise<void> {
    const alias: OwnerAlias = {
      ownerId: owner.ownerId,
      avatarUrl: owner.avatarUrl,
      updatedAt: new Date().toISOString(),
    };
    await this.#aliases.save(alias);
  }
}
