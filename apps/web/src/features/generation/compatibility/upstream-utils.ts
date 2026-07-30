import { parse as parseYaml } from 'yaml';

import type { ChatCompletionSource } from '../domain/provider';

export function mergeObjectWithYaml(target: Record<string, unknown>, yaml: unknown): void {
  if (typeof yaml !== 'string' || !yaml) return;
  try {
    const parsed = parseYaml(yaml) as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (isRecord(item)) Object.assign(target, item);
      }
    } else if (isRecord(parsed)) {
      Object.assign(target, parsed);
    }
  } catch {
    // SillyTavern intentionally ignores invalid Custom YAML.
  }
}

export function excludeKeysByYaml(target: Record<string, unknown>, yaml: unknown): void {
  if (typeof yaml !== 'string' || !yaml) return;
  try {
    const parsed = parseYaml(yaml) as unknown;
    if (Array.isArray(parsed)) {
      for (const key of parsed) delete target[String(key)];
    } else if (isRecord(parsed)) {
      for (const key of Object.keys(parsed)) delete target[key];
    } else if (typeof parsed === 'string') {
      delete target[parsed];
    }
  } catch {
    // SillyTavern intentionally ignores invalid Custom YAML.
  }
}

export function flattenSchema<T>(schema: T, source: ChatCompletionSource): T {
  if (!schema || typeof schema !== 'object') return schema;
  const schemaCopy = structuredClone(schema) as Record<string, unknown>;
  const google = source === 'vertexai' || source === 'makersuite';
  const definitions = isRecord(schemaCopy.$defs) ? schemaCopy.$defs : {};
  delete schemaCopy.$defs;

  const resolve = (value: unknown, parents: string[] = []): unknown => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => resolve(item, parents));
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === 'string' && object.$ref.startsWith('#/$defs/')) {
      const name = object.$ref.split('/').pop() ?? '';
      if (parents.includes(name)) return {};
      const definition = definitions[name];
      return definition === undefined
        ? {}
        : resolve(structuredClone(definition), [...parents, name]);
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) {
      if (
        google &&
        ['default', 'additionalProperties', 'exclusiveMinimum', 'propertyNames'].includes(key)
      ) {
        continue;
      }
      result[key] = resolve(item, parents);
    }
    return result;
  };

  const flattened = resolve(schemaCopy) as Record<string, unknown>;
  delete flattened.$schema;
  return flattened as T;
}

export function trimTrailingSlash(value: unknown): string {
  return String(value ?? '').replace(/\/$/u, '');
}

export function tryParse(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
