import type { MacroContext, MacroExpansionResult } from '../domain/prompt-pipeline';

export interface MacroEngine {
  expand(template: string, context?: MacroContext): MacroExpansionResult;
}
