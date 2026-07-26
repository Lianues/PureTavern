import type { ModuleBlobStore, ModuleRecordStore } from '../storage/app-storage';
import { defineCapability } from './capability-registry';

export interface CharacterIdentity {
  ownerId: string;
  avatarUrl: string;
}

export interface CharacterIdentityCapability {
  resolveAvatarUrl(avatarUrl: string): Promise<CharacterIdentity | null>;
  getAvatarUrl(ownerId: string): Promise<string | null>;
}

/**
 * 外部格式（例如 TauriTavern / SillyTavern 的 data 目录）里的角色就是一个把卡片 JSON
 * 内嵌在 tEXt 块里的 PNG。解码规则属于 characters 特性，导入方通过这个能力借用它，
 * 而不是把 PNG 解析逻辑复制一份。
 */
export interface CharacterCardMigrationCapability {
  readCardFromPng(bytes: Uint8Array): Record<string, unknown>;
}

export interface ChatOwnerLifecycleCapability {
  deleteChatsForOwner(ownerId: string): Promise<void>;
}

export interface ChatStatsSourceItem {
  id: string;
  ownerId: string;
  avatarUrl: string;
  byteSize: number;
  updatedAt: string;
  messages: readonly Record<string, unknown>[];
}

export interface ChatStatsSourceCapability {
  listChatsForStats(): Promise<readonly ChatStatsSourceItem[]>;
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
  legacyName: string;
  packageHash: string;
  files: readonly ExtensionPackageAssetFile[];
  installedAt: string;
}

export interface ExtensionPackageAssetsCapability {
  savePackage(asset: ExtensionPackageAsset): Promise<void>;
  removePackage(extensionId: string): Promise<void>;
  resolveAssetUrl(extensionId: string, path: string): Promise<string | null>;
}

export interface ExtensionMigrationInput {
  folderName: string;
  /** 规范化后的仓库地址，用来推导稳定的扩展 id。 */
  repositoryUrl: string;
  requestedRef: string;
  revision: string;
  scope: 'local' | 'global';
  installedAt: string;
  files: readonly { path: string; data: Blob }[];
}

export interface ExtensionMigrationResult {
  extensionId: string;
  legacyName: string;
  /** 完整的 ExtensionRecord，由导入方原样写入注册表。 */
  record: unknown;
  /** 经过校验、以扩展根目录为基准的包文件。 */
  files: readonly { path: string; data: Blob }[];
}

/**
 * 从外部迁移包里搬运一个第三方扩展。校验规则、id 推导和记录结构都属于 extensions 特性，
 * 导入方只负责搬运字节，不复制一份安全校验逻辑。
 */
export interface ExtensionMigrationCapability {
  buildImportedExtension(input: ExtensionMigrationInput): Promise<ExtensionMigrationResult>;
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

export interface ArchiveModuleRegistration {
  moduleId: string;
  displayName: string;
  dataVersion: number;
  sensitive: boolean;
  defaultSelected: boolean;
  records: ModuleRecordStore;
  blobs: ModuleBlobStore;
}

export interface ArchiveParticipantRegistryCapability {
  registerModule(registration: ArchiveModuleRegistration): void;
  hasModule(moduleId: string): boolean;
}

export const characterIdentityCapability =
  defineCapability<CharacterIdentityCapability>('characters.identity.v1');

export const characterCardMigrationCapability = defineCapability<CharacterCardMigrationCapability>(
  'characters.card-migration.v1',
);

export const chatOwnerLifecycleCapability = defineCapability<ChatOwnerLifecycleCapability>(
  'chats.owner-lifecycle.v1',
);

export const chatStatsSourceCapability =
  defineCapability<ChatStatsSourceCapability>('chats.stats-source.v1');

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

export const extensionMigrationCapability =
  defineCapability<ExtensionMigrationCapability>('extensions.migration.v1');

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

export const archiveParticipantRegistryCapability =
  defineCapability<ArchiveParticipantRegistryCapability>('import-export.participants.v1');
