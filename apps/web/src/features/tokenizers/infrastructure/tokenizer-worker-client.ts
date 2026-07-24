import type { TokenAnalysis } from '../domain/tokenizer';
import type { TokenAnalysisEngine } from '../application/tokenx-engine';

const PROTOCOL = 'pure-tavern-tokenizer/1';
const DEFAULT_TIMEOUT_MS = 5_000;

export interface TokenizerWorkerLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message' | 'error',
    listener: ((event: MessageEvent) => void) | ((event: ErrorEvent) => void),
  ): void;
  terminate(): void;
}

interface PendingRequest {
  resolve(result: TokenAnalysis): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export class TokenizerWorkerClient implements TokenAnalysisEngine {
  readonly id = 'worker-tokenx';
  readonly #worker: TokenizerWorkerLike;
  readonly #timeoutMs: number;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #closed = false;

  static createBrowser(timeoutMs = DEFAULT_TIMEOUT_MS): TokenizerWorkerClient | null {
    if (typeof Worker !== 'function') return null;
    return new TokenizerWorkerClient(
      new Worker('/__pure_tavern/tokenizer-worker.js', { type: 'module' }),
      timeoutMs,
    );
  }

  constructor(worker: TokenizerWorkerLike, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.#worker = worker;
    this.#timeoutMs = timeoutMs;
    worker.addEventListener('message', (event: MessageEvent | ErrorEvent) =>
      this.#onMessage(event as MessageEvent),
    );
    worker.addEventListener('error', (event: MessageEvent | ErrorEvent) => {
      const errorEvent = event as ErrorEvent;
      this.#rejectAll(new Error(errorEvent.message || 'Tokenizer Worker failed.'));
    });
  }

  async initialize(): Promise<void> {
    await this.analyze('');
  }

  analyze(text: string): Promise<TokenAnalysis> {
    if (this.#closed) return Promise.reject(new Error('Tokenizer Worker is closed.'));
    const id = this.#nextId++;
    return new Promise<TokenAnalysis>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Tokenizer Worker timed out after ${this.#timeoutMs}ms.`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      this.#worker.postMessage({ protocol: PROTOCOL, id, operation: 'analyze', text });
    });
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.terminate();
    this.#rejectAll(new Error('Tokenizer Worker was disposed.'));
  }

  #onMessage(event: MessageEvent): void {
    const response = event.data as {
      protocol?: unknown;
      id?: unknown;
      ok?: unknown;
      count?: unknown;
      chunks?: unknown;
      error?: unknown;
    };
    if (response?.protocol !== PROTOCOL || !Number.isSafeInteger(response.id)) return;
    const id = response.id as number;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timeout);
    if (
      response.ok === true &&
      typeof response.count === 'number' &&
      Array.isArray(response.chunks) &&
      response.chunks.every((chunk) => typeof chunk === 'string')
    ) {
      pending.resolve({ count: response.count, chunks: response.chunks });
      return;
    }
    pending.reject(
      new Error(typeof response.error === 'string' ? response.error : 'Tokenizer Worker failed.'),
    );
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
