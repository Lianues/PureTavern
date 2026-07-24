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

  it('falls back to the character estimator when tokenx throws', async () => {
    const failing: TokenAnalysisEngine = {
      id: 'failing-tokenx',
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

  it('falls back from a failed Worker initialization to main-thread tokenx', async () => {
    const worker: TokenAnalysisEngine = {
      id: 'worker-tokenx',
      async initialize() {
        throw new Error('worker blocked');
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
