import {
  GenerationProviderError,
  readRequiredString,
  type LegacyGenerationRequest,
  type ProviderDescriptor,
} from '../domain/provider';

export function resolveProviderBaseUrl(
  descriptor: ProviderDescriptor,
  request: LegacyGenerationRequest,
): URL {
  let value = descriptor.baseUrl;
  if (descriptor.source === 'custom')
    value = readRequiredString(request.custom_url, 'Custom API URL');
  if (descriptor.source === 'azure_openai') {
    value = readRequiredString(request.azure_base_url, 'Azure base URL');
  }
  if (descriptor.source === 'siliconflow' && request.siliconflow_endpoint === 'cn') {
    value = 'https://api.siliconflow.cn/v1';
  }
  if (descriptor.source === 'minimax' && request.minimax_endpoint === 'cn') {
    value = 'https://api.minimaxi.com/v1';
  }
  if (descriptor.source === 'zai' && request.zai_endpoint === 'coding') {
    value = 'https://api.z.ai/api/coding/paas/v4';
  }
  // An explicit reverse_proxy override takes precedence over source-specific
  // endpoint selections above so user-configured proxies are honored.
  if (
    descriptor.supportsReverseProxy &&
    typeof request.reverse_proxy === 'string' &&
    request.reverse_proxy.trim()
  ) {
    value = request.reverse_proxy.trim();
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new GenerationProviderError(
      'invalid-endpoint',
      'Provider endpoint URL is invalid.',
      400,
      {
        cause: error,
      },
    );
  }
  const localHttp =
    url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.username || url.password || (url.protocol !== 'https:' && !localHttp)) {
    throw new GenerationProviderError(
      'invalid-endpoint',
      'Provider endpoints must use HTTPS, except localhost development endpoints.',
      400,
    );
  }
  return url;
}

export function joinProviderUrl(base: URL, pathname: string): URL {
  const normalized = new URL(base.toString());
  normalized.pathname = `${normalized.pathname.replace(/\/$/u, '')}/${pathname.replace(/^\//u, '')}`;
  return normalized;
}
