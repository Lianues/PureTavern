import type {
  AssemblePromptInput,
  AssemblePromptResult,
  AssembledPromptBlock,
  AuthorNoteInput,
  BudgetCandidate,
  MacroContext,
  OpaqueChatMessage,
  PipelineDiagnostic,
  PipelineStage,
  PromptBlock,
  PromptTemplateInput,
} from '../domain/prompt-pipeline';
import type { ContextBudgetService } from '../ports/context-budget-service';
import type { MacroEngine } from '../ports/macro-engine';
import type { PromptAssembler } from '../ports/prompt-assembler';
import type {
  PipelineProviderContribution,
  PipelineProviderKind,
  PipelineStepProvider,
} from '../ports/pipeline-step-provider';
import { defaultPromptStages, promptStageIds } from './default-stages';

const providerKindOrder: Readonly<Record<PipelineProviderKind, number>> = {
  'world-books': 100,
  presets: 200,
  extensions: 300,
};

const roleOrder: Readonly<Record<string, number>> = {
  system: 100,
  user: 200,
  assistant: 300,
  tool: 400,
};

export interface DeterministicPromptAssemblerOptions {
  readonly macroEngine: MacroEngine;
  readonly budgetService: ContextBudgetService;
  readonly providers?: readonly PipelineStepProvider[];
  readonly expectedProviderKinds?: readonly PipelineProviderKind[];
}

interface ProviderData {
  readonly contribution: PipelineProviderContribution;
  readonly provider: PipelineStepProvider;
}

interface OrderedBlock {
  readonly block: AssembledPromptBlock;
  readonly stageOrder: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stageCopy(stage: PipelineStage): PipelineStage {
  const description = stage.description;
  return description
    ? { id: stage.id, order: stage.order, enabled: stage.enabled, description }
    : { id: stage.id, order: stage.order, enabled: stage.enabled };
}

function blockComparator(left: OrderedBlock, right: OrderedBlock): number {
  return (
    left.stageOrder - right.stageOrder ||
    right.block.priority - left.block.priority ||
    left.block.order - right.block.order ||
    compareText(left.block.id, right.block.id) ||
    compareText(left.block.source, right.block.source)
  );
}

function injectionComparator(left: OrderedBlock, right: OrderedBlock): number {
  return (
    right.block.priority - left.block.priority ||
    (roleOrder[left.block.message.role] ?? 1_000) -
      (roleOrder[right.block.message.role] ?? 1_000) ||
    left.block.order - right.block.order ||
    compareText(left.block.id, right.block.id) ||
    compareText(left.block.source, right.block.source)
  );
}

function isEmptyContent(message: OpaqueChatMessage): boolean {
  return typeof message.content === 'string' && message.content.trim().length === 0;
}

function cloneMessageWithContent(message: OpaqueChatMessage, content: unknown): OpaqueChatMessage {
  return { ...message, content };
}

export class DeterministicPromptAssembler implements PromptAssembler {
  readonly #macroEngine: MacroEngine;
  readonly #budgetService: ContextBudgetService;
  readonly #providers: readonly PipelineStepProvider[];
  readonly #expectedProviderKinds: readonly PipelineProviderKind[];

