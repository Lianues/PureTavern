export const CHAT_COMPLETION_SOURCES = [
  'openai',
  'claude',
  'openrouter',
  'ai21',
  'makersuite',
  'vertexai',
  'mistralai',
  'custom',
  'cohere',
  'perplexity',
  'groq',
  'electronhub',
  'chutes',
  'nanogpt',
  'deepseek',
  'aimlapi',
  'xai',
  'pollinations',
  'moonshot',
  'fireworks',
  'cometapi',
  'azure_openai',
  'zai',
  'siliconflow',
  'workers_ai',
  'minimax',
] as const;

export type ChatCompletionSource = (typeof CHAT_COMPLETION_SOURCES)[number];
export type ProviderProtocol = 'openai-compatible' | 'anthropic' | 'google' | 'cohere';

export interface ProviderDescriptor {
  source: ChatCompletionSource;
  protocol: ProviderProtocol;
  secretKey: string | null;
  baseUrl: string;
  supportsReverseProxy: boolean;
  keyOptional: boolean;
}

export interface ProviderModel {
  id: string;
  [key: string]: unknown;
}

export interface ModelCatalogResult {
  data: ProviderModel[];
  bypass?: boolean;
}

export type LegacyGenerationRequest = Record<string, unknown> & {
  chat_completion_source?: unknown;
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  secret_id?: unknown;
};

export type ProviderErrorCode =
  | 'invalid-request'
  | 'unsupported-source'
  | 'unsupported-capability'
  | 'missing-credential'
  | 'invalid-endpoint'
  | 'cors-or-network'
  | 'provider-error'
  | 'invalid-response'
  | 'aborted';

export class GenerationProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status: number;

  constructor(code: ProviderErrorCode, message: string, status = 400, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GenerationProviderError';
    this.code = code;
    this.status = status;
  }
}

export function readChatCompletionSource(value: unknown): ChatCompletionSource {
  if (
    typeof value !== 'string' ||
    !CHAT_COMPLETION_SOURCES.includes(value as ChatCompletionSource)
  ) {
    throw new GenerationProviderError(
      'unsupported-source',
      'The requested chat completion source is not supported.',
      400,
    );
  }
  return value as ChatCompletionSource;
}

export function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GenerationProviderError('invalid-request', `${label} is required.`, 400);
  }
  return value.trim();
}
