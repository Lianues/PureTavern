import type { OwnerAlias } from '../domain/chat';

export interface OwnerAliasRepository {
  get(avatarUrl: string): Promise<OwnerAlias | null>;
  save(alias: OwnerAlias): Promise<void>;
}
