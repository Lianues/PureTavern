import { cloneJson } from '../domain/character-card';
import type { CharacterRepository, StoredCharacter } from '../ports/character-repository';

export interface CharacterStorageDiagnostics {
  status: 'ready' | 'degraded';
  backend: 'indexeddb' | 'memory';
  message: string | null;
  lastSavedAt: string | null;
}

export class MemoryCharacterRepository implements CharacterRepository {
  readonly #characters = new Map<string, StoredCharacter>();

  async list(): Promise<StoredCharacter[]> {
    return [...this.#characters.values()]
      .map((character) => cloneJson(character))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<StoredCharacter | null> {
    const character = this.#characters.get(id);
    return character ? cloneJson(character) : null;
  }

  async findByAvatar(avatarFile: string): Promise<StoredCharacter | null> {
    const character = [...this.#characters.values()].find((item) => item.avatarFile === avatarFile);
    return character ? cloneJson(character) : null;
  }

  async save(character: StoredCharacter): Promise<void> {
    this.#characters.set(character.id, cloneJson(character));
  }

  async delete(id: string): Promise<void> {
    this.#characters.delete(id);
  }
}

export class ResilientCharacterRepository implements CharacterRepository {
  readonly diagnostics: CharacterStorageDiagnostics = {
    status: 'ready',
    backend: 'indexeddb',
    message: null,
    lastSavedAt: null,
  };

  readonly #primary: CharacterRepository;
  readonly #fallback: CharacterRepository;

  constructor(
    primary: CharacterRepository,
    fallback: CharacterRepository = new MemoryCharacterRepository(),
  ) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async list(): Promise<StoredCharacter[]> {
    try {
      const characters = await this.#primary.list();
      await Promise.all(characters.map((character) => this.#fallback.save(character)));
      return characters;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.list();
    }
  }

  async get(id: string): Promise<StoredCharacter | null> {
    try {
      const character = await this.#primary.get(id);
      if (character) await this.#fallback.save(character);
      return character;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.get(id);
    }
  }

  async findByAvatar(avatarFile: string): Promise<StoredCharacter | null> {
    try {
      const character = await this.#primary.findByAvatar(avatarFile);
      if (character) await this.#fallback.save(character);
      return character;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.findByAvatar(avatarFile);
    }
  }

  async save(character: StoredCharacter): Promise<void> {
    await this.#fallback.save(character);
    try {
      await this.#primary.save(character);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    } catch (error) {
      this.#degrade(error);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    }
  }

  async delete(id: string): Promise<void> {
    await this.#fallback.delete(id);
    try {
      await this.#primary.delete(id);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    } catch (error) {
      this.#degrade(error);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    }
  }

  #degrade(error: unknown) {
    this.diagnostics.status = 'degraded';
    this.diagnostics.backend = 'memory';
    this.diagnostics.message = error instanceof Error ? error.message : String(error);
  }
}
