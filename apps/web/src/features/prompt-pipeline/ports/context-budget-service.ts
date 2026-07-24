import type {
  ContextBudgetRequest,
  ContextBudgetResult,
  OpaqueChatMessage,
} from '../domain/prompt-pipeline';

export interface MessageTokenizer {
  readonly id: string;
  countMessages(messages: readonly OpaqueChatMessage[]): Promise<number> | number;
}

/** An estimator is intentionally approximate and can never report exact precision. */
export interface MessageTokenEstimator {
  readonly id: string;
  estimateMessages(messages: readonly OpaqueChatMessage[]): Promise<number> | number;
}

export interface ContextBudgetService {
  fit(request: ContextBudgetRequest): Promise<ContextBudgetResult>;
}