  constructor(options: DeterministicPromptAssemblerOptions) {
    this.#macroEngine = options.macroEngine;
    this.#budgetService = options.budgetService;
    this.#providers = [...(options.providers ?? [])].sort(
      (left, right) =>
        providerKindOrder[left.kind] - providerKindOrder[right.kind] ||
        compareText(left.id, right.id),
    );
    this.#expectedProviderKinds = options.expectedProviderKinds ?? [
      'world-books',
      'presets',
      'extensions',
    ];
  }

  async assemble(input: AssemblePromptInput): Promise<AssemblePromptResult> {
    const diagnostics: PipelineDiagnostic[] = [];
    const providerData = await this.#loadProviders(input, diagnostics);
    const stages = this.#resolveStages(input, providerData, diagnostics);
    const stageMap = new Map(stages.map((stage) => [stage.id, stage]));
    const macroContext: MacroContext = input.macroContext?.messages
      ? input.macroContext
      : { ...input.macroContext, messages: input.messages };

    const rawBlocks = this.#builtInBlocks(input, diagnostics);
    rawBlocks.push(...(input.blocks ?? []));
    for (const data of providerData) {
      for (const block of data.contribution.blocks ?? []) {
        rawBlocks.push({ ...block, source: block.source ?? data.provider.id });
      }
    }

    const blocks: AssembledPromptBlock[] = [];
    const orderedBlocks: OrderedBlock[] = [];
    const seenBlockIds = new Set<string>();
    for (const rawBlock of rawBlocks) {
      const stage = stageMap.get(rawBlock.stage);
      if (!stage) {
        diagnostics.push({
          code: 'pipeline.stage-missing',
          severity: 'warning',
          source: rawBlock.source ?? 'caller',
          message: `Block "${rawBlock.id}" references missing/deleted stage "${rawBlock.stage}" and was skipped.`,
          details: { blockId: rawBlock.id, stageId: rawBlock.stage },
        });
        continue;
      }
      if (!stage.enabled || rawBlock.enabled === false) continue;

      if (seenBlockIds.has(rawBlock.id)) {
        diagnostics.push({
          code: 'pipeline.duplicate-block-id',
          severity: 'warning',
          source: rawBlock.source ?? 'caller',
          message: `Duplicate block id "${rawBlock.id}" is retained; budget identifiers are disambiguated.`,
          details: { blockId: rawBlock.id },
        });
      }
      seenBlockIds.add(rawBlock.id);

      let message = { ...rawBlock.message };
      if (typeof message.content === 'string') {
        const expansion = this.#macroEngine.expand(message.content, macroContext);
        message = cloneMessageWithContent(message, expansion.text);
        diagnostics.push(...expansion.diagnostics);
      }
      if (rawBlock.omitWhenEmpty !== false && isEmptyContent(message)) continue;

      const injection =
        rawBlock.injection?.kind === 'in-chat'
          ? {
              kind: 'in-chat' as const,
              depth: Math.max(0, Math.floor(rawBlock.injection.depth)),
            }
          : { kind: 'absolute' as const };
      const block: AssembledPromptBlock = {
        ...rawBlock,
        message,
        priority: rawBlock.priority ?? 100,
        order: rawBlock.order ?? 100,
        enabled: true,
        required: rawBlock.required ?? true,
        injection,
        source: rawBlock.source ?? 'caller',
      };
      blocks.push(block);
      orderedBlocks.push({ block, stageOrder: stage.order });
    }

    const historyStage = stageMap.get(promptStageIds.history);
    const historyCandidates = historyStage?.enabled
      ? this.#historyCandidates(input.messages, macroContext, diagnostics)
      : [];
    const absoluteBlocks = orderedBlocks
      .filter((entry) => entry.block.injection.kind === 'absolute')
      .sort(blockComparator);
    const inChatBlocks = orderedBlocks
      .filter((entry) => entry.block.injection.kind === 'in-chat')
      .sort(injectionComparator);

    const candidates = this.#composeCandidates(
      absoluteBlocks,
      inChatBlocks,
      historyCandidates,
      historyStage,
      diagnostics,
    );

    if (!input.budget) {
      return {
        messages: candidates.map((candidate) => candidate.message),
        blocks,
        stages,
        budget: null,
        diagnostics,
      };
    }

    const budget = await this.#budgetService.fit({
      candidates,
      maxContextTokens: input.budget.maxContextTokens,
      reservedResponseTokens: input.budget.reservedResponseTokens,
    });
    diagnostics.push(...budget.diagnostics);
    return { messages: budget.messages, blocks, stages, budget, diagnostics };
  }

  async #loadProviders(
    input: AssemblePromptInput,
    diagnostics: PipelineDiagnostic[],
  ): Promise<readonly ProviderData[]> {
    for (const kind of this.#expectedProviderKinds) {
      if (!this.#providers.some((provider) => provider.kind === kind)) {
        diagnostics.push({
          code: 'pipeline.provider-missing',
          severity: 'info',
          source: kind,
          message: `Optional ${kind} pipeline provider is not installed; assembly continues without it.`,
          details: { kind },
        });
      }
    }

    const result: ProviderData[] = [];
    for (const provider of this.#providers) {
      try {
        const contribution = await provider.provide({
          context: input.providerContext ?? {},
        });
        diagnostics.push(...(contribution.diagnostics ?? []));
        result.push({ contribution, provider });
      } catch (error) {
        diagnostics.push({
          code: 'pipeline.provider-failed',
          severity: 'warning',
          source: provider.id,
          message: `Optional provider "${provider.id}" failed; assembly continues without it.`,
          details: { kind: provider.kind, error: String(error) },
        });
      }
    }
    return result;
  }

  #resolveStages(
    input: AssemblePromptInput,
    providerData: readonly ProviderData[],
    diagnostics: PipelineDiagnostic[],
  ): readonly PipelineStage[] {
    const stageMap = new Map(defaultPromptStages.map((stage) => [stage.id, stageCopy(stage)]));
    const applyStage = (stage: PipelineStage, source: string): void => {
      if (stageMap.has(stage.id)) {
        diagnostics.push({
          code: 'pipeline.stage-overridden',
          severity: 'info',
          source,
          message: `Stage "${stage.id}" was overridden by ${source}.`,
          details: { stageId: stage.id },
        });
      }
      stageMap.set(stage.id, stageCopy(stage));
    };

    for (const data of providerData) {
      for (const stage of data.contribution.stages ?? []) applyStage(stage, data.provider.id);
    }
    for (const stage of input.stages ?? []) applyStage(stage, 'caller');

    const deleted = new Set<string>();
    for (const override of input.stageOverrides ?? []) {
      if (override.deleted) {
        deleted.add(override.id);
        continue;
      }
      const stage = stageMap.get(override.id);
      if (!stage) {
        diagnostics.push({
          code: 'pipeline.stage-override-missing',
          severity: 'warning',
          source: 'caller',
          message: `Stage override references unknown stage "${override.id}".`,
          details: { stageId: override.id },
        });
        continue;
      }
      stageMap.set(override.id, {
        ...stage,
        order: override.order ?? stage.order,
        enabled: override.enabled ?? stage.enabled,
      });
    }

    for (const id of deleted) stageMap.delete(id);
    return [...stageMap.values()].sort(
      (left, right) => left.order - right.order || compareText(left.id, right.id),
    );
  }

  #builtInBlocks(input: AssemblePromptInput, diagnostics: PipelineDiagnostic[]): PromptBlock[] {
    const blocks: PromptBlock[] = [];
    if (input.systemPrompt) {
      blocks.push(
        this.#templateBlock(input.systemPrompt, {
          id: 'system-prompt',
          role: 'system',
          stage: promptStageIds.system,
          source: 'system-prompt',
        }),
      );
    }
    if (input.instructionPrompt) {
      blocks.push(
        this.#templateBlock(input.instructionPrompt, {
          id: 'instruction-prompt',
          role: 'system',
          stage: promptStageIds.instruction,
          source: 'instruction-prompt',
        }),
      );
    }
    if (input.authorNote) {
      const block = this.#authorNoteBlock(input.authorNote, input.messages, diagnostics);
      if (block) blocks.push(block);
    }
    return blocks;
  }

  #templateBlock(
    template: PromptTemplateInput,
    defaults: {
      readonly id: string;
      readonly role: string;
      readonly stage: string;
      readonly source: string;
    },
  ): PromptBlock {
    return {
      id: template.id ?? defaults.id,
      stage: template.stage ?? defaults.stage,
      message: {
        ...(template.messageFields ?? {}),
        role: template.role ?? defaults.role,
        content: template.content,
      },
      priority: template.priority ?? 100,
      order: template.order ?? 100,
      required: template.required ?? true,
      enabled: template.enabled ?? true,
      source: defaults.source,
      injection: { kind: 'absolute' },
    };
  }

  #authorNoteBlock(
    note: AuthorNoteInput,
    messages: readonly OpaqueChatMessage[],
    diagnostics: PipelineDiagnostic[],
  ): PromptBlock | null {
    const interval = Math.floor(note.interval ?? 1);
    const userMessageCount =
      note.userMessageCount ?? messages.filter((message) => message.role === 'user').length;
    const shouldInsert =
      interval === 1 ||
      (interval > 1 && userMessageCount >= interval && userMessageCount % interval === 0);
    if (interval <= 0 || userMessageCount <= 0 || !shouldInsert) {
      diagnostics.push({
        code: 'pipeline.author-note-not-due',
        severity: 'info',
        source: 'author-note',
        message: "Author's Note interval is disabled or not due for this turn.",
        details: { interval, userMessageCount },
      });
      return null;
    }

    let content = note.content;
    if (note.characterContent) {
      switch (note.characterPosition ?? 'replace') {
        case 'before':
          content = [note.characterContent, content].filter(Boolean).join('\n');
          break;
        case 'after':
          content = [content, note.characterContent].filter(Boolean).join('\n');
          break;
        case 'replace':
          content = note.characterContent;
          break;
      }
    }

    const position = note.position ?? 'after-system';
    const stage =
      position === 'before-system'
        ? promptStageIds.system
        : (note.stage ?? promptStageIds.authorNote);
    const injection =
      position === 'in-chat'
        ? { kind: 'in-chat' as const, depth: Math.max(0, Math.floor(note.depth ?? 4)) }
        : { kind: 'absolute' as const };
    return {
      id: note.id ?? 'authors-note',
      stage,
      message: {
        ...(note.messageFields ?? {}),
        role: note.role ?? 'system',
        content,
      },
      priority: note.priority ?? 100,
      order: position === 'before-system' ? (note.order ?? -100) : (note.order ?? 100),
      required: note.required ?? true,
      enabled: note.enabled ?? true,
      source: 'author-note',
      injection,
    };
  }

  #historyCandidates(
    messages: readonly OpaqueChatMessage[],
    macroContext: MacroContext,
    diagnostics: PipelineDiagnostic[],
  ): BudgetCandidate[] {
    return messages.map((sourceMessage, index) => {
      let message = { ...sourceMessage };
      if (typeof message.content === 'string') {
        const expansion = this.#macroEngine.expand(message.content, macroContext);
        message = cloneMessageWithContent(message, expansion.text);
        diagnostics.push(...expansion.diagnostics);
      }
      return {
        id: `history:${index}`,
        message,
        required: false,
        priority: 0,
        order: index,
        source: 'history',
      };
    });
  }

  #composeCandidates(
    absoluteBlocks: readonly OrderedBlock[],
    inChatBlocks: readonly OrderedBlock[],
    historyCandidates: readonly BudgetCandidate[],
    historyStage: PipelineStage | undefined,
    diagnostics: PipelineDiagnostic[],
  ): BudgetCandidate[] {
    const historyOrder = historyStage?.order ?? Number.POSITIVE_INFINITY;
    const beforeHistory = absoluteBlocks.filter((entry) => entry.stageOrder < historyOrder);
    const afterHistory = absoluteBlocks.filter((entry) => entry.stageOrder >= historyOrder);
    const result: BudgetCandidate[] = [];
    let sequence = 0;
    const appendBlock = (entry: OrderedBlock): void => {
      result.push({
        id: `block:${entry.block.id}:${sequence}`,
        message: entry.block.message,
        required: entry.block.required,
        priority: entry.block.priority,
        order: sequence,
        source: entry.block.source,
      });
      sequence += 1;
    };

    for (const entry of beforeHistory) appendBlock(entry);

    if (!historyStage?.enabled) {
      if (inChatBlocks.length) {
        diagnostics.push({
          code: 'pipeline.in-chat-without-history',
          severity: 'warning',
          source: 'prompt-assembler',
          message: 'In-chat blocks were skipped because the history stage is missing or disabled.',
          details: { blockIds: inChatBlocks.map((entry) => entry.block.id) },
        });
      }
    } else {
      const slots = new Map<number, OrderedBlock[]>();
      for (const entry of inChatBlocks) {
        const injection = entry.block.injection;
        if (injection.kind !== 'in-chat') continue;
        const slot = historyCandidates.length - Math.min(injection.depth, historyCandidates.length);
        const entries = slots.get(slot) ?? [];
        entries.push(entry);
        entries.sort(injectionComparator);
        slots.set(slot, entries);
      }
      for (let slot = 0; slot <= historyCandidates.length; slot += 1) {
        for (const entry of slots.get(slot) ?? []) appendBlock(entry);
        const history = historyCandidates[slot];
        if (history) {
          result.push({ ...history, order: sequence });
          sequence += 1;
        }
      }
    }

    for (const entry of afterHistory) appendBlock(entry);
    return result;
  }
}
