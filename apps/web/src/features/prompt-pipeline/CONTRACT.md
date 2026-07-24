# Prompt Pipeline contract

## Ports

### `PromptAssembler`

`assemble(input)` is asynchronous because injected providers and tokenizers may be asynchronous. It returns ordered opaque messages, included expanded blocks, effective stages, optional budget metadata and accumulated diagnostics. The assembler does not mutate the input arrays or message objects.

### `MacroEngine`

`expand(template, context)` returns text plus diagnostics. Implementations must:

- preserve unknown/malformed source text;
- bound recursive/nested evaluation;
- expose recursion/unknown errors as diagnostics;
- avoid implicit access to application globals.

### `ContextBudgetService`

`fit(request)` returns retained and removed candidates, token precision, estimator/tokenizer id and overflow. `precision: "exact"` is legal only for a successful injected tokenizer. Required candidates cannot be silently trimmed.

### `PipelineStepProvider`

Providers are optional and identified as `world-books`, `presets` or `extensions`. They return only stages, blocks and diagnostics. Provider order is kind then provider id, independent of registration timing. A provider exception is isolated.

## Stage and block rules

- Stage order is ascending, then stage id.
- A deleted stage is absent; a disabled stage remains visible but contributes no blocks.
- Absolute block order is stage order, priority descending, order ascending, id, source.
- In-chat `depth` is clamped to available history boundaries.
- Empty string blocks are omitted unless `omitWhenEmpty: false`.
- Built-in/caller prompt blocks are required by default; history is optional.
- Only string message content is macro-expanded. Other content and unknown message fields stay opaque.

## Diagnostics

Diagnostics are data, not logging side effects. Stable code prefixes are:

- `pipeline.*` for stage/provider/assembly decisions;
- `macro.*` for parsing, unknown calls and recursion;
- `budget.*` for precision, trimming and overflow.

Consumers must not infer exact token counts when any `budget.approximate-estimator` diagnostic exists.

## Non-goals of M10 parallel body

- importing or replacing legacy generation;
- central capability registration;
- loading World Books/Presets/Extensions directly;
- backend request conversion;
- complete legacy macro, instruct or tool/media semantics;
- claiming conformance without captured legacy fixtures.
