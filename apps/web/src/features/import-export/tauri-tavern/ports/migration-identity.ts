/**
 * 导入 TauriTavern 数据时，同一份内容在本地可能已经有一个随机 id 了。
 * 如果不去认领这些 id，导入就会在角色列表里造出第二个同名角色、在聊天列表里造出第二份同名记录。
 * 这个查询表把「自然键 -> 已有 id」交给转换层，让转换结果落到既有记录上而不是新建。
 */
export interface MigrationIdentityLookup {
  /** 头像文件名（含 .png）-> 已有 StoredCharacter.id */
  characterIdByAvatar(avatarFile: string): string | null;
  /** 角色头像文件名 -> 已有的聊天 ownerId */
  chatOwnerIdByAvatar(avatarFile: string): string | null;
  /** (ownerId, 聊天文件名) -> 已有 StoredChatSession.id */
  chatSessionId(ownerId: string, legacyFileName: string): string | null;
  /** 世界书文件名（不含扩展名）-> 已有 StoredWorldBook.id */
  worldBookId(legacyFileId: string): string | null;
  /** (预设类型, 预设名) -> 已有 PresetRecord.id */
  presetId(type: string, name: string): string | null;
  /** 资源的 legacy 路径（以 / 开头）-> 已有 AssetRecord.id */
  assetId(legacyPath: string): string | null;
}

/** 纯转换测试用的空实现：所有 id 都当作新建。 */
export const EMPTY_MIGRATION_IDENTITY: MigrationIdentityLookup = Object.freeze({
  characterIdByAvatar: () => null,
  chatOwnerIdByAvatar: () => null,
  chatSessionId: () => null,
  worldBookId: () => null,
  presetId: () => null,
  assetId: () => null,
});
