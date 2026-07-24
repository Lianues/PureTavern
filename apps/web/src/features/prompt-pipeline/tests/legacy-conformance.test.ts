import { describe, expect, it } from 'vitest';

import { LegacyPromptConformanceAdapter } from '../legacy/conformance-adapter';
import { legacyPromptConformanceFixtures } from '../legacy/fixtures';
import { createPromptPipelineModule } from '../module';

describe('LegacyPromptConformanceAdapter', () => {
  it('produces canonical comparable output without invoking legacy code', async () => {
    const fixture = legacyPromptConformanceFixtures[0];
    expect(fixture).toBeDefined();
    if (!fixture) return;

    const { assembler } = createPromptPipelineModule({ expectedProviderKinds: [] });
    const adapter = new LegacyPromptConformanceAdapter(assembler);
    const result = await adapter.run(fixture);
    const comparison = adapter.compare(result.messages, fixture.legacyOutput);

    expect(comparison.equal).toBe(true);
    expect(comparison.firstDifferentMessage).toBeNull();
    expect(comparison.modern).toContain('legacyMessageId');
  });

  it('locates the first differing message for serial gate reports', () => {
    const { assembler } = createPromptPipelineModule({ expectedProviderKinds: [] });
    const adapter = new LegacyPromptConformanceAdapter(assembler);
    const comparison = adapter.compare(
      [
        { role: 'system', content: 'same' },
        { role: 'user', content: 'modern' },
      ],
      {
        messages: [
          { role: 'system', content: 'same' },
          { role: 'user', content: 'legacy' },
        ],
      },
    );

    expect(comparison.equal).toBe(false);
    expect(comparison.firstDifferentMessage).toBe(1);
  });
});
