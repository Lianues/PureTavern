import { defineCapability } from '@/platform/features/capability-registry';
import type { FeatureModule } from '@/platform/features/feature-module';
import { tokenizerCapability } from '@/platform/features/standard-capabilities';

import type { MacroVariableStore } from './domain/prompt-pipeline';
import type { MessageTokenEstimator, MessageTokenizer } from './ports/context-budget-service';
import type { PipelineProviderKind, PipelineStepProvider } from './ports/pipeline-step-provider';
import type { ContextBudgetService } from './ports/context-budget-service';
import type { MacroEngine } from './ports/macro-engine';
import type { PromptAssembler } from './ports/prompt-assembler';
import { DeterministicContextBudgetService } from './application/deterministic-context-budget-service';
import { DefaultMacroEngine } from './application/default-macro-engine';
import { DeterministicPromptAssembler } from './application/deterministic-prompt-assembler';

export interface PromptPipelineModuleDependencies {
  readonly tokenizer?: MessageTokenizer;
  readonly estimator?: MessageTokenEstimator;
  readonly macroEngine?: MacroEngine;
  readonly budgetService?: ContextBudgetService;
  readonly localVariables?: MacroVariableStore;
  readonly globalVariables?: MacroVariableStore;
  readonly providers?: readonly PipelineStepProvider[];
  readonly expectedProviderKinds?: readonly PipelineProviderKind[];
}

export interface PromptPipelineModule {
  readonly assembler: PromptAssembler;
  readonly macroEngine: MacroEngine;
  readonly budgetService: ContextBudgetService;
}

export interface PromptPipelineRuntimeCapability extends PromptPipelineModule {
  readonly ownership: 'legacy';
  readonly status: 'conformance-candidate';
}

export const promptPipelineRuntimeCapability = defineCapability<PromptPipelineRuntimeCapability>(
  'prompt-pipeline.runtime.v1',
);

/**
 * Composition root for a future capability registration. It intentionally does
 * not import or mutate the central capability registry.
 */
export function createPromptPipelineModule(
  dependencies: PromptPipelineModuleDependencies = {},
): PromptPipelineModule {
  const macroEngine =
    dependencies.macroEngine ??
    new DefaultMacroEngine({
      ...(dependencies.localVariables ? { localVariables: dependencies.localVariables } : {}),
      ...(dependencies.globalVariables ? { globalVariables: dependencies.globalVariables } : {}),
    });
  const budgetService =
    dependencies.budgetService ??
    new DeterministicContextBudgetService({
      ...(dependencies.tokenizer ? { tokenizer: dependencies.tokenizer } : {}),
      ...(dependencies.estimator ? { estimator: dependencies.estimator } : {}),
    });
  const assembler = new DeterministicPromptAssembler({
    macroEngine,
    budgetService,
    ...(dependencies.providers ? { providers: dependencies.providers } : {}),
    ...(dependencies.expectedProviderKinds
      ? { expectedProviderKinds: dependencies.expectedProviderKinds }
      : {}),
  });
  return { assembler, macroEngine, budgetService };
}

export function createPromptPipelineFeature(
  dependencies: PromptPipelineModuleDependencies = {},
): FeatureModule {
  return {
    id: 'prompt-pipeline',
    install({ capabilities }) {
      const unifiedTokenizer = capabilities.get(tokenizerCapability);
      const runtimeDependencies: PromptPipelineModuleDependencies =
        !dependencies.tokenizer && !dependencies.estimator && unifiedTokenizer
          ? {
              ...dependencies,
              estimator: {
                id: 'tokenx-unified-approximate',
                estimateMessages: (messages) => unifiedTokenizer.countMessages(messages),
              },
            }
          : dependencies;
      const pipeline = createPromptPipelineModule(runtimeDependencies);
      const runtime: PromptPipelineRuntimeCapability = {
        ...pipeline,
        ownership: 'legacy',
        status: 'conformance-candidate',
      };
      capabilities.register(promptPipelineRuntimeCapability, runtime);
      return {
        diagnostics: {
          status: 'conformance-candidate',
          ownership: 'legacy',
          tokenizerPrecision: dependencies.tokenizer ? 'exact' : 'approximate',
          estimator: runtimeDependencies.estimator?.id ?? 'character-ratio',
          replacementEnabled: false,
          message:
            'The original SillyTavern prompt pipeline remains authoritative until full conformance passes.',
        },
      };
    },
  };
}

export const promptPipelineFeature = createPromptPipelineFeature();
