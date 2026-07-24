# M10 Prompt Pipeline candidate

This directory is a pure TypeScript, dependency-injected Prompt Pipeline body. It does **not** replace or patch SillyTavern's `prepareOpenAIMessages`, `PromptManager`, macro engine, author-note extension, or instruct-mode code. The legacy runtime remains the owner until a serial integration task captures upstream output and passes the conformance gate described below.

## Architecture

- `domain/prompt-pipeline.ts`: opaque messages, blocks, stages, budget result, macro context and diagnostics.
- `ports/`: `PromptAssembler`, `MacroEngine`, `ContextBudgetService`, tokenizer/estimator and optional `PipelineStepProvider` contracts.
- `application/default-macro-engine.ts`: bounded common macro/variable subset. Unknown/malformed calls remain visible and emit diagnostics.
- `application/deterministic-context-budget-service.ts`: injected tokenizer first; explicitly approximate character-ratio fallback.
- `application/deterministic-prompt-assembler.ts`: provider collection, stage resolution, macro expansion, depth injection and trimming.
- `legacy/`: fixture adapter, canonical comparable output and smoke fixtures; no import from legacy scripts.
- `module.ts`: composition factory plus registered `PromptPipelineRuntimeCapability`; diagnostics keep `ownership: "legacy"` and `replacementEnabled: false`.

## Determinism and ordering

Default absolute stage order is:

1. system
2. world-before (provider)
3. presets (provider)
4. character
5. world-after (provider)
6. extensions-before (provider)
7. instruction
8. author-note
9. custom
10. history
11. extensions-after (provider)
12. control

A stage may be disabled or deleted using `stageOverrides`. Blocks in a disabled/deleted stage do not run. Within a stage, higher `priority` runs first, then lower `order`, block id and source. In-chat blocks use depth from the newest history boundary (`0` = after the newest message, `1` = before it), then the same priority/order tie-breaks with stable role ordering.

History messages are cloned with object spread and only string `content` is interpreted. Unknown fields (tool calls, media, reasoning, ids, plugin data, etc.) are not normalized or dropped.

## External feature boundary

World Books, Presets and Extensions are optional provider slots. This module imports none of their implementations. Missing or failed providers degrade to an empty contribution and produce `pipeline.provider-missing` / `pipeline.provider-failed` diagnostics.

## Budget truthfulness

`MessageTokenizer` produces `precision: "exact"`. Without it (M15 unavailable), `CharacterRatioTokenEstimator` is selected and the result is always marked `precision: "approximate"` with `budget.approximate-estimator`. A tokenizer failure also falls back with diagnostics. The fallback is never presented as an exact token count.

Optional candidates are removed by ascending priority/order until the prompt fits. History uses priority `0` and chronological order, so oldest history is removed first under the normal defaults. Required overflow remains in output and is reported as `budget.required-overflow` rather than silently deleting mandatory prompts.

## Legacy conformance gate before ownership switch

1. Capture actual outputs from the unchanged legacy generator for representative OpenAI/chat-completion settings.
2. Store only fixture inputs/expected message output in this directory (do not import legacy scripts).
3. Run `LegacyPromptConformanceAdapter` and compare canonical output.
4. Add fixtures for every row marked partial/not implemented in `COMPATIBILITY.md` that the target capability intends to own.
5. Resolve or explicitly approve every difference (including token counts, message squashing and multimodal/tool payloads).
6. Only then register the module through the central capability and move generation ownership.

The current smoke fixture is hand-authored and proves the comparison mechanism, not full legacy equivalence.
