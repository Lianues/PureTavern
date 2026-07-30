import {
  TOKENIZER_LIMITS,
  type TokenAnalysis,
  type TokenCountResult,
  type TokenDecodingResult,
  type TokenEncodingResult,
  type TokenizerBackend,
  type TokenizerDiagnostics,
} from '../domain/tokenizer';
import type { TokenizerPort } from '../ports/tokenizer-port';
import {
  assertTokenizerText,
  CharacterFallbackAnalysisEngine,
  TokenxAnalysisEngine,
  type TokenAnalysisEngine,
} from './tokenx-engine';

interface DecodeCacheEntry {
  text: string;
  chunks: string[];
  characters: number;
}

export interface TokenizerServiceOptions {
  primary?: TokenAnalysisEngine | null;
  tokenx?: TokenAnalysisEngine;
  fallback?: TokenAnalysisEngine;
  /** Never replay an asynchronous Worker count with tokenx on the UI thread. */
  nonBlockingCount?: boolean;
}

export class TokenizerService implements TokenizerPort {
  readonly diagnostics: TokenizerDiagnostics;
  readonly ready: Promise<void>;

  #primary: TokenAnalysisEngine | null;
  readonly #tokenx: TokenAnalysisEngine;
  readonly #fallback: TokenAnalysisEngine;
  readonly #nonBlockingCount: boolean;
  readonly #decodeCache = new Map<string, DecodeCacheEntry>();
  #cachedCharacters = 0;

  constructor(options: TokenizerServiceOptions = {}) {
    this.#primary = options.primary ?? null;
    this.#tokenx = options.tokenx ?? new TokenxAnalysisEngine();
    this.#fallback = options.fallback ?? new CharacterFallbackAnalysisEngine();
    this.#nonBlockingCount = options.nonBlockingCount ?? false;
    this.diagnostics = {
      status: 'pending',
      backend: this.#primary ? 'worker-tokenx' : 'main-thread-tokenx',
      precision: 'approximate',
      library: 'tokenx',
      libraryVersion: '1.3.0',
      message: null,
      requests: 0,
      workerFailures: 0,
      tokenxFailures: 0,
      fallbackRequests: 0,
      lastCount: null,
      lastUpdatedAt: null,
    };
    this.ready = this.#initialize();
  }

  async countText(text: string): Promise<TokenCountResult> {
    assertTokenizerText(text);
    await this.ready;
    const { count, backend } = await this.#count(text);
    return this.#countResult(count, backend);
  }

  async countMessages(messages: unknown): Promise<TokenCountResult> {
    return this.countText(serializeMessageStrings(messages));
  }

  async encode(text: string): Promise<TokenEncodingResult> {
    assertTokenizerText(text);
    await this.ready;
    const { analysis, backend } = await this.#analyze(text);
    return this.#encodingResult(text, analysis, backend);
  }

  async decode(ids: readonly number[]): Promise<TokenDecodingResult> {
    await this.ready;
    return this.decodeSync(ids);
  }

  countTextSync(text: string): TokenCountResult {
    assertTokenizerText(text);
    const { count, backend } = this.#countSync(text);
    return this.#countResult(count, backend);
  }

  encodeSync(text: string): TokenEncodingResult {
    assertTokenizerText(text);
    const { analysis, backend } = this.#analyzeSync(text);
    return this.#encodingResult(text, analysis, backend);
  }

  decodeSync(ids: readonly number[]): TokenDecodingResult {
    const normalized = normalizeTokenIds(ids);
    const cached = this.#decodeCache.get(cacheKey(normalized));
    if (!cached) {
      return {
        text: '',
        chunks: [],
        precision: 'approximate',
        tokenizer: 'tokenx',
        supported: false,
      };
    }
    this.#decodeCache.delete(cacheKey(normalized));
    this.#decodeCache.set(cacheKey(normalized), cached);
    return {
      text: cached.text,
      chunks: [...cached.chunks],
      precision: 'approximate',
      tokenizer: 'tokenx',
      supported: true,
    };
  }

