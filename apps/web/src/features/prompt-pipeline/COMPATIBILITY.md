# Legacy compatibility matrix

Audit baseline: `legacy/upstream/public/scripts/openai.js`, `PromptManager.js`, `instruct-mode.js`, `authors-note.js`, `variables.js`, and `macros/**` as present in this workspace on 2026-07-24.

## Prompt stages

| Legacy behavior                                                                     | This module                                                          | Status / gate                                                                                          |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| PromptManager character/global prompt order and enabled entries                     | Deterministic stages plus per-stage disable/delete and block enable  | Implemented contract; exact migration of saved PromptManager order needs adapter fixtures              |
| `main`, World Info before, persona/character/scenario, World Info after             | System/character stages; World Book values only by injected provider | Partial; formatting such as `wi_format`, scenario/personality templates needs provider/caller          |
| `nsfw`, `jailbreak`, arbitrary user prompts                                         | Instruction/custom/control blocks                                    | Structural support; saved preset mapping is serial integration work                                    |
| Author's Note interval, character note before/after/replace, role and in-chat depth | `AuthorNoteInput`                                                    | Implemented common subset                                                                              |
| Extension prompts at before/in-prompt/in-chat positions                             | Provider blocks with absolute/in-chat injection                      | Partial; upstream filters, `allowWIScan`, max-depth source and prompt squashing need provider fixtures |
| In-chat priority descending and system/user/assistant grouping                      | Priority descending and deterministic role tie-break                 | Partial; this module does not squash same-role blocks into one newline-joined message                  |
| Dialogue examples pinned before/after history                                       | Custom/provider blocks                                               | Not automatically implemented                                                                          |
| Continue/impersonate/quiet/group nudges and assistant prefill                       | Caller control blocks                                                | Not automatically implemented                                                                          |
| Tool budget reservation, tool results, media token costs and reasoning signatures   | Opaque fields survive; generic budget candidates                     | Not implemented semantically; requires M15/tool conformance fixtures                                   |
| `squash_system_messages` and backend-specific prompt conversion                     | No squashing/conversion                                              | Not implemented                                                                                        |

## Macros and variables

Unknown and malformed macros are preserved with diagnostics. This is a hard migration invariant: unsupported text is never silently removed.

| Family                                   | Implemented                                                                                                                                                                                        | Notes                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Environment                              | `user`, `char`, `group`, `groupNotMuted`, `notChar`/`charIfNotGroup`, character prompt/description/personality/scenario/persona/examples/depth/creator notes/greeting/version, `model`, `original` | Missing values resolve to empty like registered legacy environment macros                                      |
| Legacy angle aliases                     | `<USER>`, `<BOT>`, `<CHAR>`, `<CHARIFNOTGROUP>`, `<GROUP>`                                                                                                                                         | Case-insensitive preprocessing                                                                                 |
| Prompt extras                            | `authorsNote`, `charAuthorsNote`, `defaultAuthorsNote`, `systemPrompt`, default/instruct system aliases                                                                                            | Values are supplied explicitly in `MacroContext`                                                               |
| Instruct values                          | Story/user/assistant/system/first/last/stop/filler aliases                                                                                                                                         | Empty when `instruct.enabled === false`; formatting of complete text-completion transcripts is not owned       |
| Core                                     | `space`, `newline`, `noop`, `trim`, comments, `reverse`, `input`, max token aliases                                                                                                                | `trim` removes adjacent newlines before parsing                                                                |
| Chat                                     | `lastMessage`, `lastMessageId`, `lastUserMessage`, `lastCharMessage`, `allChatRange`                                                                                                               | Reads injected opaque messages; other swipe/display ids are not implemented                                    |
| Local/global variables                   | set/add/inc/dec/get/has/delete and legacy aliases                                                                                                                                                  | Injected stores or module-local memory stores; array/numeric/string add follows common `variables.js` behavior |
| Time/random/control/filter/scoped macros | None                                                                                                                                                                                               | Preserved as unknown; must be added with deterministic clocks/RNG and fixtures                                 |
| Escaping                                 | `\{{...}}` emits literal `{{...}}`                                                                                                                                                                 | Explicit M10 migration escape; not asserted byte-equivalent to every legacy parser edge case                   |
| Nesting/recursion                        | Balanced nested calls, configurable max depth (default 12), cycle diagnostics                                                                                                                      | Legacy new engine nesting is parser-driven and not expressed as the same numeric limit; conformance required   |

## Budget

| Behavior                           | This module                                         | Status                                             |
| ---------------------------------- | --------------------------------------------------- | -------------------------------------------------- |
| Model tokenizer                    | Injected `MessageTokenizer`                         | Exact when supplied                                |
| M15 absent                         | `CharacterRatioTokenEstimator` + warning diagnostic | Explicitly approximate                             |
| History fitting                    | Remove optional lowest-priority/oldest candidates   | Implemented deterministic policy                   |
| Mandatory overflow                 | Keep required prompts and emit error diagnostic     | Implemented; caller chooses whether to abort       |
| Image/audio/video/tool token rules | No special calculation                              | Not implemented; tokenizer/provider responsibility |

## Ownership statement

This matrix does not claim full Prompt Pipeline replacement. Rows marked partial/not implemented must be covered by captured original output and approved through the main conversation's serial conformance gate before central capability ownership changes.
