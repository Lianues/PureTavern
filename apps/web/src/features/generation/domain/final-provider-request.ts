import { GenerationProviderError } from './provider';

export interface FinalProviderRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body: string | null;
}

/** Serializes the final browser-built provider request without duplicating provider logic. */
export function createFinalProviderRequest(url: URL, init: RequestInit): FinalProviderRequest {
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new GenerationProviderError(
      'invalid-endpoint',
      'Backend transports require an absolute HTTP or HTTPS provider URL without credentials or a fragment.',
      400,
    );
  }

  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    throw new GenerationProviderError(
      'unsupported-capability',
      'Backend transports only support GET and POST provider requests.',
      422,
    );
  }

  let body: string | null = null;
  if (init.body !== undefined && init.body !== null) {
    if (typeof init.body !== 'string') {
      throw new GenerationProviderError(
        'unsupported-capability',
        'Backend transports only support string request bodies.',
        422,
      );
    }
    body = init.body;
  }
  if (method === 'GET' && body !== null) {
    throw new GenerationProviderError(
      'unsupported-capability',
      'GET provider requests must not contain a request body.',
      422,
    );
  }

  return {
    url: url.toString(),
    method,
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    body,
  };
}
