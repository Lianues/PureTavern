import {
  cloneJson,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type WorldBookDocument,
} from '../domain/world-book';
import { WorldBookValidationError, worldBookNameFromUpload } from './world-book-validation';

export const MAX_WORLD_BOOK_IMPORT_BYTES = 10 * 1024 * 1024;

export interface DecodedWorldBookImport {
  legacyFileId: string;
  document: WorldBookDocument;
}

export class WorldBookImportCodec {
  normalizeDocument(value: unknown): WorldBookDocument {
    if (!isJsonObject(value)) {
      throw new WorldBookValidationError('World Book document must be a JSON object.');
    }
    if (!Object.prototype.hasOwnProperty.call(value, 'entries')) {
      throw new WorldBookValidationError('World Book document must contain entries.');
    }

    const entries = value.entries;
    if (!isJsonObject(entries) && !Array.isArray(entries)) {
      throw new WorldBookValidationError('World Book entries must be an object or array.');
    }

    try {
      return cloneJson(value) as WorldBookDocument;
    } catch (error) {
      throw new WorldBookValidationError(
        error instanceof Error ? error.message : 'World Book document is not JSON-serializable.',
      );
    }
  }

  async decode(file: Blob, convertedData?: unknown): Promise<DecodedWorldBookImport> {
    this.#ensureSize(file.size, 'World Book import');
    const legacyFileId = worldBookNameFromUpload(file);
    let source: string;

    if (typeof convertedData === 'string' && convertedData.trim()) {
      this.#ensureSize(
        new TextEncoder().encode(convertedData).byteLength,
        'Converted World Book data',
      );
      source = convertedData;
    } else {
      source = await file.text();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch {
      throw new WorldBookValidationError('World Book import is not valid JSON.');
    }

    return {
      legacyFileId,
      document: this.normalizeDocument(parsed),
    };
  }

  #ensureSize(size: number, label: string) {
    if (size > MAX_WORLD_BOOK_IMPORT_BYTES) {
      throw new WorldBookValidationError(
        `${label} is too large. Maximum size is ${MAX_WORLD_BOOK_IMPORT_BYTES} bytes.`,
      );
    }
  }
}

// Keep recursive JSON types reachable from generated declarations without narrowing opaque fields.
export type WorldBookImportJson = JsonObject | JsonValue[];
