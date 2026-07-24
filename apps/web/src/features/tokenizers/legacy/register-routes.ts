import type { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import {
  jsonResponse,
  syncJsonResponse,
  type SynchronousCompatibilityResponse,
} from '@/platform/legacy/compatibility-router';

import type { TokenizerPort } from '../ports/tokenizer-port';

export const TOKENIZER_ALIASES = Object.freeze([
  'gpt2',
  'openai',
  'llama',
  'nerdstash',
  'nerdstash_v2',
  'mistral',
  'yi',
  'claude',
  'llama3',
  'gemma',
  'jamba',
  'qwen2',
  'command-r',
  'command-a',
  'nemo',
  'deepseek',
]);

export function registerTokenizerLegacyRoutes(
  router: CompatibilityRouter,
  tokenizer: TokenizerPort,
): void {
  for (const alias of TOKENIZER_ALIASES) {
    const encodePath = `/api/tokenizers/${alias}/encode`;
    const decodePath = `/api/tokenizers/${alias}/decode`;
    router.register('POST', encodePath, async (request) => {
      try {
        await tokenizer.ready;
        const body = await readJsonRequest(request);
        return jsonResponse(legacyEncoding(await tokenizer.encode(readText(body))));
      } catch (error) {
        return tokenizerErrorResponse(error);
      }
    });
    router.register('POST', decodePath, async (request) => {
      try {
        await tokenizer.ready;
        const body = await readJsonRequest(request);
        return jsonResponse(legacyDecoding(await tokenizer.decode(readIds(body))));
      } catch (error) {
        return tokenizerErrorResponse(error);
      }
    });
    router.registerSync('POST', encodePath, (body) =>
      syncTokenizerResponse(() =>
        legacyEncoding(tokenizer.encodeSync(readText(readJsonText(body)))),
      ),
    );
    router.registerSync('POST', decodePath, (body) =>
      syncTokenizerResponse(() =>
        legacyDecoding(tokenizer.decodeSync(readIds(readJsonText(body)))),
      ),
    );
  }

  router.register('POST', '/api/tokenizers/openai/count', async (request) => {
    try {
      await tokenizer.ready;
      return jsonResponse(
        legacyMessageCount(await tokenizer.countMessages(await readJsonRequest(request))),
      );
    } catch (error) {
      return tokenizerErrorResponse(error);
    }
  });
  router.registerSync('POST', '/api/tokenizers/openai/count', (body) => {
    try {
      const serialized = serializeMessageBody(readJsonText(body));
      return syncJsonResponse(legacyMessageCount(tokenizer.countTextSync(serialized)));
    } catch (error) {
      return syncTokenizerErrorResponse(error);
    }
  });

  for (const path of [
    '/api/tokenizers/remote/kobold/count',
    '/api/tokenizers/remote/textgenerationwebui/encode',
  ]) {
    router.register('POST', path, async (request) => {
      try {
        await tokenizer.ready;
        const body = await readJsonRequest(request);
        return jsonResponse(legacyEncoding(await tokenizer.encode(readText(body))));
      } catch (error) {
        return tokenizerErrorResponse(error);
      }
    });
    router.registerSync('POST', path, (body) =>
      syncTokenizerResponse(() =>
        legacyEncoding(tokenizer.encodeSync(readText(readJsonText(body)))),
      ),
    );
  }
}

function legacyEncoding(result: Awaited<ReturnType<TokenizerPort['encode']>>) {
  return {
    ids: result.ids,
    count: result.count,
    chunks: result.chunks,
    approximate: true,
    precision: result.precision,
    tokenizer: result.tokenizer,
    backend: result.backend,
  };
}

function legacyDecoding(result: Awaited<ReturnType<TokenizerPort['decode']>>) {
  return {
    text: result.text,
    chunks: result.chunks,
    approximate: true,
    precision: result.precision,
    tokenizer: result.tokenizer,
    supported: result.supported,
  };
}

function legacyMessageCount(result: Awaited<ReturnType<TokenizerPort['countMessages']>>) {
  return {
    token_count: result.count,
    approximate: true,
    precision: result.precision,
    tokenizer: result.tokenizer,
    backend: result.backend,
  };
}

async function readJsonRequest(request: Request): Promise<Record<string, unknown> | unknown[]> {
  return validateJsonBody((await request.json()) as unknown);
}

function readJsonText(body: string | null): Record<string, unknown> | unknown[] {
  return validateJsonBody(JSON.parse(body || '{}') as unknown);
}

function validateJsonBody(value: unknown): Record<string, unknown> | unknown[] {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Tokenizer request body must be a JSON object or array.');
  }
  return value as Record<string, unknown> | unknown[];
}

function readText(body: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(body)) return serializeMessageBody(body);
  return typeof body.text === 'string' ? body.text : '';
}

function readIds(body: Record<string, unknown> | unknown[]): number[] {
  const ids = !Array.isArray(body) && Array.isArray(body.ids) ? body.ids : [];
  if (ids.some((id) => !Number.isSafeInteger(id))) {
    throw new TypeError('Tokenizer ids must contain only safe integers.');
  }
  return ids as number[];
}

function serializeMessageBody(value: unknown): string {
  const strings: string[] = [];
  collectStrings(value, strings, new Set<object>(), 0);
  return strings.join('\n');
}

function collectStrings(value: unknown, output: string[], seen: Set<object>, depth: number): void {
  if (depth > 32 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output, seen, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output.push(key);
    collectStrings(child, output, seen, depth + 1);
  }
}

function syncTokenizerResponse(factory: () => unknown): SynchronousCompatibilityResponse {
  try {
    return syncJsonResponse(factory());
  } catch (error) {
    return syncTokenizerErrorResponse(error);
  }
}

function tokenizerErrorResponse(error: unknown): Response {
  const status = error instanceof RangeError ? 413 : error instanceof TypeError ? 400 : 500;
  return jsonResponse(
    {
      error: error instanceof Error ? error.message : String(error),
      approximate: true,
      tokenizer: 'tokenx',
      pureTavern: true,
    },
    status,
  );
}

function syncTokenizerErrorResponse(error: unknown): SynchronousCompatibilityResponse {
  const status = error instanceof RangeError ? 413 : error instanceof TypeError ? 400 : 500;
  return syncJsonResponse(
    {
      error: error instanceof Error ? error.message : String(error),
      approximate: true,
      tokenizer: 'tokenx',
      pureTavern: true,
    },
    status,
  );
}
