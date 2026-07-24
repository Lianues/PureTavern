import type {
  AssemblePromptInput,
  AssemblePromptResult,
  MacroContext,
  OpaqueChatMessage,
  PromptBlock,
  PromptRole,
} from '../domain/prompt-pipeline';
import type { PromptAssembler } from '../ports/prompt-assembler';
import { promptStageIds } from '../application/default-stages';

export interface LegacyPromptRecord {
  readonly identifier: string;
  readonly role?: PromptRole;
  readonly content?: string;
  readonly enabled?: boolean;
  readonly injectionPosition?: 'relative' | 'in-chat';
  readonly injectionDepth?: number;
  readonly injectionOrder?: number;
}

export interface LegacyPromptOrderEntry {
  readonly identifier: string;
  readonly enabled: boolean;
}

export interface LegacyConformanceInput {
  readonly messages: readonly OpaqueChatMessage[];
  readonly prompts: readonly LegacyPromptRecord[];
  readonly promptOrder: readonly LegacyPromptOrderEntry[];
  readonly macroContext?: MacroContext;
}

export interface LegacyComparableOutput {
  readonly messages: readonly OpaqueChatMessage[];
}

export interface LegacyConformanceFixture {
  readonly id: string;
  readonly description: string;
  readonly input: LegacyConformanceInput;
  /** Captured from an independently executed legacy flow by the serial gate owner. */
  readonly legacyOutput: LegacyComparableOutput;
}

export interface ConformanceComparison {
  readonly equal: boolean;
  readonly modern: string;
  readonly legacy: string;
  readonly firstDifferentMessage: number | null;
}

const legacyStageByIdentifier: Readonly<Record<string, string>> = {
  main: promptStageIds.system,
  worldInfoBefore: promptStageIds.worldBefore,
  personaDescription: promptStageIds.character,
  charDescription: promptStageIds.character,
  charPersonality: promptStageIds.character,
  scenario: promptStageIds.character,
  nsfw: promptStageIds.instruction,
  worldInfoAfter: promptStageIds.worldAfter,
  dialogueExamples: promptStageIds.custom,
  jailbreak: promptStageIds.control,
  authorsNote: promptStageIds.authorNote,
};

function canonicalize(value: unknown): unknown {
  if (value === undefined) return { $type: 'undefined' };
  if (typeof value === 'bigint') return { $type: 'bigint', value: String(value) };
  if (typeof value === 'function') return { $type: 'function', value: String(value) };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalize(item)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export function comparablePromptOutput(messages: readonly OpaqueChatMessage[]): string {
  return JSON.stringify(canonicalize(messages), null, 2);
}

/**
 * Offline comparison helper only. It does not import, call, patch or replace the
 * legacy prompt generator.
 */
export class LegacyPromptConformanceAdapter {
  constructor(private readonly assembler: PromptAssembler) {}

  toModernInput(input: LegacyConformanceInput): AssemblePromptInput {
    const records = new Map(input.prompts.map((prompt) => [prompt.identifier, prompt]));
    const blocks: PromptBlock[] = [];
    input.promptOrder.forEach((entry, order) => {
      if (!entry.enabled || entry.identifier === 'chatHistory') return;
      const prompt = records.get(entry.identifier);
      if (!prompt || prompt.enabled === false || !prompt.content) return;
      blocks.push({
        id: prompt.identifier,
        stage: legacyStageByIdentifier[prompt.identifier] ?? promptStageIds.custom,
        message: { role: prompt.role ?? 'system', content: prompt.content },
        order,
        priority: prompt.injectionOrder ?? 100,
        required: true,
        source: 'legacy-conformance-fixture',
        injection:
          prompt.injectionPosition === 'in-chat'
            ? { kind: 'in-chat', depth: prompt.injectionDepth ?? 0 }
            : { kind: 'absolute' },
      });
    });

    const base: AssemblePromptInput = { messages: input.messages, blocks };
    return input.macroContext ? { ...base, macroContext: input.macroContext } : base;
  }

  async run(fixture: LegacyConformanceFixture): Promise<AssemblePromptResult> {
    return this.assembler.assemble(this.toModernInput(fixture.input));
  }

  compare(
    modernMessages: readonly OpaqueChatMessage[],
    legacyOutput: LegacyComparableOutput,
  ): ConformanceComparison {
    const modern = comparablePromptOutput(modernMessages);
    const legacy = comparablePromptOutput(legacyOutput.messages);
    const length = Math.max(modernMessages.length, legacyOutput.messages.length);
    let firstDifferentMessage: number | null = null;
    for (let index = 0; index < length; index += 1) {
      if (
        comparablePromptOutput(modernMessages.slice(index, index + 1)) !==
        comparablePromptOutput(legacyOutput.messages.slice(index, index + 1))
      ) {
        firstDifferentMessage = index;
        break;
      }
    }
    return { equal: modern === legacy, modern, legacy, firstDifferentMessage };
  }
}
