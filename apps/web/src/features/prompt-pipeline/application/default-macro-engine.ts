import type {
  MacroContext,
  MacroExpansionResult,
  MacroVariableStore,
  OpaqueChatMessage,
  PipelineDiagnostic,
} from '../domain/prompt-pipeline';
import type { MacroEngine } from '../ports/macro-engine';
import { MemoryMacroVariableStore } from './memory-variable-store';

const DEFAULT_MAX_DEPTH = 12;

interface ExpansionState {
  readonly context: MacroContext;
  readonly diagnostics: PipelineDiagnostic[];
  readonly maxDepth: number;
}

interface ParsedMacro {
  readonly name: string;
  readonly args: readonly string[];
}

interface ResolvedMacro {
  readonly known: boolean;
  readonly replacement: string;
}

function diagnostic(
  code: string,
  severity: PipelineDiagnostic['severity'],
  message: string,
  details?: Readonly<Record<string, unknown>>,
): PipelineDiagnostic {
  return details
    ? { code, severity, message, source: 'macro-engine', details }
    : { code, severity, message, source: 'macro-engine' };
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function messageContent(message: OpaqueChatMessage | undefined): string {
  return stringifyValue(message?.content);
}

function findLastMessageByRole(
  messages: readonly OpaqueChatMessage[] | undefined,
  role: string,
): OpaqueChatMessage | undefined {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === role) return message;
  }
  return undefined;
}

function parseNumber(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return 0;
  const number = Number(value);
  return Number.isNaN(number) ? null : number;
}

function addVariable(store: MacroVariableStore, name: string, value: string): unknown {
  const current = store.get(name) || 0;
  if (typeof current === 'string') {
    try {
      const parsed = JSON.parse(current) as unknown;
      if (Array.isArray(parsed)) {
        parsed.push(value);
        const serialized = JSON.stringify(parsed);
        store.set(name, serialized);
        return parsed;
      }
    } catch {
      // Matching variables.js: non-JSON strings continue to numeric/string addition.
    }
  }

  const increment = parseNumber(value);
  const currentNumber = parseNumber(current);
  if (increment === null || currentNumber === null) {
    const concatenated = String(current || '') + value;
    store.set(name, concatenated);
    return concatenated;
  }

  const result = currentNumber + increment;
  store.set(name, result);
  return result;
}

export interface DefaultMacroEngineOptions {
  readonly localVariables?: MacroVariableStore;
  readonly globalVariables?: MacroVariableStore;
  readonly maxDepth?: number;
}

/**
 * A bounded, dependency-free macro subset. Unsupported calls stay verbatim and
 * produce diagnostics; this is deliberate so migration cannot silently erase text.
 */
export class DefaultMacroEngine implements MacroEngine {
  readonly #localVariables: MacroVariableStore;
  readonly #globalVariables: MacroVariableStore;
  readonly #maxDepth: number;

  constructor(options: DefaultMacroEngineOptions = {}) {
    this.#localVariables = options.localVariables ?? new MemoryMacroVariableStore();
    this.#globalVariables = options.globalVariables ?? new MemoryMacroVariableStore();
    this.#maxDepth = Math.max(1, Math.floor(options.maxDepth ?? DEFAULT_MAX_DEPTH));
  }

  expand(template: string, context: MacroContext = {}): MacroExpansionResult {
    const diagnostics: PipelineDiagnostic[] = [];
    const maxDepth = Math.max(1, Math.floor(context.maxDepth ?? this.#maxDepth));
    const state: ExpansionState = { context, diagnostics, maxDepth };

    // Legacy {{trim}} consumes adjacent newlines, rather than inserting text.
    const trimmed = template.replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/giu, '');
    const withLegacyAngles = this.#replaceLegacyAngleMacros(trimmed, context);
    const text = this.#expandFragment(withLegacyAngles, state, 0, []);
    return { text, diagnostics };
  }

  #replaceLegacyAngleMacros(template: string, context: MacroContext): string {
    const values: Readonly<Record<string, string>> = {
      '<USER>': context.user ?? '',
      '<BOT>': context.character ?? '',
      '<CHAR>': context.character ?? '',
      '<CHARIFNOTGROUP>': context.group ?? context.character ?? '',
      '<GROUP>': context.group ?? '',
    };
    return Object.entries(values).reduce(
      (text, [marker, value]) => text.replace(new RegExp(marker, 'giu'), value),
      template,
    );
  }

