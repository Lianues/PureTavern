import type { AssemblePromptInput, AssemblePromptResult } from '../domain/prompt-pipeline';

export interface PromptAssembler {
  assemble(input: AssemblePromptInput): Promise<AssemblePromptResult>;
}
