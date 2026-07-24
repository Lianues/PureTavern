import {
  GenerationProviderError,
  readRequiredString,
  type LegacyGenerationRequest,
  type ProviderModel,
} from '../../domain/provider';

export function readMessages(request: LegacyGenerationRequest): Record<string, unknown>[] {
  if (!Array.isArray(request.messages)) {
    throw new GenerationProviderError(
      'invalid-request',
      'Chat completion messages are required.',
      400,
    );
  }
  return request.messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new GenerationProviderError(
        'invalid-request',
        'Chat completion message is invalid.',
        400,
      );
    }
    return { ...(message as Record<string, unknown>) };
  });
}

export function readModel(request: LegacyGenerationRequest): string {
  return readRequiredString(request.model, 'Model');
}

export function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    const result: string[] = [];
    for (const part of message.content) {
      if (typeof part === 'string') result.push(part);
      else if (
        part &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        result.push((part as { text: string }).text);
      } else {
        throw new GenerationProviderError(
          'unsupported-capability',
          'This provider adapter currently supports text content parts only.',
          422,
        );
      }
    }
    return result.join('');
  }
  throw new GenerationProviderError('invalid-request', 'Message content must contain text.', 400);
}

export function compactObject(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

export function requestInit(
  headers: HeadersInit,
  body: unknown,
  signal?: AbortSignal,
): RequestInit {
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  };
  if (signal) init.signal = signal;
  return init;
}

export function getRequest(signal?: AbortSignal, headers?: HeadersInit): RequestInit {
  const init: RequestInit = { method: 'GET' };
  if (headers) init.headers = headers;
  if (signal) init.signal = signal;
  return init;
}

export async function requireOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  throw new GenerationProviderError(
    'provider-error',
    `The provider returned HTTP ${response.status}.`,
    response.status >= 400 && response.status <= 599 ? response.status : 502,
  );
}

export async function parseJson(response: Response): Promise<Record<string, unknown>> {
  await requireOk(response);
  try {
    const value = (await response.json()) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
    return value as Record<string, unknown>;
  } catch (error) {
    throw new GenerationProviderError(
      'invalid-response',
      'The provider returned invalid JSON.',
      502,
      { cause: error },
    );
  }
}

export function normalizeModels(value: unknown): ProviderModel[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((model) => {
      if (typeof model === 'string') return { id: model };
      if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
      const record = model as Record<string, unknown>;
      const id =
        typeof record.id === 'string'
          ? record.id
          : typeof record.name === 'string'
            ? record.name
            : null;
      return id ? { ...record, id } : null;
    })
    .filter((model): model is ProviderModel => model !== null);
}
