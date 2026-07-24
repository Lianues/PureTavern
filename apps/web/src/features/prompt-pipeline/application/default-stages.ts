import type { PipelineStage } from '../domain/prompt-pipeline';

export const promptStageIds = Object.freeze({
  system: 'system',
  worldBefore: 'world-before',
  presets: 'presets',
  character: 'character',
  worldAfter: 'world-after',
  extensionsBefore: 'extensions-before',
  instruction: 'instruction',
  authorNote: 'author-note',
  custom: 'custom',
  history: 'history',
  extensionsAfter: 'extensions-after',
  control: 'control',
});

export const defaultPromptStages: readonly PipelineStage[] = Object.freeze([
  { id: promptStageIds.system, order: 100, enabled: true, description: 'Primary system prompt' },
  {
    id: promptStageIds.worldBefore,
    order: 200,
    enabled: true,
    description: 'Injected World Book context before character context',
  },
  { id: promptStageIds.presets, order: 300, enabled: true, description: 'Preset contribution' },
  { id: promptStageIds.character, order: 400, enabled: true, description: 'Character context' },
  {
    id: promptStageIds.worldAfter,
    order: 500,
    enabled: true,
    description: 'Injected World Book context after character context',
  },
  {
    id: promptStageIds.extensionsBefore,
    order: 600,
    enabled: true,
    description: 'Extension contribution before instructions',
  },
  {
    id: promptStageIds.instruction,
    order: 700,
    enabled: true,
    description: 'Instruction-mode/system instruction',
  },
  {
    id: promptStageIds.authorNote,
    order: 800,
    enabled: true,
    description: "Author's Note when not injected in chat",
  },
  { id: promptStageIds.custom, order: 900, enabled: true, description: 'Caller custom prompts' },
  { id: promptStageIds.history, order: 1_000, enabled: true, description: 'Chat history' },
  {
    id: promptStageIds.extensionsAfter,
    order: 1_100,
    enabled: true,
    description: 'Extension contribution after chat history',
  },
  { id: promptStageIds.control, order: 1_200, enabled: true, description: 'Final control prompt' },
]);
