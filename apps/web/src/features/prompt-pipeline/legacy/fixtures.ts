import type { LegacyConformanceFixture } from './conformance-adapter';

/**
 * Hand-authored smoke fixtures. Replace legacyOutput with captured upstream
 * output in the serial conformance gate before ownership can move.
 */
export const legacyPromptConformanceFixtures: readonly LegacyConformanceFixture[] = [
  {
    id: 'ordered-system-and-history-smoke',
    description: 'Main prompt, relative instruction and opaque chat history ordering.',
    input: {
      messages: [
        { role: 'user', content: 'Hello', legacyMessageId: 7 },
        { role: 'assistant', content: 'Hi', legacyMessageId: 8 },
      ],
      prompts: [
        { identifier: 'main', role: 'system', content: 'You are {{char}}.' },
        { identifier: 'jailbreak', role: 'system', content: 'Stay in character.' },
      ],
      promptOrder: [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'jailbreak', enabled: true },
      ],
      macroContext: { character: 'Ava' },
    },
    legacyOutput: {
      messages: [
        { role: 'system', content: 'You are Ava.' },
        { role: 'user', content: 'Hello', legacyMessageId: 7 },
        { role: 'assistant', content: 'Hi', legacyMessageId: 8 },
        { role: 'system', content: 'Stay in character.' },
      ],
    },
  },
];
