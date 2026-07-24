import type { CharacterCard } from '../domain/character-card';

export interface StoredCharacter {
  id: string;
  avatarFile: string;
  card: CharacterCard;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterRepository {
  list(): Promise<StoredCharacter[]>;
  get(id: string): Promise<StoredCharacter | null>;
  findByAvatar(avatarFile: string): Promise<StoredCharacter | null>;
  save(character: StoredCharacter): Promise<void>;
  delete(id: string): Promise<void>;
}
