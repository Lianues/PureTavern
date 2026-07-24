export const PRESET_TYPES = [
  'kobold',
  'novel',
  'openai',
  'textgenerationwebui',
  'instruct',
  'context',
  'sysprompt',
  'reasoning',
  'theme',
  'moving-ui',
  'quick-reply',
] as const;

export type PresetType = (typeof PRESET_TYPES)[number];

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type PresetDocument = JsonObject | JsonValue[];

export interface PresetMetadata {
  origin: 'default' | 'user';
  sourceHash?: string;
  userModified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PresetRecord<T = PresetDocument> {
  id: string;
  type: PresetType;
  name: string;
  value: T;
  metadata: PresetMetadata;
}

export interface PresetSeedState {
  sourceHashes: Record<string, string>;
  synchronizedAt: string;
}

export interface PresetSeedEntry<T = PresetDocument> {
  type: PresetType;
  name: string;
  value: T;
  sourceHash: string;
}

export interface PresetSeedManifest<T = PresetDocument> {
  version: 1;
  presets: PresetSeedEntry<T>[];
}

export function isPresetType(value: unknown): value is PresetType {
  return typeof value === 'string' && (PRESET_TYPES as readonly string[]).includes(value);
}

export function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Preset data must be JSON-serializable.');
  return JSON.parse(serialized) as T;
}

export function clonePresetRecord<T>(record: PresetRecord<T>): PresetRecord<T> {
  return cloneJson(record);
}
