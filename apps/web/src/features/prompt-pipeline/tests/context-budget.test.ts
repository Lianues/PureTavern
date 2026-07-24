import { describe, expect, it } from 'vitest';

import { createPromptPipelineModule } from '../module';
import type { MessageTokenizer } from '../ports/context-budget-service';

const tenTokensPerMessage: MessageTokenizer = {
  id: 'fixture-exact-tokenizer',
  countMessages: (messages) => messages.length * 10,
};

describe('ContextBudgetService integration', () => {
  it('uses an injected tokenizer and trims oldest history before newer history', async () => {
    const { assembler } = createPromptPipelineModule({
      tokenizer: tenTokensPerMessage,
      expectedProviderKinds: [],
    });
    const result = await assembler.assemble({
      systemPrompt: { content: 'required' },
      messages: [
        { role: 'user', content: 'oldest', id: 1 },
        { role: 'assistant', content: 'middle', id: 2 },
        { role: 'user', content: 'newest', id: 3 },
      ],
      budget: { maxContextTokens: 20, reservedResponseTokens: 0 },
    });

    expect(result.messages.map((message) => message.content)).toEqual(['required', 'newest']);
    expect(result.budget).toMatchObject({
      precision: 'exact',
      estimator: 'fixture-exact-tokenizer',
      promptTokens: 20,
      overflowTokens: 0,
    });
    expect(result.budget?.removed.map((item) => item.candidate.id)).toEqual([
      'history:0',
      'history:1',
    ]);
  });

  it('labels fallback estimates approximate and emits estimator diagnostics', async () => {
    const { assembler } = createPromptPipelineModule({ expectedProviderKinds: [] });
    const result = await assembler.assemble({
      messages: [{ role: 'user', content: 'short text' }],
      budget: { maxContextTokens: 1_000, reservedResponseTokens: 100 },
    });

    expect(result.budget?.precision).toBe('approximate');
    expect(result.budget?.estimator).toBe('approximate-character-ratio-v1');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'budget.approximate-estimator' })]),
    );
  });

  it('falls back explicitly when an injected tokenizer fails', async () => {
    const { assembler } = createPromptPipelineModule({
      expectedProviderKinds: [],
      tokenizer: {
        id: 'broken-tokenizer',
        countMessages: () => {
          throw new Error('M15 unavailable');
        },
      },
    });
    const result = await assembler.assemble({
      messages: [{ role: 'user', content: 'hello' }],
      budget: { maxContextTokens: 100, reservedResponseTokens: 10 },
    });

    expect(result.budget?.precision).toBe('approximate');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'budget.tokenizer-failed' }),
        expect.objectContaining({ code: 'budget.approximate-estimator' }),
      ]),
    );
  });
});
