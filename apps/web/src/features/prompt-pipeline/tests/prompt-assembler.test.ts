import { describe, expect, it } from 'vitest';

import { createPromptPipelineModule } from '../module';
import type { PipelineStepProvider } from '../ports/pipeline-step-provider';

const noOptionalProviders = {
  expectedProviderKinds: [] as const,
};

describe('DeterministicPromptAssembler', () => {
  it('orders injected system, World Book, instruction, author note and role messages', async () => {
    const worldBooks: PipelineStepProvider = {
      id: 'fixture-world-books',
      kind: 'world-books',
      provide: () => ({
        blocks: [
          {
            id: 'world-before',
            stage: 'world-before',
            message: { role: 'system', content: 'World lore' },
            source: 'fixture-world-books',
          },
        ],
      }),
    };
    const { assembler } = createPromptPipelineModule({
      providers: [worldBooks],
      expectedProviderKinds: ['world-books'],
    });

    const result = await assembler.assemble({
      systemPrompt: { content: 'System for {{char}}' },
      instructionPrompt: { content: 'Follow format', role: 'user' },
      authorNote: {
        content: 'Author base',
        characterContent: 'Character note',
        characterPosition: 'before',
        role: 'assistant',
        interval: 2,
        userMessageCount: 4,
      },
      messages: [{ role: 'user', content: 'History' }],
      macroContext: { character: 'Mira' },
    });

    expect(result.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'system', content: 'System for Mira' },
      { role: 'system', content: 'World lore' },
      { role: 'user', content: 'Follow format' },
      { role: 'assistant', content: 'Character note\nAuthor base' },
      { role: 'user', content: 'History' },
    ]);
  });

  it('allows stages to be disabled or deleted without disturbing remaining order', async () => {
    const { assembler } = createPromptPipelineModule(noOptionalProviders);
    const result = await assembler.assemble({
      messages: [{ role: 'user', content: 'history' }],
      blocks: [
        { id: 'world', stage: 'world-before', message: { role: 'system', content: 'world' } },
        { id: 'custom', stage: 'custom', message: { role: 'system', content: 'custom' } },
      ],
      instructionPrompt: { content: 'instruction' },
      stageOverrides: [
        { id: 'world-before', deleted: true },
        { id: 'instruction', enabled: false },
      ],
    });

    expect(result.messages.map((message) => message.content)).toEqual(['custom', 'history']);
    expect(result.stages.some((stage) => stage.id === 'world-before')).toBe(false);
    expect(result.stages.find((stage) => stage.id === 'instruction')?.enabled).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'pipeline.stage-missing',
          details: { blockId: 'world', stageId: 'world-before' },
        }),
      ]),
    );
  });

  it('injects an in-chat author note at a depth counted from newest history', async () => {
    const { assembler } = createPromptPipelineModule(noOptionalProviders);
    const result = await assembler.assemble({
      messages: [
        { role: 'user', content: 'old' },
        { role: 'assistant', content: 'middle' },
        { role: 'user', content: 'new' },
      ],
      authorNote: {
        content: 'depth note',
        position: 'in-chat',
        depth: 1,
        interval: 1,
      },
    });

    expect(result.messages.map((message) => message.content)).toEqual([
      'old',
      'middle',
      'depth note',
      'new',
    ]);
  });

  it('preserves opaque message fields while expanding only string content', async () => {
    const { assembler } = createPromptPipelineModule(noOptionalProviders);
    const toolCalls = [{ id: 'tool-1', function: { name: 'search', arguments: '{}' } }];
    const result = await assembler.assemble({
      messages: [
        {
          role: 'assistant',
          content: 'Hello {{user}}',
          tool_calls: toolCalls,
          reasoning: { encrypted: true },
          providerSpecific: 42,
        },
      ],
      macroContext: { user: 'Alex' },
    });

    expect(result.messages[0]).toEqual({
      role: 'assistant',
      content: 'Hello Alex',
      tool_calls: toolCalls,
      reasoning: { encrypted: true },
      providerSpecific: 42,
    });
    expect(result.messages[0]?.tool_calls).toBe(toolCalls);
  });

  it('degrades when optional providers are absent or fail', async () => {
    const failing: PipelineStepProvider = {
      id: 'broken-extension',
      kind: 'extensions',
      provide: () => {
        throw new Error('offline');
      },
    };
    const { assembler } = createPromptPipelineModule({ providers: [failing] });
    const result = await assembler.assemble({
      messages: [{ role: 'user', content: 'still assembled' }],
    });

    expect(result.messages).toEqual([{ role: 'user', content: 'still assembled' }]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'pipeline.provider-missing', source: 'world-books' }),
        expect.objectContaining({ code: 'pipeline.provider-missing', source: 'presets' }),
        expect.objectContaining({ code: 'pipeline.provider-failed', source: 'broken-extension' }),
      ]),
    );
  });
});
