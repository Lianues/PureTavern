/**
 * Boundary owned by M13 Assets. Personas only deals in avatar aliases and image blobs; it never
 * stores blobs or calls Legacy HTTP routes itself.
 */
export interface PersonaAssetRepository {
  hasAvatar(avatarAlias: string): Promise<boolean>;
  /** Ask Assets to materialize its default user image under this alias. */
  ensureAvatar(avatarAlias: string): Promise<boolean>;
  /** Store a new image; Assets may return a collision-safe alias. */
  createAvatar(preferredAlias: string, image: Blob): Promise<string>;
  /** Overwrite the image while retaining the existing alias. */
  replaceAvatar(avatarAlias: string, image: Blob): Promise<void>;
  /** Move only the M13-owned path alias; the central asset implementation owns blob handling. */
  moveAvatarAlias(fromAlias: string, preferredAlias: string): Promise<string>;
  deleteAvatar(avatarAlias: string): Promise<void>;
}
