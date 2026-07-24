# M15 Tokenizers — unified tokenx estimator

Pure Tavern intentionally uses one lightweight tokenizer estimate for every model alias. The module
uses `tokenx@1.3.x`, whose documented result is an approximately 96% accurate heuristic rather than
a model vocabulary tokenizer.

## Semantics

- Every SillyTavern tokenizer alias maps to the same `TokenizerPort`.
- All results are marked `precision: "approximate"`, `approximate: true`, and
  `tokenizer: "tokenx"`.
- Empty, English, CJK, emoji and mixed text use tokenx's language-aware estimate.
- M10 consumes `TokenizerCapability` as a `MessageTokenEstimator`; it does not become an exact
  `MessageTokenizer`.
- Tokenizer failure falls back to a four-character estimate and never blocks chatting.

Model context limits should retain safety margin. A future exact browser or optional-backend adapter
can implement the same Port without changing the original UI.

## Worker and synchronous Legacy calls

Asynchronous count/encode runs in `/__pure_tavern/tokenizer-worker.js`, bundled from this feature's
`runtime-assets.json`. Worker startup, timeout or runtime failure falls back to main-thread tokenx;
only a tokenx failure uses the character estimator.

SillyTavern also exposes synchronous jQuery encode/decode helpers. The Compatibility XHR bridge has
a narrowly registered synchronous path for M15 and runs the same tokenx engine on the main thread.
Other synchronous `/api/**` requests are not intercepted.

## Encode and decode limitation

`tokenx` does not expose vocabulary token IDs. M15 therefore creates deterministic **pseudo IDs** and
one estimated chunk per token position for Legacy token viewers. A bounded page-session cache can
decode IDs produced by that same page. Unknown IDs return `supported: false` and empty text.

Pseudo IDs must never be sent to a generation provider. They exist only for UI compatibility.

## Legacy routes

The module owns all SillyTavern 1.18.0 local aliases (`gpt2`, `openai`, `llama`, `mistral`, Claude,
Llama 3, Gemma, Qwen, Command, Nemo, DeepSeek, etc.), OpenAI message count, and the two remote
Kobold/TextGenerationWebUI tokenization paths. Per the project simplification decision, even remote
paths count locally with tokenx and do not contact a model server.
