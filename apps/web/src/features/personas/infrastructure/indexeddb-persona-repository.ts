import type { ModuleRecordStore } from '@/platform/storage/app-storage';

import { clonePersonaState, type PersonaStateDocument } from '../domain/persona';
import type { PersonaRepository } from '../ports/persona-repository';

export const PERSONA_STATE_COLLECTION = 'state';
export const PERSONA_STATE_ID = 'current';

export class IndexedDbPersonaRepository implements PersonaRepository {
  readonly #records: ModuleRecordStore;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(records: ModuleRecordStore) {
    this.#records = records;
  }

  async load(): Promise<PersonaStateDocument | null> {
    await this.#writeTail;
    const record = await this.#records.get<PersonaStateDocument>(
      PERSONA_STATE_COLLECTION,
      PERSONA_STATE_ID,
    );
    return record ? clonePersonaState(record.value) : null;
  }

  async save(state: PersonaStateDocument): Promise<void> {
    const snapshot = clonePersonaState(state);
    return this.#write(() =>
      this.#records.put(PERSONA_STATE_COLLECTION, PERSONA_STATE_ID, snapshot),
    );
  }

  #write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeTail.then(operation, operation);
    this.#writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
