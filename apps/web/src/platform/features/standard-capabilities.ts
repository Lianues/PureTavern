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

export interface PersonaAvatarAssetsCapability {
  hasAvatar(avatarAlias: string): Promise<boolean>;
  ensureAvatar(avatarAlias: string): Promise<boolean>;
  createAvatar(preferredAlias: string, image: Blob): Promise<string>;
  replaceAvatar(avatarAlias: string, image: Blob): Promise<void>;
  moveAvatarAlias(fromAlias: string, preferredAlias: string): Promise<string>;
  deleteAvatar(avatarAlias: string): Promise<void>;
}

export interface LegacyPersonaStateCapability {
  importLegacyPersonaState(settings: unknown): Promise<unknown>;
  composeLegacyPersonaState(settings: unknown): Promise<Record<string, unknown>>;
  getLegacyPersonaState(): Promise<Record<string, unknown>>;
  getActiveLocalIdentity(): Promise<{
    name: string;
    avatarAlias: string;
    personaId: string | null;
    fallback: boolean;
  }>;
}

export interface ExtensionPackageAssetFile {
  path: string;
  data: Blob;
  sha256: string;
}

export interface ExtensionPackageAsset {
  extensionId: string;
  packageHash: string;
  files: readonly ExtensionPackageAssetFile[];
  installedAt: string;
}

export interface ExtensionPackageAssetsCapability {
  savePackage(asset: ExtensionPackageAsset): Promise<void>;
  removePackage(extensionId: string): Promise<void>;
  resolveAssetUrl(extensionId: string, path: string): Promise<string | null>;
}

export interface LegacyExtensionSettingsCapability {
  getDisabledLegacyNames(): Promise<string[]>;
  applyDisabledLegacyNames(names: readonly string[]): Promise<void>;
}

export interface TokenizerCapability {
  readonly id: 'tokenx';
  readonly precision: 'approximate';
  countText(text: string): Promise<number>;
  countMessages(messages: unknown): Promise<number>;
}

export interface CredentialResolverCapability {
  resolveCredential(key: string, id?: string): Promise<string | null>;
  hasCredential(key: string): Promise<boolean>;
}

export interface GenerationProviderCapability {
  listSources(): string[];
  listModels(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  generate(request: Record<string, unknown>, signal?: AbortSignal): Promise<Response>;
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

export const personaAvatarAssetsCapability = defineCapability<PersonaAvatarAssetsCapability>(
  'assets.persona-avatars.v1',
);

export const legacyPersonaStateCapability = defineCapability<LegacyPersonaStateCapability>(
  'personas.legacy-settings.v1',
);

export const extensionPackageAssetsCapability = defineCapability<ExtensionPackageAssetsCapability>(
  'assets.extension-packages.v1',
);

export const legacyExtensionSettingsCapability =
  defineCapability<LegacyExtensionSettingsCapability>('extensions.legacy-settings.v1');

export const tokenizerCapability = defineCapability<TokenizerCapability>(
  'tokenizers.unified-estimator.v1',
);

export const credentialResolverCapability = defineCapability<CredentialResolverCapability>(
  'secrets.credential-resolver.v1',
);

export const generationProviderCapability = defineCapability<GenerationProviderCapability>(
  'generation.chat-completion.v1',
);
