export type PromptRole = 'system' | 'user' | 'assistant' | 'tool' | (string & Record<never, never>);

/**
 * The pipeline only interprets role/content. Every other field belongs to the
 * caller and must survive assembly and trimming unchanged.
 */
export interface OpaqueChatMessage {
  readonly role: PromptRole;
  readonly content?: unknown;
  readonly [key: string]: unknown;
}

export type PipelineDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface PipelineDiagnostic {
  readonly code: string;
  readonly severity: PipelineDiagnosticSeverity;
  readonly message: string;
  readonly source?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface PipelineStage {
  readonly id: string;
  readonly order: number;
  readonly enabled: boolean;
  readonly description?: string;
}

export interface PipelineStageOverride {
  readonly id: string;
  readonly order?: number;
  readonly enabled?: boolean;
  /** A deleted stage and every block assigned to it are absent from output. */
  readonly deleted?: boolean;
}

export type PromptInjection =
  { readonly kind: 'absolute' } | { readonly kind: 'in-chat'; readonly depth: number };

export interface PromptBlock {
  readonly id: string;
  readonly stage: string;
  readonly message: OpaqueChatMessage;
  /** Higher priority is emitted first inside the same stage/order bucket. */
  readonly priority?: number;
  /** Lower order is emitted first after priority comparison. */
  readonly order?: number;
  readonly enabled?: boolean;
  readonly required?: boolean;
  readonly injection?: PromptInjection;
  readonly source?: string;
  readonly omitWhenEmpty?: boolean;
}

export interface PromptTemplateInput {
  readonly id?: string;
  readonly content: string;
  readonly role?: PromptRole;
  readonly stage?: string;
  readonly priority?: number;
  readonly order?: number;
  readonly required?: boolean;
  readonly enabled?: boolean;
  readonly messageFields?: Readonly<Record<string, unknown>>;
}

export type AuthorNoteCharacterPosition = 'before' | 'after' | 'replace';
export type AuthorNotePosition = 'before-system' | 'after-system' | 'in-chat';

export interface AuthorNoteInput extends PromptTemplateInput {
  readonly position?: AuthorNotePosition;
  readonly depth?: number;
  /** <= 0 disables the note. 1 always inserts. */
  readonly interval?: number;
  /** Defaults to the number of role=user messages in the supplied history. */
  readonly userMessageCount?: number;
  readonly characterContent?: string;
  readonly characterPosition?: AuthorNoteCharacterPosition;
}

export interface PromptBudgetOptions {
  readonly maxContextTokens: number;
  readonly reservedResponseTokens: number;
}

export interface AssemblePromptInput {
  readonly messages: readonly OpaqueChatMessage[];
  readonly systemPrompt?: PromptTemplateInput;
  readonly instructionPrompt?: PromptTemplateInput;
  readonly authorNote?: AuthorNoteInput;
  readonly blocks?: readonly PromptBlock[];
  readonly stages?: readonly PipelineStage[];
  readonly stageOverrides?: readonly PipelineStageOverride[];
  readonly macroContext?: MacroContext;
  readonly providerContext?: Readonly<Record<string, unknown>>;
  readonly budget?: PromptBudgetOptions;
}

export interface AssembledPromptBlock extends PromptBlock {
  readonly priority: number;
  readonly order: number;
  readonly enabled: true;
  readonly required: boolean;
  readonly injection: PromptInjection;
  readonly source: string;
}

export interface AssemblePromptResult {
  readonly messages: readonly OpaqueChatMessage[];
  readonly blocks: readonly AssembledPromptBlock[];
  readonly stages: readonly PipelineStage[];
  readonly budget: ContextBudgetResult | null;
  readonly diagnostics: readonly PipelineDiagnostic[];
}

export type MacroPrimitive = string | number | boolean | null | undefined;

export interface MacroVariableStore {
  has(name: string): boolean;
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  delete(name: string): boolean;
}

export interface InstructMacroValues {
  readonly enabled?: boolean;
  readonly storyStringPrefix?: string;
  readonly storyStringSuffix?: string;
  readonly userPrefix?: string;
  readonly userSuffix?: string;
  readonly assistantPrefix?: string;
  readonly assistantSuffix?: string;
  readonly systemPrefix?: string;
  readonly systemSuffix?: string;
  readonly firstAssistantPrefix?: string;
  readonly lastAssistantPrefix?: string;
  readonly firstUserPrefix?: string;
  readonly lastUserPrefix?: string;
  readonly stop?: string;
  readonly userFiller?: string;
  readonly systemInstructionPrefix?: string;
}

export interface MacroContext {
  readonly values?: Readonly<Record<string, MacroPrimitive | (() => MacroPrimitive)>>;
  readonly localVariables?: MacroVariableStore;
  readonly globalVariables?: MacroVariableStore;
  readonly messages?: readonly OpaqueChatMessage[];
  readonly user?: string;
  readonly character?: string;
  readonly group?: string;
  readonly groupNotMuted?: string;
  readonly characterPrompt?: string;
  readonly characterInstruction?: string;
  readonly characterDescription?: string;
  readonly characterPersonality?: string;
  readonly characterScenario?: string;
  readonly persona?: string;
  readonly examplesRaw?: string;
  readonly examples?: string;
  readonly characterDepthPrompt?: string;
  readonly characterCreatorNotes?: string;
  readonly characterFirstMessage?: string;
  readonly characterVersion?: string;
  readonly model?: string;
  readonly original?: string;
  readonly authorsNote?: string;
  readonly characterAuthorsNote?: string;
  readonly defaultAuthorsNote?: string;
  readonly systemPrompt?: string;
  readonly defaultSystemPrompt?: string;
  readonly instruct?: InstructMacroValues;
  readonly maxPromptTokens?: number;
  readonly maxContextTokens?: number;
  readonly maxResponseTokens?: number;
  readonly input?: string;
  readonly maxDepth?: number;
}

export interface MacroExpansionResult {
  readonly text: string;
  readonly diagnostics: readonly PipelineDiagnostic[];
}

export type TokenCountPrecision = 'exact' | 'approximate';

export interface BudgetCandidate {
  readonly id: string;
  readonly message: OpaqueChatMessage;
  readonly required: boolean;
  readonly priority: number;
  readonly order: number;
  readonly source: string;
}

export interface ContextBudgetRequest extends PromptBudgetOptions {
  readonly candidates: readonly BudgetCandidate[];
}

export interface RemovedBudgetCandidate {
  readonly candidate: BudgetCandidate;
  readonly reason: 'context-budget';
}

export interface ContextBudgetResult {
  readonly messages: readonly OpaqueChatMessage[];
  readonly kept: readonly BudgetCandidate[];
  readonly removed: readonly RemovedBudgetCandidate[];
  readonly promptTokens: number;
  readonly availablePromptTokens: number;
  readonly overflowTokens: number;
  readonly precision: TokenCountPrecision;
  readonly estimator: string;
  readonly diagnostics: readonly PipelineDiagnostic[];
}
