import { estimateTokenCount } from 'tokenx';
import { describe, expect, it } from 'vitest';

import { TokenizerService } from '../application/tokenizer-service';
import type { TokenAnalysisEngine } from '../application/tokenx-engine';

const samples = ['', 'Hello, world!', '你好世界', 'Hello 👋 世界'];

describe('TokenizerService', () => {
  it('uses one tokenx estimate for empty, English, CJK, emoji and mixed text', async () => {
    const service = new TokenizerService();
    await service.ready;

    for (const text of samples) {
      const result = await service.countText(text);
      expect(result).toMatchObject({
        count: estimateTokenCount(text),
        precision: 'approximate',
        tokenizer: 'tokenx',
        backend: 'main-thread-tokenx',
      });
    }
  });

  it('creates pseudo ids and decodes only entries encoded in the current session', async () => {
    const service = new TokenizerService();
    const text = 'Unified tokenx count 你好 👋 for every model.';

    const encoded = await service.encode(text);
    expect(encoded.count).toBe(estimateTokenCount(text));
    expect(encoded.ids).toHaveLength(encoded.count);
    expect(encoded.chunks).toHaveLength(encoded.count);
    expect(encoded.chunks.join('')).toBe(text);
    await expect(service.decode(encoded.ids)).resolves.toMatchObject({
      text,
      chunks: encoded.chunks,
      supported: true,
      precision: 'approximate',
    });
    await expect(service.decode([1, 2, 3])).resolves.toMatchObject({
      text: '',
      chunks: [],
      supported: false,
    });
  });

  it('counts all string fields in opaque message objects', async () => {
    const service = new TokenizerService();
    const messages = [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }], opaque: 42 },
    ];

    const result = await service.countMessages(messages);
    expect(result.count).toBeGreaterThan(estimateTokenCount('Be concise.\nHello'));
    expect(result.precision).toBe('approximate');
  });

  it('uses the Worker count operation without invoking full analysis', async () => {
    let workerCounts = 0;
    let workerAnalyses = 0;
    let mainThreadCounts = 0;
    const worker: TokenAnalysisEngine = {
      id: 'worker-tokenx',
      initialize() {},
      count() {
        workerCounts += 1;
        return 17;
      },
      analyze() {
        workerAnalyses += 1;
        return { count: 1, chunks: ['unexpected'] };
      },
    };
    const tokenx: TokenAnalysisEngine = {
      id: 'main-thread-tokenx',
      count() {
        mainThreadCounts += 1;
        return 99;
      },
      analyze() {
        return { count: 1, chunks: ['unexpected'] };
      },
    };
    const service = new TokenizerService({ primary: worker, tokenx, nonBlockingCount: true });

    await expect(service.countText('count only')).resolves.toMatchObject({
      count: 17,
      backend: 'worker-tokenx',
    });
    expect(workerCounts).toBe(1);
    expect(workerAnalyses).toBe(0);
    expect(mainThreadCounts).toBe(0);
  });

  it('never replays a failed Worker count with tokenx on the main thread', async () => {
    let mainThreadCounts = 0;
    const worker: TokenAnalysisEngine = {
      id: 'worker-tokenx',
      initialize() {},
      count() {
        throw new Error('worker count failed');
      },
      analyze() {
        throw new Error('not used');
      },
    };
    const tokenx: TokenAnalysisEngine = {
      id: 'main-thread-tokenx',
      count() {
        mainThreadCounts += 1;
        return 99;
      },
      analyze() {
        throw new Error('not used');
      },
    };
    const service = new TokenizerService({ primary: worker, tokenx, nonBlockingCount: true });

    await expect(service.countText('12345678')).resolves.toMatchObject({
      count: 2,
      backend: 'character-fallback',
    });
    expect(mainThreadCounts).toBe(0);
    expect(service.diagnostics).toMatchObject({
      status: 'degraded',
      workerFailures: 1,
      tokenxFailures: 0,
      fallbackRequests: 1,
      message: 'worker count failed',
    });
  });

  it('keeps the legacy synchronous count path count-only', () => {
    let analyses = 0;
    const tokenx: TokenAnalysisEngine = {
      id: 'main-thread-tokenx',
      count() {
        return 7;
      },
      analyze() {
        analyses += 1;
        return { count: 1, chunks: ['unexpected'] };
      },
    };
    const service = new TokenizerService({ tokenx });

    expect(service.countTextSync('count only')).toMatchObject({
      count: 7,
      backend: 'main-thread-tokenx',
    });
    expect(analyses).toBe(0);
  });

  it('falls back to the character estimator when tokenx throws', async () => {
    const failing: TokenAnalysisEngine = {
      id: 'failing-tokenx',
      count() {
        throw new Error('tokenx unavailable');
      },
      analyze() {
        throw new Error('tokenx unavailable');
      },
    };
    const service = new TokenizerService({ tokenx: failing });

    const result = await service.countText('12345678');
    expect(result).toMatchObject({ count: 2, backend: 'character-fallback' });
    expect(service.diagnostics).toMatchObject({
      status: 'degraded',
      tokenxFailures: 1,
      fallbackRequests: 1,
      message: 'tokenx unavailable',
    });
  });

  it('falls back from a failed Worker initialization to main-thread tokenx when allowed', async () => {
    const worker: TokenAnalysisEngine = {
      id: 'worker-tokenx',
      async initialize() {
        throw new Error('worker blocked');
      },
      count() {
        throw new Error('should not be called');
      },
      analyze() {
        throw new Error('should not be called');
      },
    };
    const service = new TokenizerService({ primary: worker });
    await service.ready;

    const result = await service.countText('Worker fallback');
    expect(result.backend).toBe('main-thread-tokenx');
    expect(service.diagnostics).toMatchObject({
      status: 'degraded',
      workerFailures: 1,
      message: 'worker blocked',
    });
  });
});
