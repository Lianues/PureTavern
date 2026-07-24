import type { PipelineDiagnostic, PipelineStage, PromptBlock } from '../domain/prompt-pipeline';

export type PipelineProviderKind = 'world-books' | 'presets' | 'extensions';

export interface PipelineProviderRequest {
  readonly context: Readonly<Record<string, unknown>>;
}

export interface PipelineProviderContribution {
  readonly stages?: readonly PipelineStage[];
  readonly blocks?: readonly PromptBlock[];
  readonly diagnostics?: readonly PipelineDiagnostic[];
}

/**
 * The only integration surface for World Books, Presets and Extensions.
 * Implementations live outside this feature and are injected at composition time.
 */
export interface PipelineStepProvider {
  readonly id: string;
  readonly kind: PipelineProviderKind;
  provide(
    request: PipelineProviderRequest,
  ): Promise<PipelineProviderContribution> | PipelineProviderContribution;
}
