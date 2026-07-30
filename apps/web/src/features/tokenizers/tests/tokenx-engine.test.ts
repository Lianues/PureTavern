import { describe, expect, it } from 'vitest';

import { TOKENIZER_LIMITS } from '../domain/tokenizer';
import { analyzeWithTokenx, countWithTokenx } from '../application/tokenx-engine';

const mixedHtmlUnit = '<div>你好，世界！status: true;</div>\n';

function mixedHtml(length: number): string {
  return mixedHtmlUnit.repeat(Math.ceil(length / mixedHtmlUnit.length)).slice(0, length);
}

describe('tokenx engine', () => {
  it('counts large text without applying the pseudo-encoding limit', () => {
    const text = mixedHtml(500_000);
    const count = countWithTokenx(text);

    expect(count).toBeGreaterThan(TOKENIZER_LIMITS.maxPseudoTokens);
    expect(() => analyzeWithTokenx(text)).toThrow('Estimated token count exceeds');
  });

  it('normalizes a 50k-character pseudo encoding in linear time', () => {
    const text = mixedHtml(50_000);
    const startedAt = performance.now();
    const analysis = analyzeWithTokenx(text);
    const duration = performance.now() - startedAt;

    expect(analysis.chunks).toHaveLength(analysis.count);
    expect(analysis.chunks.join('')).toBe(text);
    expect(duration).toBeLessThan(1_000);
  }, 2_000);
});
