export const LEGACY_SECRET_KEYS = [
  'api_key_horde',
  'api_key_mancer',
  'api_key_vllm',
  'api_key_aphrodite',
  'api_key_tabby',
  'api_key_openai',
  'api_key_novel',
  'api_key_claude',
  'deepl',
  'libre',
  'libre_url',
  'lingva_url',
  'api_key_openrouter',
  'api_key_ai21',
  'oneringtranslator_url',
  'deeplx_url',
  'api_key_makersuite',
  'api_key_vertexai',
  'api_key_serpapi',
  'api_key_mistralai',
  'api_key_togetherai',
  'api_key_infermaticai',
  'api_key_dreamgen',
  'api_key_custom',
  'api_key_ooba',
  'api_key_nomicai',
  'api_key_koboldcpp',
  'api_key_llamacpp',
  'api_key_cohere',
  'api_key_perplexity',
  'api_key_groq',
  'api_key_azure_tts',
  'api_key_azure_openai',
  'api_key_featherless',
  'api_key_huggingface',
  'api_key_stability',
  'api_key_custom_openai_tts',
  'api_key_chutes',
  'api_key_electronhub',
  'api_key_nanogpt',
  'api_key_tavily',
  'api_key_bfl',
  'api_key_comfy_runpod',
  'api_key_generic',
  'api_key_deepseek',
  'api_key_serper',
  'api_key_aimlapi',
  'api_key_falai',
  'api_key_xai',
  'api_key_fireworks',
  'vertexai_service_account_json',
  'api_key_minimax',
  'minimax_group_id',
  'api_key_moonshot',
  'api_key_cometapi',
  'api_key_zai',
  'api_key_siliconflow',
  'api_key_elevenlabs',
  'api_key_pollinations',
  'volcengine_app_id',
  'volcengine_access_key',
  'api_key_workers_ai',
] as const;

export interface SecretValue {
  id: string;
  value: string;
  label: string;
  active: boolean;
}

export interface SecretDocument {
  secrets: Record<string, SecretValue[]>;
}

export interface LegacySecretState {
  id: string;
  value: string;
  label: string;
  active: boolean;
}

export type LegacySecretStateMap = Record<string, LegacySecretState[] | null>;

export const MAX_SECRET_KEY_LENGTH = 256;
export const MAX_SECRET_LABEL_LENGTH = 512;

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class SecretValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretValidationError';
  }
}

export function createEmptySecretDocument(): SecretDocument {
  return { secrets: {} };
}

export function cloneSecretDocument(document: SecretDocument): SecretDocument {
  const secrets: Record<string, SecretValue[]> = {};
  for (const [key, values] of Object.entries(document.secrets)) {
    secrets[key] = values.map((value) => ({ ...value }));
  }
  return { secrets };
}

export function normalizeSecretDocument(value: unknown): SecretDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SecretValidationError('Stored credentials document is invalid.');
  }
  const source = (value as { secrets?: unknown }).secrets;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new SecretValidationError('Stored credentials map is invalid.');
  }

  const document = createEmptySecretDocument();
  for (const [key, entries] of Object.entries(source)) {
    assertSecretKey(key);
    if (!Array.isArray(entries)) {
      throw new SecretValidationError('Stored credential entries are invalid.');
    }
    const normalized = entries.map((entry) => normalizeSecretValue(entry));
    if (normalized.length > 0 && !normalized.some((entry) => entry.active)) {
      normalized[0]!.active = true;
    }
    let foundActive = false;
    for (const entry of normalized) {
      if (!entry.active) continue;
      if (foundActive) entry.active = false;
      foundActive = true;
    }
    if (normalized.length > 0) document.secrets[key] = normalized;
  }
  return document;
}

export function assertSecretKey(key: unknown): asserts key is string {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > MAX_SECRET_KEY_LENGTH ||
    key.trim() !== key ||
    containsControlCharacters(key) ||
    FORBIDDEN_KEYS.has(key)
  ) {
    throw new SecretValidationError('Credential key is invalid.');
  }
}

export function assertSecretId(id: unknown): asserts id is string {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 128 ||
    id.trim() !== id ||
    containsControlCharacters(id)
  ) {
    throw new SecretValidationError('Credential ID is invalid.');
  }
}

export function assertSecretLabel(label: unknown): asserts label is string {
  if (
    typeof label !== 'string' ||
    label.length === 0 ||
    label.length > MAX_SECRET_LABEL_LENGTH ||
    containsControlCharacters(label)
  ) {
    throw new SecretValidationError('Credential label is invalid.');
  }
}

export function assertSecretValue(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new SecretValidationError('Credential value must be a string.');
  }
}

export function maskSecretValue(value: string): string {
  if (value.length <= 10) return '*'.repeat(10);
  return `${'*'.repeat(7)}${value.slice(-3)}`;
}

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function normalizeSecretValue(value: unknown): SecretValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SecretValidationError('Stored credential entry is invalid.');
  }
  const entry = value as Partial<SecretValue>;
  assertSecretId(entry.id);
  assertSecretValue(entry.value);
  assertSecretLabel(entry.label);
  if (typeof entry.active !== 'boolean') {
    throw new SecretValidationError('Stored credential active state is invalid.');
  }
  return {
    id: entry.id,
    value: entry.value,
    label: entry.label,
    active: entry.active,
  };
}
