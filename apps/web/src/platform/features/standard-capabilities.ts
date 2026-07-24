import { defineCapability } from './capability-registry';

export interface CharacterIdentity {
  ownerId: string;
  avatarUrl: string;
}

export interface CharacterIdentityCapability {
  resolveAvatarUrl(avatarUrl: string): Promise<CharacterIdentity | null>;
  getAvatarUrl(ownerId: string): Promise<string | null>;
}

export interface ChatOwnerLifecycleCapability {
  deleteChatsForOwner(ownerId: string): Promise<void>;
}

export interface WorldNamesCapability {
  listWorldNames(): Promise<string[]>;
}

export interface LegacyPresetBootstrapCapability {
  getLegacyBootstrapData(): Promise<Record<string, unknown>>;
}

export interface AssetServiceWorkerCapability {
  ready: Promise<unknown>;
}

export const characterIdentityCapability =
  defineCapability<CharacterIdentityCapability>('characters.identity.v1');

export const chatOwnerLifecycleCapability = defineCapability<ChatOwnerLifecycleCapability>(
  'chats.owner-lifecycle.v1',
);

export const worldNamesCapability = defineCapability<WorldNamesCapability>('world-books.names.v1');

export const legacyPresetBootstrapCapability = defineCapability<LegacyPresetBootstrapCapability>(
  'presets.legacy-bootstrap.v1',
);

export const assetServiceWorkerCapability = defineCapability<AssetServiceWorkerCapability>(
  'assets.service-worker.v1',
);
