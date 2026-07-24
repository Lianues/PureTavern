import type {
  BudgetCandidate,
  ContextBudgetRequest,
  ContextBudgetResult,
  OpaqueChatMessage,
  PipelineDiagnostic,
  TokenCountPrecision,
} from '../domain/prompt-pipeline';
import type {
  ContextBudgetService,
  MessageTokenEstimator,
  MessageTokenizer,
} from '../ports/context-budget-service';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function serializeContent(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content) ?? String(content);
  } catch {
    return String(content);
  }
}

/**
 * Deliberately named and reported as approximate. It uses four UTF-16 code
 * units per token plus per-message framing; it is not a model tokenizer.
 */
export class CharacterRatioTokenEstimator implements MessageTokenEstimator {
  readonly id = 'approximate-character-ratio-v1';

  estimateMessages(messages: readonly OpaqueChatMessage[]): number {
    if (!messages.length) return 0;
    const contentTokens = messages.reduce((total, message) => {
      const text = `${message.role}\n${serializeContent(message.content)}`;
      return total + Math.ceil(text.length / 4) + 4;
    }, 0);
    return contentTokens + 3;
  }
}

export interface DeterministicContextBudgetServiceOptions {
  readonly tokenizer?: MessageTokenizer;
  readonly estimator?: MessageTokenEstimator;
}

export class DeterministicContextBudgetService implements ContextBudgetService {
  readonly #tokenizer: MessageTokenizer | undefined;
  readonly #estimator: MessageTokenEstimator;

  constructor(options: DeterministicContextBudgetServiceOptions = {}) {
    this.#tokenizer = options.tokenizer;
    this.#estimator = options.estimator ?? new CharacterRatioTokenEstimator();
  }

  async fit(request: ContextBudgetRequest): Promise<ContextBudgetResult> {
    this.#validateBudget(request.maxContextTokens, request.reservedResponseTokens);

    const diagnostics: PipelineDiagnostic[] = [];
    let precision: TokenCountPrecision = this.#tokenizer ? 'exact' : 'approximate';
    let counterId = this.#tokenizer?.id ?? this.#estimator.id;
    let tokenizerFailed = false;

    if (!this.#tokenizer) {
      diagnostics.push({
        code: 'budget.approximate-estimator',
        severity: 'warning',
        source: 'context-budget',
        message: 'No tokenizer was injected; token counts use an explicit approximate estimator.',
        details: { estimator: this.#estimator.id },
      });
    }

    const count = async (candidates: readonly BudgetCandidate[]): Promise<number> => {
      const messages = candidates.map((candidate) => candidate.message);
      if (this.#tokenizer && !tokenizerFailed) {
        try {
          const tokens = await this.#tokenizer.countMessages(messages);
          if (!Number.isFinite(tokens) || tokens < 0) {
            throw new RangeError(`Tokenizer returned invalid count: ${tokens}`);
          }
          return Math.ceil(tokens);
        } catch (error) {
          tokenizerFailed = true;
          precision = 'approximate';
          counterId = this.#estimator.id;
          diagnostics.push({
            code: 'budget.tokenizer-failed',
            severity: 'warning',
            source: 'context-budget',
            message:
              'Injected tokenizer failed; the pipeline fell back to its approximate estimator.',
            details: { tokenizer: this.#tokenizer.id, error: String(error) },
          });
          diagnostics.push({
            code: 'budget.approximate-estimator',
            severity: 'warning',
            source: 'context-budget',
            message: 'Budget result is approximate after tokenizer fallback.',
            details: { estimator: this.#estimator.id },
          });
        }
      }

      const tokens = await this.#estimator.estimateMessages(messages);
      if (!Number.isFinite(tokens) || tokens < 0) {
        throw new RangeError(`Estimator returned invalid count: ${tokens}`);
      }
      return Math.ceil(tokens);
    };

    const availablePromptTokens = Math.max(
      0,
      Math.floor(request.maxContextTokens - request.reservedResponseTokens),
    );
    const kept = [...request.candidates];
    const removed: ContextBudgetResult['removed'][number][] = [];
    let promptTokens = await count(kept);

    const removable = request.candidates
      .filter((candidate) => !candidate.required)
      .sort(
        (left, right) =>
          left.priority - right.priority ||
          left.order - right.order ||
          compareText(left.id, right.id),
      );

    for (const candidate of removable) {
      if (promptTokens <= availablePromptTokens) break;
      const index = kept.indexOf(candidate);
      if (index < 0) continue;
      kept.splice(index, 1);
      removed.push({ candidate, reason: 'context-budget' });
      promptTokens = await count(kept);
    }

    const overflowTokens = Math.max(0, promptTokens - availablePromptTokens);
    if (removed.length) {
      diagnostics.push({
        code: 'budget.trimmed',
        severity: 'info',
        source: 'context-budget',
        message: `Removed ${removed.length} optional message(s) to fit the context budget.`,
        details: { removedIds: removed.map((item) => item.candidate.id) },
      });
    }
    if (overflowTokens > 0) {
      diagnostics.push({
        code: 'budget.required-overflow',
        severity: 'error',
        source: 'context-budget',
        message: 'Required prompt messages exceed the available context budget.',
        details: { overflowTokens },
      });
    }

    return {
      messages: kept.map((candidate) => candidate.message),
      kept,
      removed,
      promptTokens,
      availablePromptTokens,
      overflowTokens,
      precision,
      estimator: counterId,
      diagnostics,
    };
  }

  #validateBudget(maxContextTokens: number, reservedResponseTokens: number): void {
    if (!Number.isFinite(maxContextTokens) || maxContextTokens < 0) {
      throw new RangeError('maxContextTokens must be a finite non-negative number.');
    }
    if (!Number.isFinite(reservedResponseTokens) || reservedResponseTokens < 0) {
      throw new RangeError('reservedResponseTokens must be a finite non-negative number.');
    }
  }
}
