export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface WorldBookDocument extends JsonObject {
  entries: JsonObject | JsonValue[];
}

export interface StoredWorldBook {
  id: string;
  legacyFileId: string;
  name: string;
  document: WorldBookDocument;
  createdAt: string;
  updatedAt: string;
}

export interface LegacyWorldBookSummary {
  file_id: string;
  name: string;
  extensions: JsonObject | JsonValue[];
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isJsonContainer(value: unknown): value is JsonObject | JsonValue[] {
  return value !== null && typeof value === 'object';
}

export function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('World Book data must be JSON-serializable.');
  return JSON.parse(serialized) as T;
}

export function worldBookDisplayName(document: WorldBookDocument, legacyFileId: string): string {
  return typeof document.name === 'string' && document.name.trim()
    ? document.name.trim()
    : legacyFileId;
}
