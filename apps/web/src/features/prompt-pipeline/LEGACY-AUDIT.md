# Read-only legacy audit

Audited files are under `apps/web/legacy/upstream/public/scripts/`; none were modified or imported by M10.

## `openai.js`

Primary chat-completion entry: `prepareOpenAIMessages`.

Observed flow:

1. Create `ChatCompletion`; set prompt budget to `openai_max_context - openai_max_tokens`.
2. `preparePromptsForChatCompletion` formats scenario/personality and creates marker values for World Info before/after, character description/personality/scenario, plus quiet/group/impersonation/bias controls.
3. Known extension keys map to summary, Author's Note, vector memories and smart context. Other before/in-prompt extension entries are filtered and converted to prompt records.
4. Merge these records into `PromptManager.getPromptCollection(type)`, inheriting configured injection position/depth/order/role. Character main/jailbreak overrides retain an `original` value for macro substitution.
5. `populateChatCompletion` reserves reply framing/control/tool budget; adds World Info/main/character/persona and ordered nsfw/jailbreak/custom prompts; handles relative-to-main prompts; converts absolute PromptManager entries into in-chat injections.
6. In-chat injection scans depth from zero to extension maximum. It groups by injection order descending, then emits roles in system/user/assistant order. The legacy extension bucket uses priority 100. Messages are injected against reversed history.
7. Chat history and dialogue examples compete for remaining budget; `pin_examples` changes which is populated first. Final control prompts are added last.
8. Optional system-message squashing and `CHAT_COMPLETION_PROMPT_READY` event emission occur after assembly.

`Message`, `MessageCollection`, `ChatCompletion`, token framing, image/audio/video costs, tool calls and backend conversion have significantly broader semantics than this M10 body.

## `PromptManager.js`

`Prompt` fields include identifier, role, content, system flag, list position, injection position/depth/order/trigger, override prohibition and extension marker. `PromptCollection` retains ordered prompts and overridden identifiers.

Default enabled order audited from `promptManagerDefaultPromptOrder`:

1. `main`
2. `worldInfoBefore`
3. `personaDescription`
4. `charDescription`
5. `charPersonality`
6. `scenario`
7. `enhanceDefinitions` (disabled by default)
8. `nsfw`
9. `worldInfoAfter`
10. `dialogueExamples`
11. `chatHistory`
12. `jailbreak`

`getPromptCollection` follows character/global order, enabled state and generation triggers. A disabled `main` leaves an empty marker because extensions may target it. `preparePrompt` runs `substituteParams`, includes active group names, and supplies `original` during overrides. System prompts cannot be deleted in the legacy UI, while user prompts can be detached.

Relevant exports: `PromptManager`, `PromptCollection`, `Prompt`, `chatCompletionDefaultPrompts`, `promptManagerDefaultPromptOrders`, and migration registration.

## `instruct-mode.js`

Audited exports include preset loading/selection, stopping sequences, `formatInstructModeChat`, system/story/example/final-prompt formatters and `getInstructMacros`.

Common behavior:

- user/assistant/system/narrator select different prefix/suffix sequences;
- first/last output and input sequences fall back to normal output/input;
- `macro` enables substitution inside sequences, including `{{name}}`;
- `wrap` supplies newline separators/fallback suffix;
- names behavior controls `Name: message` emission;
- story prefix/suffix are applied only when story text is not already in-chat;
- quiet, quiet-to-loud and impersonation select different final sequences.

M10 exposes common sequence macros and an instruction block stage. It does not yet reproduce complete text-completion transcript formatting.

## `authors-note.js`

The note is disabled when no chat/user messages exist or interval is non-positive. Interval `1` always inserts; otherwise insertion is due on the user-message modulo boundary. A character note can prepend, append or replace the chat note. The resulting extension prompt carries configured position, depth, World Info scan permission and system/user/assistant role.

Macros audited: `authorsNote`, `charAuthorsNote`, `defaultAuthorsNote`.

## `macros/**`

`macro-system.js` registers definitions in core, environment, state, chat, time, variable and instruct order. The new engine lexes/parses nested calls and returns original source on fatal parse/evaluation errors. Unknown calls stay in `{{...}}` syntax; nested content has already been evaluated by the upstream CST walker. Runtime failures also preserve raw macro text.

Audited definition families:

- core: whitespace/newline/noop/trim, scoped if/else, input/max tokens, reverse/comments, random/pick/roll, banned/outlet;
- environment: user/character/group, card fields, persona/examples, model/original/device;
- chat: recent messages and ids/ranges/swipes;
- state/time;
- local/global variables;
- instruct/system/context template values.

M10 deliberately implements only the deterministic subset listed in `COMPATIBILITY.md`. In particular, M10 preserves an entire unknown raw call without resolving nested content, while the current upstream CST walker may resolve nested calls before preserving an unknown outer call. That difference requires a conformance decision.

## `variables.js`

Local variables live in chat metadata and global variables in extension settings. Getters coerce numeric strings to numbers. Add behavior appends to JSON arrays, otherwise performs numeric addition when both values are numeric and string concatenation when either is not. Increment/decrement call add with `+1`/`-1`. `resolveVariable` checks slash-command scope, local, global, then returns the literal name.

Common regex macros and new registry definitions cover set/add/inc/dec/get plus exists/delete aliases for local and global stores. M10 implements those common operations against injected or module-memory stores, without persistence side effects.