  async #initialize(): Promise<void> {
    if (this.#primary?.initialize) {
      try {
        await this.#primary.initialize();
        this.diagnostics.backend = 'worker-tokenx';
        this.diagnostics.status = 'ready';
        return;
      } catch (error) {
        this.diagnostics.workerFailures += 1;
        this.diagnostics.message = error instanceof Error ? error.message : String(error);
        this.#primary = null;
      }
    }
    try {
      await this.#tokenx.initialize?.();
      this.diagnostics.backend = 'main-thread-tokenx';
      this.diagnostics.status = this.diagnostics.workerFailures ? 'degraded' : 'ready';
    } catch (error) {
      this.diagnostics.tokenxFailures += 1;
      this.diagnostics.backend = 'character-fallback';
      this.diagnostics.status = 'degraded';
      this.diagnostics.message = error instanceof Error ? error.message : String(error);
    }
  }

  async #count(text: string): Promise<{ count: number; backend: TokenizerBackend }> {
    this.diagnostics.requests += 1;
    if (this.#primary) {
      try {
        return { count: await this.#primary.count(text), backend: 'worker-tokenx' };
      } catch (error) {
        this.diagnostics.workerFailures += 1;
        this.diagnostics.status = 'degraded';
        this.diagnostics.message = error instanceof Error ? error.message : String(error);
        this.#primary = null;
        if (this.#nonBlockingCount) return this.#fallbackCount(text);
      }
    } else if (this.#nonBlockingCount) {
      this.diagnostics.status = 'degraded';
      this.diagnostics.message ??=
        'Tokenizer Worker is unavailable; using non-blocking character fallback.';
      return this.#fallbackCount(text);
    }

    try {
      return {
        count: await this.#tokenx.count(text),
        backend: 'main-thread-tokenx',
      };
    } catch (error) {
      this.diagnostics.tokenxFailures += 1;
      this.diagnostics.status = 'degraded';
      this.diagnostics.message = error instanceof Error ? error.message : String(error);
      return this.#fallbackCount(text);
    }
  }

  async #fallbackCount(text: string): Promise<{ count: number; backend: TokenizerBackend }> {
    this.diagnostics.fallbackRequests += 1;
    this.diagnostics.status = 'degraded';
    return {
      count: await this.#fallback.count(text),
      backend: 'character-fallback',
    };
  }

  #countSync(text: string): { count: number; backend: TokenizerBackend } {
    this.diagnostics.requests += 1;
    try {
      const count = this.#tokenx.count(text);
      if (count instanceof Promise) {
        throw new TypeError('The synchronous tokenx count engine returned a Promise.');
      }
      return { count, backend: 'main-thread-tokenx' };
    } catch (error) {
      this.diagnostics.tokenxFailures += 1;
      this.diagnostics.fallbackRequests += 1;
      this.diagnostics.status = 'degraded';
      this.diagnostics.backend = 'character-fallback';
      this.diagnostics.message = error instanceof Error ? error.message : String(error);
      const count = this.#fallback.count(text);
      if (count instanceof Promise) {
        throw new TypeError('The synchronous fallback count engine returned a Promise.', {
          cause: error,
        });
      }
      return { count, backend: 'character-fallback' };
    }
  }

  async #analyze(text: string): Promise<{ analysis: TokenAnalysis; backend: TokenizerBackend }> {
    this.diagnostics.requests += 1;
    if (this.#primary) {
      try {
        return { analysis: await this.#primary.analyze(text), backend: 'worker-tokenx' };
      } catch (error) {
        this.diagnostics.workerFailures += 1;
        this.diagnostics.status = 'degraded';
        this.diagnostics.message = error instanceof Error ? error.message : String(error);
        this.#primary = null;
      }
    }
    try {
      return {
        analysis: await this.#tokenx.analyze(text),
        backend: 'main-thread-tokenx',
      };
    } catch (error) {
      this.diagnostics.tokenxFailures += 1;
      this.diagnostics.fallbackRequests += 1;
      this.diagnostics.status = 'degraded';
      this.diagnostics.backend = 'character-fallback';
      this.diagnostics.message = error instanceof Error ? error.message : String(error);
      return {
        analysis: await this.#fallback.analyze(text),
        backend: 'character-fallback',
      };
    }
  }

  #analyzeSync(text: string): { analysis: TokenAnalysis; backend: TokenizerBackend } {
    this.diagnostics.requests += 1;
    try {
      const result = this.#tokenx.analyze(text);
      if (result instanceof Promise) {
        throw new TypeError('The synchronous tokenx engine returned a Promise.');
      }
      return { analysis: result, backend: 'main-thread-tokenx' };
    } catch (error) {
      this.diagnostics.tokenxFailures += 1;
      this.diagnostics.fallbackRequests += 1;
      this.diagnostics.status = 'degraded';
      this.diagnostics.backend = 'character-fallback';
      this.diagnostics.message = error instanceof Error ? error.message : String(error);
      const fallback = this.#fallback.analyze(text);
      if (fallback instanceof Promise) {
        throw new TypeError('The synchronous fallback tokenizer returned a Promise.', {
          cause: error,
        });
      }
      return { analysis: fallback, backend: 'character-fallback' };
    }
  }

  #encodingResult(
    text: string,
    analysis: TokenAnalysis,
    backend: TokenizerBackend,
  ): TokenEncodingResult {
    const ids = analysis.chunks.map((chunk, index) => pseudoTokenId(chunk, index, text.length));
    this.#remember(ids, text, analysis.chunks);
    this.#updateDiagnostics(analysis.count, backend);
    return {
      ids,
      count: analysis.count,
      chunks: [...analysis.chunks],
      precision: 'approximate',
      tokenizer: 'tokenx',
      backend,
    };
  }

  #countResult(count: number, backend: TokenizerBackend): TokenCountResult {
    this.#updateDiagnostics(count, backend);
    return { count, precision: 'approximate', tokenizer: 'tokenx', backend };
  }

  #updateDiagnostics(count: number, backend: TokenizerBackend): void {
    this.diagnostics.backend = backend;
    if (this.diagnostics.status === 'pending') this.diagnostics.status = 'ready';
    this.diagnostics.lastCount = count;
    this.diagnostics.lastUpdatedAt = new Date().toISOString();
  }

  #remember(ids: readonly number[], text: string, chunks: readonly string[]): void {
    if (text.length > TOKENIZER_LIMITS.maxDecodeCharacters) return;
    const key = cacheKey(ids);
    const previous = this.#decodeCache.get(key);
    if (previous) this.#cachedCharacters -= previous.characters;
    this.#decodeCache.delete(key);
    this.#decodeCache.set(key, {
      text,
      chunks: [...chunks],
      characters: text.length,
    });
    this.#cachedCharacters += text.length;

    while (
      this.#decodeCache.size > TOKENIZER_LIMITS.maxDecodeEntries ||
      this.#cachedCharacters > TOKENIZER_LIMITS.maxDecodeCharacters
    ) {
      const oldestKey = this.#decodeCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.#decodeCache.get(oldestKey);
      if (oldest) this.#cachedCharacters -= oldest.characters;
      this.#decodeCache.delete(oldestKey);
    }
  }
}

export function serializeMessageStrings(value: unknown): string {
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
  } else {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output.push(key);
      collectStrings(child, output, seen, depth + 1);
    }
  }
}

function normalizeTokenIds(ids: readonly number[]): number[] {
  if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id))) {
    throw new TypeError('Tokenizer ids must be an array of safe integers.');
  }
  if (ids.length > TOKENIZER_LIMITS.maxPseudoTokens) {
    throw new RangeError('Tokenizer id array exceeds the pseudo token limit.');
  }
  return [...ids];
}

function pseudoTokenId(chunk: string, index: number, textLength: number): number {
  let hash = 0x811c9dc5;
  const input = `${index}:${textLength}:${chunk}`;
  for (let cursor = 0; cursor < input.length; cursor += 1) {
    hash ^= input.charCodeAt(cursor);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function cacheKey(ids: readonly number[]): string {
  return ids.join(',');
}
