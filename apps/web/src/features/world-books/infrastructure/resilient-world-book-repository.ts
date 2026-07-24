import { cloneJson, type StoredWorldBook } from '../domain/world-book';
import type { WorldBookRepository } from '../ports/world-book-repository';

export interface WorldBookStorageDiagnostics {
  status: 'ready' | 'degraded';
  backend: 'indexeddb' | 'memory';
  message: string | null;
  lastSavedAt: string | null;
}

export class MemoryWorldBookRepository implements WorldBookRepository {
  readonly #books = new Map<string, StoredWorldBook>();
  readonly #aliases = new Map<string, string>();

  async list(): Promise<StoredWorldBook[]> {
    return [...this.#books.values()]
      .map((book) => cloneJson(book))
      .sort((left, right) => left.legacyFileId.localeCompare(right.legacyFileId));
  }

  async get(legacyFileId: string): Promise<StoredWorldBook | null> {
    const bookId = this.#aliases.get(legacyFileId);
    const book = bookId ? this.#books.get(bookId) : null;
    return book ? cloneJson(book) : null;
  }

  async save(book: StoredWorldBook): Promise<void> {
    const aliasOwner = this.#aliases.get(book.legacyFileId);
    if (aliasOwner && aliasOwner !== book.id) {
      throw new Error(`World Book alias already belongs to another book: ${book.legacyFileId}`);
    }

    const previous = this.#books.get(book.id);
    if (previous && previous.legacyFileId !== book.legacyFileId) {
      this.#aliases.delete(previous.legacyFileId);
    }
    this.#books.set(book.id, cloneJson(book));
    this.#aliases.set(book.legacyFileId, book.id);
  }

  async delete(legacyFileId: string): Promise<boolean> {
    const bookId = this.#aliases.get(legacyFileId);
    if (!bookId) return false;
    this.#aliases.delete(legacyFileId);
    this.#books.delete(bookId);
    return true;
  }
}

export class ResilientWorldBookRepository implements WorldBookRepository {
  readonly diagnostics: WorldBookStorageDiagnostics = {
    status: 'ready',
    backend: 'indexeddb',
    message: null,
    lastSavedAt: null,
  };

  readonly #primary: WorldBookRepository;
  readonly #fallback: WorldBookRepository;

  constructor(
    primary: WorldBookRepository,
    fallback: WorldBookRepository = new MemoryWorldBookRepository(),
  ) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async list(): Promise<StoredWorldBook[]> {
    if (this.diagnostics.backend === 'memory') return this.#fallback.list();
    try {
      const books = await this.#primary.list();
      await Promise.all(books.map((book) => this.#fallback.save(book)));
      return books;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.list();
    }
  }

  async get(legacyFileId: string): Promise<StoredWorldBook | null> {
    if (this.diagnostics.backend === 'memory') return this.#fallback.get(legacyFileId);
    try {
      const book = await this.#primary.get(legacyFileId);
      if (book) await this.#fallback.save(book);
      return book;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.get(legacyFileId);
    }
  }

  async save(book: StoredWorldBook): Promise<void> {
    await this.#fallback.save(book);
    if (this.diagnostics.backend === 'memory') {
      this.diagnostics.lastSavedAt = new Date().toISOString();
      return;
    }
    try {
      await this.#primary.save(book);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    } catch (error) {
      this.#degrade(error);
      this.diagnostics.lastSavedAt = new Date().toISOString();
    }
  }

  async delete(legacyFileId: string): Promise<boolean> {
    const fallbackDeleted = await this.#fallback.delete(legacyFileId);
    if (this.diagnostics.backend === 'memory') {
      this.diagnostics.lastSavedAt = new Date().toISOString();
      return fallbackDeleted;
    }
    try {
      const primaryDeleted = await this.#primary.delete(legacyFileId);
      this.diagnostics.lastSavedAt = new Date().toISOString();
      return primaryDeleted || fallbackDeleted;
    } catch (error) {
      this.#degrade(error);
      this.diagnostics.lastSavedAt = new Date().toISOString();
      return fallbackDeleted;
    }
  }

  #degrade(error: unknown) {
    this.diagnostics.status = 'degraded';
    this.diagnostics.backend = 'memory';
    this.diagnostics.message = error instanceof Error ? error.message : String(error);
  }
}
