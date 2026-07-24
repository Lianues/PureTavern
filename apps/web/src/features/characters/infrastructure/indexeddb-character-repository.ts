import type { ModuleRecordStore } from '@/platform/storage/app-storage';

import { cloneJson } from '../domain/character-card';
import type { CharacterRepository, StoredCharacter } from '../ports/character-repository';

const CARDS_COLLECTION = 'cards';

export class IndexedDbCharacterRepository implements CharacterRepository {
  readonly #records: ModuleRecordStore;

  constructor(records: ModuleRecordStore) {
    this.#records = records;
  }

  async list(): Promise<StoredCharacter[]> {
    const records = await this.#records.list<StoredCharacter>(CARDS_COLLECTION);
    return records
      .map((record) => cloneJson(record.value))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<StoredCharacter | null> {
    const record = await this.#records.get<StoredCharacter>(CARDS_COLLECTION, id);
    return record ? cloneJson(record.value) : null;
  }

  async findByAvatar(avatarFile: string): Promise<StoredCharacter | null> {
    const characters = await this.list();
    return characters.find((character) => character.avatarFile === avatarFile) ?? null;
  }

  async save(character: StoredCharacter): Promise<void> {
    await this.#records.put(CARDS_COLLECTION, character.id, cloneJson(character));
  }

  async delete(id: string): Promise<void> {
    await this.#records.delete(CARDS_COLLECTION, id);
  }
}
