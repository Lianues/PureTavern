export type TokenizerPrecision = 'approximate';
export type TokenizerBackend = 'worker-tokenx' | 'main-thread-tokenx' | 'character-fallback';

export interface TokenCountResult {
  count: number;
  precision: TokenizerPrecision;
  tokenizer: 'tokenx';
  backend: TokenizerBackend;
}

export interface TokenEncodingResult extends TokenCountResult {
  ids: number[];
  chunks: string[];
}

export interface TokenDecodingResult {
  text: string;
  chunks: string[];
  precision: TokenizerPrecision;
  tokenizer: 'tokenx';
  supported: boolean;
}

export interface TokenizerDiagnostics {
  status: 'pending' | 'ready' | 'degraded';
  backend: TokenizerBackend;
  precision: TokenizerPrecision;
  library: 'tokenx';
  libraryVersion: '1.3.0';
  message: string | null;
  requests: number;
  workerFailures: number;
  tokenxFailures: number;
  fallbackRequests: number;
  lastCount: number | null;
  lastUpdatedAt: string | null;
}

export interface TokenAnalysis {
  count: number;
  chunks: string[];
}

export const TOKENIZER_LIMITS = Object.freeze({
  maxTextCharacters: 2_000_000,
  maxPseudoTokens: 250_000,
  maxDecodeEntries: 128,
  maxDecodeCharacters: 4_000_000,
});
