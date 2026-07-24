import type { ModuleRecordStore } from '@/platform/storage/app-storage';

import { cloneJson, type StoredWorldBook } from '../domain/world-book';
import type { WorldBookRepository } from '../ports/world-book-repository';

export const WORLD_BOOKS_COLLECTION = 'books';
export const WORLD_BOOK_ALIASES_COLLECTION = 'aliases';

export interface StoredWorldBookAlias {
  bookId: string;
}

export class IndexedDbWorldBookRepository implements WorldBookRepository {
  readonly #records: ModuleRecordStore;

  constructor(records: ModuleRecordStore) {
    this.#records = records;
  }

  async list(): Promise<StoredWorldBook[]> {
    const records = await this.#records.list<StoredWorldBook>(WORLD_BOOKS_COLLECTION);
    return records
      .map((record) => cloneJson(record.value))
      .sort((left, right) => left.legacyFileId.localeCompare(right.legacyFileId));
  }

  async get(legacyFileId: string): Promise<StoredWorldBook | null> {
    const alias = await this.#records.get<StoredWorldBookAlias>(
      WORLD_BOOK_ALIASES_COLLECTION,
      legacyFileId,
    );
    if (!alias) return null;

    const record = await this.#records.get<StoredWorldBook>(
      WORLD_BOOKS_COLLECTION,
      alias.value.bookId,
    );
    return record ? cloneJson(record.value) : null;
  }

  async save(book: StoredWorldBook): Promise<void> {
    const alias = await this.#records.get<StoredWorldBookAlias>(
      WORLD_BOOK_ALIASES_COLLECTION,
      book.legacyFileId,
    );
    if (alias && alias.value.bookId !== book.id) {
      throw new Error(`World Book alias already belongs to another book: ${book.legacyFileId}`);
    }

    const previous = await this.#records.get<StoredWorldBook>(WORLD_BOOKS_COLLECTION, book.id);
    await this.#records.put(WORLD_BOOKS_COLLECTION, book.id, cloneJson(book));
    await this.#records.put(WORLD_BOOK_ALIASES_COLLECTION, book.legacyFileId, {
      bookId: book.id,
    } satisfies StoredWorldBookAlias);

    if (previous && previous.value.legacyFileId !== book.legacyFileId) {
      await this.#records.delete(WORLD_BOOK_ALIASES_COLLECTION, previous.value.legacyFileId);
    }
  }

  async delete(legacyFileId: string): Promise<boolean> {
    const alias = await this.#records.get<StoredWorldBookAlias>(
      WORLD_BOOK_ALIASES_COLLECTION,
      legacyFileId,
    );
    if (!alias) return false;

    await this.#records.delete(WORLD_BOOK_ALIASES_COLLECTION, legacyFileId);
    await this.#records.delete(WORLD_BOOKS_COLLECTION, alias.value.bookId);
    return true;
  }
}
