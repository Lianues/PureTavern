import {
  cloneJson,
  isJsonContainer,
  type LegacyWorldBookSummary,
  type StoredWorldBook,
  type WorldBookDocument,
  worldBookDisplayName,
} from '../domain/world-book';
import type { WorldBookRepository } from '../ports/world-book-repository';
import { WorldBookImportCodec } from './world-book-import-codec';
import { normalizeWorldBookName, WorldBookNotFoundError } from './world-book-validation';

export type WorldBookIdFactory = () => string;
export type WorldBookClock = () => Date;

export class WorldBookService {
  readonly #repository: WorldBookRepository;
  readonly #codec: WorldBookImportCodec;
  readonly #createId: WorldBookIdFactory;
  readonly #clock: WorldBookClock;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(
    repository: WorldBookRepository,
    codec = new WorldBookImportCodec(),
    createId: WorldBookIdFactory = () => crypto.randomUUID(),
    clock: WorldBookClock = () => new Date(),
  ) {
    this.#repository = repository;
    this.#codec = codec;
    this.#createId = createId;
    this.#clock = clock;
  }

  async listWorldBooks(): Promise<LegacyWorldBookSummary[]> {
    const books = await this.#repository.list();
    return books.map((book) => ({
      file_id: book.legacyFileId,
      name: book.name,
      extensions: isJsonContainer(book.document.extensions)
        ? cloneJson(book.document.extensions)
        : {},
    }));
  }

  async listWorldNames(): Promise<string[]> {
    return (await this.#repository.list()).map((book) => book.legacyFileId);
  }

  async getWorldBook(nameInput: unknown): Promise<WorldBookDocument> {
    const legacyFileId = normalizeWorldBookName(nameInput);
    const book = await this.#repository.get(legacyFileId);
    return book ? cloneJson(book.document) : { entries: {} };
  }

  async editWorldBook(nameInput: unknown, documentInput: unknown): Promise<void> {
    const legacyFileId = normalizeWorldBookName(nameInput);
    const document = this.#codec.normalizeDocument(documentInput);
    await this.#serializeWrite(() => this.#upsert(legacyFileId, document));
  }

  async deleteWorldBook(nameInput: unknown): Promise<void> {
    const legacyFileId = normalizeWorldBookName(nameInput);
    await this.#serializeWrite(async () => {
      if (!(await this.#repository.delete(legacyFileId))) {
        throw new WorldBookNotFoundError(`World Book does not exist: ${legacyFileId}`);
      }
    });
  }

  async importWorldBook(file: Blob, convertedData?: unknown): Promise<string> {
    const decoded = await this.#codec.decode(file, convertedData);
    await this.#serializeWrite(() => this.#upsert(decoded.legacyFileId, decoded.document));
    return decoded.legacyFileId;
  }

  async #upsert(legacyFileId: string, document: WorldBookDocument): Promise<void> {
    const existing = await this.#repository.get(legacyFileId);
    const now = this.#clock().toISOString();
    const book: StoredWorldBook = existing
      ? {
          ...existing,
          name: worldBookDisplayName(document, legacyFileId),
          document: cloneJson(document),
          updatedAt: now,
        }
      : {
          id: this.#createId(),
          legacyFileId,
          name: worldBookDisplayName(document, legacyFileId),
          document: cloneJson(document),
          createdAt: now,
          updatedAt: now,
        };
    await this.#repository.save(book);
  }

  #serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeQueue.then(operation, operation);
    this.#writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
