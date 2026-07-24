import { estimateTokenCount, splitByTokens } from 'tokenx';

import { TOKENIZER_LIMITS, type TokenAnalysis } from '../domain/tokenizer';

export interface TokenAnalysisEngine {
  readonly id: string;
  initialize?(): Promise<void> | void;
  analyze(text: string): Promise<TokenAnalysis> | TokenAnalysis;
}

export class TokenxAnalysisEngine implements TokenAnalysisEngine {
  readonly id = 'main-thread-tokenx';

  analyze(text: string): TokenAnalysis {
    return analyzeWithTokenx(text);
  }
}

export class CharacterFallbackAnalysisEngine implements TokenAnalysisEngine {
  readonly id = 'character-fallback';

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

export function analyzeWithTokenx(text: string): TokenAnalysis {
  assertTokenizerText(text);
  const count = Math.max(0, Math.trunc(estimateTokenCount(text)));
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
  const chunks = input.length ? [...input] : [text];
  while (chunks.length < count) {
    let candidateIndex = -1;
    let candidateLength = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const length = [...(chunks[index] ?? '')].length;
      if (length > candidateLength) {
        candidateIndex = index;
        candidateLength = length;
      }
    }
    if (candidateIndex < 0 || candidateLength <= 1) {
      chunks.push('');
      continue;
    }
    const characters = [...(chunks[candidateIndex] ?? '')];
    const midpoint = Math.ceil(characters.length / 2);
    chunks.splice(
      candidateIndex,
      1,
      characters.slice(0, midpoint).join(''),
      characters.slice(midpoint).join(''),
    );
  }
  while (chunks.length > count) {
    const tail = chunks.pop() ?? '';
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1] ?? ''}${tail}`;
  }
  if (chunks.join('') !== text) return partitionTextExactly(text, count);
  return chunks;
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
