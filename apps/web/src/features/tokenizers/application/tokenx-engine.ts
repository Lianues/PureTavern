import { estimateTokenCount, splitByTokens } from 'tokenx';

import { TOKENIZER_LIMITS, type TokenAnalysis } from '../domain/tokenizer';

export interface TokenAnalysisEngine {
  readonly id: string;
  initialize?(): Promise<void> | void;
  count(text: string): Promise<number> | number;
  analyze(text: string): Promise<TokenAnalysis> | TokenAnalysis;
}

export class TokenxAnalysisEngine implements TokenAnalysisEngine {
  readonly id = 'main-thread-tokenx';

  count(text: string): number {
    return countWithTokenx(text);
  }

  analyze(text: string): TokenAnalysis {
    return analyzeWithTokenx(text);
  }
}

export class CharacterFallbackAnalysisEngine implements TokenAnalysisEngine {
  readonly id = 'character-fallback';

  count(text: string): number {
    if (!text) return 0;
    // This fallback is intentionally constant-time so a failed Worker can never move a long task
    // onto the UI thread. Exact Unicode code-point accounting is not required for this degraded path.
    return Math.max(1, Math.ceil(text.length / 4));
  }

  analyze(text: string): TokenAnalysis {
    if (!text) return { count: 0, chunks: [] };
    const characters = [...text];
    const count = Math.max(1, Math.ceil(characters.length / 4));
    const chunks: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const start = Math.floor((index * characters.length) / count);
      const end = Math.floor(((index + 1) * characters.length) / count);
      chunks.push(characters.slice(start, Math.max(start + 1, end)).join(''));
    }
    return { count, chunks };
  }
}

export function countWithTokenx(text: string): number {
  assertTokenizerText(text);
  return Math.max(0, Math.trunc(estimateTokenCount(text)));
}

export function analyzeWithTokenx(text: string): TokenAnalysis {
  const count = countWithTokenx(text);
  if (count > TOKENIZER_LIMITS.maxPseudoTokens) {
    throw new RangeError(
      `Estimated token count exceeds ${TOKENIZER_LIMITS.maxPseudoTokens.toLocaleString('en')} tokens.`,
    );
  }
  const chunks = normalizePseudoChunks(text, count, splitByTokens(text, 1));
  return { count, chunks };
}

function normalizePseudoChunks(text: string, count: number, input: readonly string[]): string[] {
  if (count === 0) return [];

  // tokenx's split count is not guaranteed to equal its estimate. The previous implementation
  // filled that gap one chunk at a time and rescanned the entire growing array on every pass,
  // turning ordinary 50k-character prompts into multi-second O(n²) work. Preserve tokenx's
  // chunks when they already satisfy the pseudo-encoding contract; otherwise partition once.
  if (input.length === count && input.join('') === text) return [...input];
  return partitionTextExactly(text, count);
}

function partitionTextExactly(text: string, count: number): string[] {
  const characters = [...text];
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index * characters.length) / count);
    const end = Math.floor(((index + 1) * characters.length) / count);
    return characters.slice(start, end).join('');
  });
}

export function assertTokenizerText(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new TypeError('Tokenizer text must be a string.');
  if (value.length > TOKENIZER_LIMITS.maxTextCharacters) {
    throw new RangeError(
      `Tokenizer text exceeds ${TOKENIZER_LIMITS.maxTextCharacters.toLocaleString('en')} characters.`,
    );
  }
}
