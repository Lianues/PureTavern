import type { StoredWorldBook } from '../domain/world-book';

/**
 * World Books use stable IDs internally while Legacy callers address books by file ID.
 * Implementations own the alias lookup between those identities.
 */
export interface WorldBookRepository {
  list(): Promise<StoredWorldBook[]>;
  get(legacyFileId: string): Promise<StoredWorldBook | null>;
  save(book: StoredWorldBook): Promise<void>;
  delete(legacyFileId: string): Promise<boolean>;
}
