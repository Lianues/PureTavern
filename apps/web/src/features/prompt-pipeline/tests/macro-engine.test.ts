import { describe, expect, it } from 'vitest';

import { DefaultMacroEngine } from '../application/default-macro-engine';
import { MemoryMacroVariableStore } from '../application/memory-variable-store';

describe('DefaultMacroEngine', () => {
  it('handles explicit escaping, nested macros and unknown preservation', () => {
    const engine = new DefaultMacroEngine();
    const result = engine.expand(
      String.raw`literal \{{user}} / {{reverse::{{user}}}} / {{notImplemented::x}}`,
      { user: 'Alex' },
    );

    expect(result.text).toBe('literal {{user}} / xelA / {{notImplemented::x}}');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'macro.unknown',
          details: expect.objectContaining({ macro: 'notImplemented' }),
        }),
      ]),
    );
  });

  it('bounds recursive values and leaves the unresolved cycle visible', () => {
    const engine = new DefaultMacroEngine({ maxDepth: 4 });
    const result = engine.expand('{{loop}}', { values: { loop: '{{loop}}' } });

    expect(result.text).toBe('{{loop}}');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'macro.recursion-cycle' })]),
    );
  });

  it('stops acyclic expansion at the configured recursion depth', () => {
    const engine = new DefaultMacroEngine({ maxDepth: 2 });
    const result = engine.expand('{{a}}', {
      values: { a: '{{b}}', b: '{{c}}', c: 'resolved too late' },
    });

    expect(result.text).toBe('{{c}}');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'macro.recursion-limit' })]),
    );
  });

  it('implements common local/global variable mutations and aliases', () => {
    const local = new MemoryMacroVariableStore();
    const global = new MemoryMacroVariableStore({ visits: 2 });
    const engine = new DefaultMacroEngine({ localVariables: local, globalVariables: global });

    const result = engine.expand(
      '{{setvar::score::4}}{{addvar::score::3}}{{incvar::score}}/' +
        '{{getvar::score}}/{{incglobalvar::visits}}/{{globalvarexists::visits}}',
    );

    expect(result.text).toBe('8/8/3/true');
    expect(local.get('score')).toBe(8);
    expect(global.get('visits')).toBe(3);
  });

  it('reports malformed source instead of swallowing it', () => {
    const result = new DefaultMacroEngine().expand('before {{user after', { user: 'Alex' });
    expect(result.text).toBe('before {{user after');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'macro.unclosed' })]),
    );
  });
});
