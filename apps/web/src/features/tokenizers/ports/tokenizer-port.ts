import type {
  TokenCountResult,
  TokenDecodingResult,
  TokenEncodingResult,
  TokenizerDiagnostics,
} from '../domain/tokenizer';

export interface TokenizerPort {
  readonly diagnostics: TokenizerDiagnostics;
  readonly ready: Promise<void>;

  countText(text: string): Promise<TokenCountResult>;
  countMessages(messages: unknown): Promise<TokenCountResult>;
  encode(text: string): Promise<TokenEncodingResult>;
  decode(ids: readonly number[]): Promise<TokenDecodingResult>;

  /** Legacy synchronous jQuery APIs cannot await a Worker. They use the same tokenx engine directly. */
  countTextSync(text: string): TokenCountResult;
  encodeSync(text: string): TokenEncodingResult;
  decodeSync(ids: readonly number[]): TokenDecodingResult;
}
