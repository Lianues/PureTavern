import {
  isPresetType,
  type JsonObject,
  type JsonValue,
  type PresetDocument,
  type PresetType,
} from '../domain/preset';

const FORBIDDEN_VISIBLE_FILE_CHARS = /[\\/:*?"<>|]/u;
const ENCODED_PATH_PARTS = /%(?:2e|2f|5c)/iu;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export const MAX_PRESET_NAME_LENGTH = 240;
export const MAX_PRESET_BYTES = 2 * 1024 * 1024;
export const MAX_PRESET_JSON_DEPTH = 64;

export class PresetValidationError extends Error {}
export class PresetNotFoundError extends Error {}
export class PresetConflictError extends Error {}

export function normalizePresetType(value: unknown): PresetType {
  if (!isPresetType(value)) {
    throw new PresetValidationError(`Unknown preset type: ${String(value)}`);
  }
  return value;
}

export function normalizePresetName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PresetValidationError('Preset name must be a string.');
  }

  const name = value.trim();
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.length > MAX_PRESET_NAME_LENGTH ||
    name.includes('..') ||
    name.includes('\u001f') ||
    name.endsWith('.') ||
    name.endsWith(' ') ||
    FORBIDDEN_VISIBLE_FILE_CHARS.test(name) ||
    ENCODED_PATH_PARTS.test(name) ||
    WINDOWS_RESERVED_NAME.test(name) ||
    [...name].some(isControlCharacter)
  ) {
    throw new PresetValidationError('Preset name contains unsafe path characters.');
  }

  return name;
}

export function validatePresetDocument(
  value: unknown,
  options: { allowArrayRoot?: boolean } = {},
): asserts value is PresetDocument {
  if (!isPlainJsonObject(value) && !(options.allowArrayRoot && Array.isArray(value))) {
    throw new PresetValidationError('Preset data must be a JSON object.');
  }

  const seen = new Set<object>();
  validateJsonValue(value, 0, seen);

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new PresetValidationError('Preset data must be JSON-serializable.', { cause: error });
  }

  if (utf8ByteLength(serialized) > MAX_PRESET_BYTES) {
    throw new PresetValidationError(`Preset data exceeds the ${MAX_PRESET_BYTES}-byte size limit.`);
  }
}

export function validateSourceHash(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new PresetValidationError('Preset source hash must be a non-empty string.');
  }
  return value;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isPlainJsonObject(value);
}

function validateJsonValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
): asserts value is JsonValue {
  if (depth > MAX_PRESET_JSON_DEPTH) {
    throw new PresetValidationError(
      `Preset data exceeds the maximum JSON depth of ${MAX_PRESET_JSON_DEPTH}.`,
    );
  }

  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PresetValidationError('Preset data cannot contain non-finite numbers.');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new PresetValidationError(`Preset data contains a non-JSON ${typeof value} value.`);
  }
  if (seen.has(value)) {
    throw new PresetValidationError('Preset data cannot contain circular references.');
  }

  if (!Array.isArray(value) && !isPlainJsonObject(value)) {
    throw new PresetValidationError('Preset data can only contain plain JSON objects and arrays.');
  }

  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new PresetValidationError('Preset data cannot contain sparse arrays.');
      }
      validateJsonValue(value[index], depth + 1, seen);
    }
  } else {
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) {
      throw new PresetValidationError('Preset data cannot contain symbol keys.');
    }
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) {
        throw new PresetValidationError(`Preset data contains a dangerous key: ${key}`);
      }
      validateJsonValue(value[key], depth + 1, seen);
    }
  }
  seen.delete(value);
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isControlCharacter(value: string): boolean {
  const code = value.codePointAt(0) ?? 0;
  return (code >= 0 && code <= 31) || (code >= 127 && code <= 159);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
