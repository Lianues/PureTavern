import { describe, expect, it } from 'vitest';

import {
  TokenizerWorkerClient,
  type TokenizerWorkerLike,
} from '../infrastructure/tokenizer-worker-client';

class FakeWorker implements TokenizerWorkerLike {
  readonly messages: unknown[] = [];
  readonly #messageListeners: ((event: MessageEvent) => void)[] = [];
  readonly #errorListeners: ((event: ErrorEvent) => void)[] = [];
  respond = true;
  terminated = false;

  postMessage(message: unknown): void {
    this.messages.push(message);
    if (!this.respond) return;
    const request = message as { protocol: string; id: number; operation: 'count' | 'analyze' };
    queueMicrotask(() => {
      const data =
        request.operation === 'count'
          ? {
              protocol: request.protocol,
              id: request.id,
              ok: true,
              count: 2,
            }
          : {
              protocol: request.protocol,
              id: request.id,
              ok: true,
              count: 2,
              chunks: ['Hello', ' world'],
            };
      for (const listener of this.#messageListeners) {
        listener(new MessageEvent('message', { data }));
      }
    });
  }

  addEventListener(
    type: 'message' | 'error',
    listener: ((event: MessageEvent) => void) | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') this.#messageListeners.push(listener as (event: MessageEvent) => void);
    else this.#errorListeners.push(listener as (event: ErrorEvent) => void);
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('TokenizerWorkerClient', () => {
  it('correlates Worker analysis requests and responses', async () => {
    const worker = new FakeWorker();
    const client = new TokenizerWorkerClient(worker, 100);

    await expect(client.analyze('Hello world')).resolves.toEqual({
      count: 2,
      chunks: ['Hello', ' world'],
    });
    expect(worker.messages).toMatchObject([{ operation: 'analyze', text: 'Hello world' }]);
    client.dispose();
    expect(worker.terminated).toBe(true);
  });

  it('returns count-only Worker responses without chunks', async () => {
    const worker = new FakeWorker();
    const client = new TokenizerWorkerClient(worker, 100);

    await expect(client.count('Hello world')).resolves.toBe(2);
    expect(worker.messages).toMatchObject([{ operation: 'count', text: 'Hello world' }]);
    client.dispose();
  });

  it('rejects a Worker request after its timeout', async () => {
    const worker = new FakeWorker();
    worker.respond = false;
    const client = new TokenizerWorkerClient(worker, 5);

    await expect(client.count('timeout')).rejects.toThrow('timed out');
    client.dispose();
  });
});