  #expandFragment(
    input: string,
    state: ExpansionState,
    depth: number,
    stack: readonly string[],
  ): string {
    let output = '';
    let cursor = 0;

    while (cursor < input.length) {
      // Explicit migration escape. The slash is consumed and the braces remain literal.
      if (input.startsWith('\\{{', cursor)) {
        output += '{{';
        cursor += 3;
        continue;
      }

      if (!input.startsWith('{{', cursor)) {
        output += input[cursor] ?? '';
        cursor += 1;
        continue;
      }

      const end = this.#findMacroEnd(input, cursor);
      if (end < 0) {
        output += input.slice(cursor);
        state.diagnostics.push(
          diagnostic('macro.unclosed', 'warning', 'Unclosed macro was preserved verbatim.', {
            offset: cursor,
          }),
        );
        break;
      }

      const raw = input.slice(cursor, end + 2);
      const inner = input.slice(cursor + 2, end);
      const parsed = this.#parseMacro(inner);
      if (!parsed.name) {
        output += raw;
        state.diagnostics.push(
          diagnostic('macro.invalid', 'warning', 'Invalid macro was preserved verbatim.', {
            raw,
          }),
        );
        cursor = end + 2;
        continue;
      }

      const normalizedName = parsed.name.toLowerCase();
      if (depth >= state.maxDepth) {
        output += raw;
        state.diagnostics.push(
          diagnostic(
            'macro.recursion-limit',
            'warning',
            `Macro expansion reached the configured depth limit (${state.maxDepth}).`,
            { macro: parsed.name, raw },
          ),
        );
        cursor = end + 2;
        continue;
      }

      const resolvedArgs = parsed.args.map((argument) =>
        this.#expandFragment(argument, state, depth + 1, stack),
      );
      const resolved = this.#resolveMacro(parsed.name, resolvedArgs, state);
      if (!resolved.known) {
        output += raw;
        state.diagnostics.push(
          diagnostic('macro.unknown', 'warning', `Unknown macro "${parsed.name}" was preserved.`, {
            macro: parsed.name,
            raw,
          }),
        );
        cursor = end + 2;
        continue;
      }

      let replacement = resolved.replacement;
      if (replacement.includes('{{')) {
        if (stack.includes(normalizedName)) {
          state.diagnostics.push(
            diagnostic(
              'macro.recursion-cycle',
              'warning',
              `Recursive macro cycle at "${parsed.name}" was stopped and preserved.`,
              { macro: parsed.name, stack },
            ),
          );
        } else {
          replacement = this.#expandFragment(replacement, state, depth + 1, [
            ...stack,
            normalizedName,
          ]);
        }
      }
      output += replacement;
      cursor = end + 2;
    }

    return output;
  }

  #findMacroEnd(input: string, start: number): number {
    let nesting = 1;
    let cursor = start + 2;
    while (cursor < input.length - 1) {
      if (input.startsWith('\\{{', cursor)) {
        cursor += 3;
        continue;
      }
      if (input.startsWith('{{', cursor)) {
        nesting += 1;
        cursor += 2;
        continue;
      }
      if (input.startsWith('}}', cursor)) {
        nesting -= 1;
        if (nesting === 0) return cursor;
        cursor += 2;
        continue;
      }
      cursor += 1;
    }
    return -1;
  }

  #parseMacro(inner: string): ParsedMacro {
    const trimmed = inner.trim();
    if (trimmed.startsWith('//')) return { name: '//', args: [trimmed.slice(2)] };

    const match = /^([A-Za-z][\w-]*)([\s\S]*)$/u.exec(trimmed);
    if (!match) return { name: '', args: [] };
    const name = match[1] ?? '';
    const remainder = match[2] ?? '';
    if (!remainder.trim()) return { name, args: [] };

    if (remainder.trimStart().startsWith('::')) {
      const argumentText = remainder.trimStart().slice(2);
      return { name, args: this.#splitDoubleColonArguments(argumentText) };
    }
    return { name, args: [remainder.trimStart()] };
  }

  #splitDoubleColonArguments(input: string): readonly string[] {
    const result: string[] = [];
    let nesting = 0;
    let start = 0;
    let cursor = 0;
    while (cursor < input.length) {
      if (input.startsWith('{{', cursor)) {
        nesting += 1;
        cursor += 2;
        continue;
      }
      if (input.startsWith('}}', cursor) && nesting > 0) {
        nesting -= 1;
        cursor += 2;
        continue;
      }
      if (nesting === 0 && input.startsWith('::', cursor)) {
        result.push(input.slice(start, cursor));
        cursor += 2;
        start = cursor;
        continue;
      }
      cursor += 1;
    }
    result.push(input.slice(start));
    return result;
  }

  #resolveMacro(name: string, args: readonly string[], state: ExpansionState): ResolvedMacro {
    const normalized = name.toLowerCase();
    const dynamic = this.#dynamicValue(normalized, state.context.values);
    if (dynamic) return dynamic;

    const contextValue = this.#contextValue(normalized, state.context);
    if (contextValue.known) return contextValue;

    switch (normalized) {
      case 'space':
        return { known: true, replacement: ' ' };
      case 'newline':
        return { known: true, replacement: '\n' };
      case 'noop':
      case 'trim':
      case '//':
      case 'comment':
        return { known: true, replacement: '' };
      case 'reverse':
        return {
          known: true,
          replacement: Array.from(args[0] ?? '')
            .reverse()
            .join(''),
        };
      case 'input':
        return { known: true, replacement: state.context.input ?? '' };
      case 'lastmessage':
        return { known: true, replacement: messageContent(state.context.messages?.at(-1)) };
      case 'lastusermessage':
        return {
          known: true,
          replacement: messageContent(findLastMessageByRole(state.context.messages, 'user')),
        };
      case 'lastcharmessage':
        return {
          known: true,
          replacement: messageContent(findLastMessageByRole(state.context.messages, 'assistant')),
        };
      case 'lastmessageid': {
        const last = state.context.messages?.at(-1);
        return {
          known: true,
          replacement: stringifyValue(last?.id ?? last?.mesid ?? ''),
        };
      }
      case 'allchatrange': {
        const length = state.context.messages?.length ?? 0;
        return { known: true, replacement: length ? `0-${length - 1}` : '' };
      }
      case 'setvar':
        return this.#setVariable(false, args, state);
      case 'setglobalvar':
        return this.#setVariable(true, args, state);
      case 'addvar':
        return this.#addVariable(false, args, false, state);
      case 'addglobalvar':
        return this.#addVariable(true, args, false, state);
      case 'incvar':
        return this.#addVariable(false, [args[0] ?? '', '1'], true, state);
      case 'incglobalvar':
        return this.#addVariable(true, [args[0] ?? '', '1'], true, state);
      case 'decvar':
        return this.#addVariable(false, [args[0] ?? '', '-1'], true, state);
      case 'decglobalvar':
        return this.#addVariable(true, [args[0] ?? '', '-1'], true, state);
      case 'getvar':
        return this.#getVariable(false, args, state);
      case 'getglobalvar':
        return this.#getVariable(true, args, state);
      case 'hasvar':
      case 'varexists':
        return this.#hasVariable(false, args, state);
      case 'hasglobalvar':
      case 'globalvarexists':
        return this.#hasVariable(true, args, state);
      case 'deletevar':
      case 'flushvar':
        return this.#deleteVariable(false, args, state);
      case 'deleteglobalvar':
      case 'flushglobalvar':
        return this.#deleteVariable(true, args, state);
      default:
        return { known: false, replacement: '' };
    }
  }

  #dynamicValue(normalized: string, values: MacroContext['values']): ResolvedMacro | null {
    if (!values) return null;
    const entry = Object.entries(values).find(([key]) => key.toLowerCase() === normalized);
    if (!entry) return null;
    const value = entry[1];
    const resolved = typeof value === 'function' ? value() : value;
    return { known: true, replacement: stringifyValue(resolved) };
  }

  #contextValue(normalized: string, context: MacroContext): ResolvedMacro {
    const instructEnabled = context.instruct?.enabled !== false;
    const values = new Map<string, unknown>([
      ['user', context.user],
      ['char', context.character],
      ['group', context.group],
      ['groupnotmuted', context.groupNotMuted ?? context.group],
      ['notchar', context.group ?? context.character],
      ['charifnotgroup', context.group ?? context.character],
      ['charprompt', context.characterPrompt],
      ['charinstruction', context.characterInstruction],
      ['chardescription', context.characterDescription],
      ['description', context.characterDescription],
      ['charpersonality', context.characterPersonality],
      ['personality', context.characterPersonality],
      ['charscenario', context.characterScenario],
      ['scenario', context.characterScenario],
      ['persona', context.persona],
      ['mesexamplesraw', context.examplesRaw],
      ['mesexamples', context.examples],
      ['chardepthprompt', context.characterDepthPrompt],
      ['charcreatornotes', context.characterCreatorNotes],
      ['creatornotes', context.characterCreatorNotes],
      ['charfirstmessage', context.characterFirstMessage],
      ['greeting', context.characterFirstMessage],
      ['charversion', context.characterVersion],
      ['model', context.model],
      ['original', context.original],
      ['authorsnote', context.authorsNote],
      ['charauthorsnote', context.characterAuthorsNote],
      ['defaultauthorsnote', context.defaultAuthorsNote],
      ['systemprompt', context.systemPrompt],
      ['defaultsystemprompt', context.defaultSystemPrompt],
      ['instructsystem', context.defaultSystemPrompt],
      ['instructsystemprompt', context.defaultSystemPrompt],
      ['maxprompt', context.maxPromptTokens],
      ['maxprompttokens', context.maxPromptTokens],
      ['maxcontext', context.maxContextTokens],
      ['maxcontexttokens', context.maxContextTokens],
      ['maxresponse', context.maxResponseTokens],
      ['maxresponsetokens', context.maxResponseTokens],
    ]);

    const instruct = context.instruct;
    const instructValues = new Map<string, unknown>([
      ['instructstorystringprefix', instruct?.storyStringPrefix],
      ['instructstorystringsuffix', instruct?.storyStringSuffix],
      ['instructuserprefix', instruct?.userPrefix],
      ['instructinput', instruct?.userPrefix],
      ['instructusersuffix', instruct?.userSuffix],
      ['instructassistantprefix', instruct?.assistantPrefix],
      ['instructoutput', instruct?.assistantPrefix],
      ['instructassistantsuffix', instruct?.assistantSuffix],
      ['instructseparator', instruct?.assistantSuffix],
      ['instructsystemprefix', instruct?.systemPrefix],
      ['instructsystemsuffix', instruct?.systemSuffix],
      ['instructfirstassistantprefix', instruct?.firstAssistantPrefix ?? instruct?.assistantPrefix],
      ['instructfirstoutput', instruct?.firstAssistantPrefix ?? instruct?.assistantPrefix],
      ['instructfirstoutputprefix', instruct?.firstAssistantPrefix ?? instruct?.assistantPrefix],
      ['instructlastassistantprefix', instruct?.lastAssistantPrefix ?? instruct?.assistantPrefix],
      ['instructlastoutput', instruct?.lastAssistantPrefix ?? instruct?.assistantPrefix],
      ['instructlastoutputprefix', instruct?.lastAssistantPrefix ?? instruct?.assistantPrefix],
      ['instructfirstuserprefix', instruct?.firstUserPrefix ?? instruct?.userPrefix],
      ['instructfirstinput', instruct?.firstUserPrefix ?? instruct?.userPrefix],
      ['instructlastuserprefix', instruct?.lastUserPrefix ?? instruct?.userPrefix],
      ['instructlastinput', instruct?.lastUserPrefix ?? instruct?.userPrefix],
      ['instructstop', instruct?.stop],
      ['instructuserfiller', instruct?.userFiller],
      ['instructsysteminstructionprefix', instruct?.systemInstructionPrefix],
    ]);
    for (const [key, value] of instructValues) values.set(key, instructEnabled ? value : '');

    if (!values.has(normalized)) return { known: false, replacement: '' };
    return { known: true, replacement: stringifyValue(values.get(normalized)) };
  }

  #variableStore(global: boolean, state: ExpansionState): MacroVariableStore {
    if (global) return state.context.globalVariables ?? this.#globalVariables;
    return state.context.localVariables ?? this.#localVariables;
  }

  #variableName(args: readonly string[], state: ExpansionState): string | null {
    const name = (args[0] ?? '').trim();
    if (name) return name;
    state.diagnostics.push(
      diagnostic('macro.invalid-arguments', 'warning', 'Variable macro requires a name.'),
    );
    return null;
  }

  #setVariable(global: boolean, args: readonly string[], state: ExpansionState): ResolvedMacro {
    const name = this.#variableName(args, state);
    if (!name) return { known: true, replacement: '' };
    this.#variableStore(global, state).set(name, args[1] ?? '');
    return { known: true, replacement: '' };
  }

  #addVariable(
    global: boolean,
    args: readonly string[],
    returnValue: boolean,
    state: ExpansionState,
  ): ResolvedMacro {
    const name = this.#variableName(args, state);
    if (!name) return { known: true, replacement: '' };
    const result = addVariable(this.#variableStore(global, state), name, args[1] ?? '');
    return { known: true, replacement: returnValue ? stringifyValue(result) : '' };
  }

  #getVariable(global: boolean, args: readonly string[], state: ExpansionState): ResolvedMacro {
    const name = this.#variableName(args, state);
    if (!name) return { known: true, replacement: '' };
    return {
      known: true,
      replacement: stringifyValue(this.#variableStore(global, state).get(name)),
    };
  }

  #hasVariable(global: boolean, args: readonly string[], state: ExpansionState): ResolvedMacro {
    const name = this.#variableName(args, state);
    return {
      known: true,
      replacement: String(!!name && this.#variableStore(global, state).has(name)),
    };
  }

  #deleteVariable(global: boolean, args: readonly string[], state: ExpansionState): ResolvedMacro {
    const name = this.#variableName(args, state);
    if (name) this.#variableStore(global, state).delete(name);
    return { known: true, replacement: '' };
  }
}
