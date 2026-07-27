import {
  CHAT_COMPLETION_SOURCES,
  GenerationProviderError,
  type ChatCompletionSource,
  type ProviderDescriptor,
} from '../domain/provider';

const descriptors: readonly ProviderDescriptor[] = [
  descriptor('openai', 'openai-compatible', 'api_key_openai', 'https://api.openai.com/v1', true),
  descriptor('claude', 'anthropic', 'api_key_claude', 'https://api.anthropic.com/v1', true),
  descriptor(
    'openrouter',
    'openai-compatible',
    'api_key_openrouter',
    'https://openrouter.ai/api/v1',
  ),
  descriptor('ai21', 'openai-compatible', 'api_key_ai21', 'https://api.ai21.com/studio/v1'),
  descriptor(
    'makersuite',
    'google',
    'api_key_makersuite',
    'https://generativelanguage.googleapis.com',
    true,
  ),
  descriptor('vertexai', 'google', 'api_key_vertexai', 'https://aiplatform.googleapis.com', true),
  descriptor(
    'mistralai',
    'openai-compatible',
    'api_key_mistralai',
    'https://api.mistral.ai/v1',
    true,
  ),
  descriptor('custom', 'openai-compatible', 'api_key_custom', '', false, true),
  descriptor('cohere', 'cohere', 'api_key_cohere', 'https://api.cohere.ai', true),
  descriptor('perplexity', 'openai-compatible', 'api_key_perplexity', 'https://api.perplexity.ai'),
  descriptor('groq', 'openai-compatible', 'api_key_groq', 'https://api.groq.com/openai/v1'),
  descriptor(
    'electronhub',
    'openai-compatible',
    'api_key_electronhub',
    'https://api.electronhub.ai/v1',
  ),
  descriptor('chutes', 'openai-compatible', 'api_key_chutes', 'https://llm.chutes.ai/v1'),
  descriptor('nanogpt', 'openai-compatible', 'api_key_nanogpt', 'https://nano-gpt.com/api/v1'),
  descriptor('deepseek', 'openai-compatible', 'api_key_deepseek', 'https://api.deepseek.com', true),
  descriptor('aimlapi', 'openai-compatible', 'api_key_aimlapi', 'https://api.aimlapi.com/v1'),
  descriptor('xai', 'openai-compatible', 'api_key_xai', 'https://api.x.ai/v1', true),
  descriptor(
    'pollinations',
    'openai-compatible',
    'api_key_pollinations',
    'https://gen.pollinations.ai/v1',
    false,
    true,
  ),
  descriptor(
    'moonshot',
    'openai-compatible',
    'api_key_moonshot',
    'https://api.moonshot.ai/v1',
    true,
  ),
  descriptor(
    'fireworks',
    'openai-compatible',
    'api_key_fireworks',
    'https://api.fireworks.ai/inference/v1',
  ),
  descriptor('cometapi', 'openai-compatible', 'api_key_cometapi', 'https://api.cometapi.com/v1'),
  descriptor('azure_openai', 'openai-compatible', 'api_key_azure_openai', ''),
  descriptor('zai', 'openai-compatible', 'api_key_zai', 'https://api.z.ai/api/paas/v4', true),
  descriptor(
    'siliconflow',
    'openai-compatible',
    'api_key_siliconflow',
    'https://api.siliconflow.com/v1',
  ),
  descriptor(
    'workers_ai',
    'openai-compatible',
    'api_key_workers_ai',
    'https://api.cloudflare.com/client/v4/accounts',
  ),
  descriptor('minimax', 'openai-compatible', 'api_key_minimax', 'https://api.minimax.io/v1'),
];

const registry = new Map(descriptors.map((entry) => [entry.source, entry]));

if (registry.size !== CHAT_COMPLETION_SOURCES.length) {
  throw new Error('Chat completion provider registry is incomplete or contains duplicates.');
}

export function getProviderDescriptor(source: ChatCompletionSource): ProviderDescriptor {
  const value = registry.get(source);
  if (!value) {
    throw new GenerationProviderError('unsupported-source', 'Provider descriptor is missing.', 400);
  }
  return value;
}

export function listProviderDescriptors(): readonly ProviderDescriptor[] {
  return descriptors.map((entry) => ({ ...entry }));
}

function descriptor(
  source: ChatCompletionSource,
  protocol: ProviderDescriptor['protocol'],
  secretKey: string | null,
  baseUrl: string,
  supportsReverseProxy = false,
  keyOptional = false,
): ProviderDescriptor {
  return { source, protocol, secretKey, baseUrl, supportsReverseProxy, keyOptional };
}
