import {
  cloneJson,
  defaultChatHeader,
  isJsonObject,
  serializeJsonl,
  type ChatDocument,
  type OpaqueJsonObject,
} from '../domain/chat';
import type { ChatImportContext, ChatImportExportPort } from '../ports/chat-import-export-port';

export const MAX_CHAT_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_CHAT_JSONL_LINE_BYTES = 5 * 1024 * 1024;
export const MAX_CHAT_IMPORT_MESSAGES = 100_000;

export class ChatImportError extends Error {}

export class BrowserChatImportExportAdapter implements ChatImportExportPort {
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  async import(file: Blob, context: ChatImportContext): Promise<ChatDocument[]> {
    if (!(file instanceof Blob) || file.size === 0) {
      throw new ChatImportError('A non-empty chat file is required.');
    }
    if (file.size > MAX_CHAT_IMPORT_BYTES) {
      throw new ChatImportError(`Chat import exceeds ${MAX_CHAT_IMPORT_BYTES} bytes.`);
    }

    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      throw new ChatImportError(`Could not read chat import: ${String(error)}`);
    }

    return context.fileType === 'jsonl' ? [this.#parseJsonl(text)] : this.#parseJson(text, context);
  }

  export(document: ChatDocument, format: 'jsonl' | 'txt'): string {
    if (format === 'jsonl') return serializeJsonl(document);
    if (format !== 'txt') throw new ChatImportError(`Unsupported chat export format: ${format}.`);

    let result = '';
    for (const message of document.messages) {
      if (message.is_system) continue;
      if (!message.mes) continue;
      const extra = isJsonObject(message.extra) ? message.extra : null;
      const displayText = typeof extra?.display_text === 'string' ? extra.display_text : null;
      const text = displayText ?? String(message.mes);
      result += `${String(message.name ?? '')}: ${text.replace(/\r?\n/gu, '\n')}\n\n`;
    }
    return result;
  }

  #parseJsonl(text: string): ChatDocument {
    const lines = text.split(/\r?\n/gu).filter((line) => line.trim().length > 0);
    if (lines.length === 0) throw new ChatImportError('Chat JSONL is empty.');
    if (lines.length - 1 > MAX_CHAT_IMPORT_MESSAGES) {
      throw new ChatImportError(`Chat import exceeds ${MAX_CHAT_IMPORT_MESSAGES} messages.`);
    }

    const values = lines.map((line, index) => {
      if (new TextEncoder().encode(line).byteLength > MAX_CHAT_JSONL_LINE_BYTES) {
        throw new ChatImportError(`Chat JSONL line ${index + 1} is too large.`);
      }
      try {
        const value = JSON.parse(line) as unknown;
        if (!isJsonObject(value)) throw new Error('line is not an object');
        return value;
      } catch (error) {
        throw new ChatImportError(`Invalid chat JSONL on line ${index + 1}: ${String(error)}`);
      }
    });

    const [header, ...messages] = values;
    if (!header) throw new ChatImportError('Chat JSONL is empty.');
    if (
      header.user_name === undefined &&
      header.name === undefined &&
      header.chat_metadata === undefined
    ) {
      throw new ChatImportError('Chat JSONL header is not recognized.');
    }

    return {
      header: cloneJson(header),
      messages: messages.map(flattenChubMessage),
    };
  }

  #parseJson(text: string, context: ChatImportContext): ChatDocument[] {
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new ChatImportError(`Invalid chat JSON: ${String(error)}`);
    }
    if (!isJsonObject(value)) throw new ChatImportError('Chat JSON root must be an object.');

    if (value.savedsettings !== undefined) return [this.#convertKoboldLite(value)];
    if (value.histories !== undefined) return this.#convertCaiTools(value, context);
    if (Array.isArray(value.data_visible)) return [this.#convertOoba(value, context)];
    if (Array.isArray(value.messages)) return [this.#convertAgnai(value, context)];
    if (value.type === 'risuChat') return [this.#convertRisu(value, context)];
    throw new ChatImportError('Chat JSON format is not recognized.');
  }

  #convertOoba(value: OpaqueJsonObject, context: ChatImportContext): ChatDocument {
    const messages: OpaqueJsonObject[] = [];
    for (const pair of value.data_visible as unknown[]) {
      if (!Array.isArray(pair)) continue;
      if (pair[0]) messages.push(this.#convertedMessage(context.userName, true, pair[0]));
      if (pair[1]) messages.push(this.#convertedMessage(context.characterName, false, pair[1]));
    }
    return { header: defaultChatHeader(), messages };
  }

  #convertAgnai(value: OpaqueJsonObject, context: ChatImportContext): ChatDocument {
    const messages = (value.messages as unknown[]).filter(isJsonObject).map((message) => {
      const isUser = Boolean(message.userId);
      return this.#convertedMessage(
        isUser ? context.userName : context.characterName,
        isUser,
        message.msg,
      );
    });
    return { header: defaultChatHeader(), messages };
  }

  #convertCaiTools(value: OpaqueJsonObject, context: ChatImportContext): ChatDocument[] {
    const histories = isJsonObject(value.histories) ? value.histories.histories : null;
    if (!Array.isArray(histories)) throw new ChatImportError('CAI Tools histories are invalid.');

    return histories.filter(isJsonObject).map((history) => {
      const sourceMessages = Array.isArray(history.msgs) ? history.msgs : [];
      const messages = sourceMessages.filter(isJsonObject).map((message) => {
        const source = isJsonObject(message.src) ? message.src : {};
        const isUser = Boolean(source.is_human);
        return this.#convertedMessage(
          isUser ? context.userName : context.characterName,
          isUser,
          message.text,
        );
      });
      return { header: defaultChatHeader(), messages };
    });
  }

  #convertKoboldLite(value: OpaqueJsonObject): ChatDocument {
    const settings = isJsonObject(value.savedsettings) ? value.savedsettings : {};
    const userName = String(settings.chatname ?? 'User');
    const characterName =
      String(settings.chatopponent ?? 'Character').split('||$||')[0] || 'Character';
    const inputToken = '{{[INPUT]}}';
    const outputToken = '{{[OUTPUT]}}';
    const convert = (raw: unknown) => {
      const text = String(raw ?? '');
      const isUser = text.includes(inputToken);
      return this.#convertedMessage(
        isUser ? userName : characterName,
        isUser,
        text.replaceAll(inputToken, '').replaceAll(outputToken, '').trim(),
      );
    };
    const messages = (Array.isArray(value.actions) ? value.actions : []).map(convert);
    if (value.prompt) messages.unshift(convert(value.prompt));
    return { header: defaultChatHeader(), messages };
  }

  #convertRisu(value: OpaqueJsonObject, context: ChatImportContext): ChatDocument {
    const data = isJsonObject(value.data) ? value.data : {};
    const sourceMessages = Array.isArray(data.message) ? data.message : [];
    const messages = sourceMessages.filter(isJsonObject).map((message) => {
      const isUser = message.role === 'user';
      const timestamp = Number(message.time ?? this.#now().getTime());
      return {
        name: String(message.name ?? (isUser ? context.userName : context.characterName)),
        is_user: isUser,
        send_date: new Date(
          Number.isFinite(timestamp) ? timestamp : this.#now().getTime(),
        ).toISOString(),
        mes: message.data ?? '',
        extra: {},
      };
    });
    return { header: defaultChatHeader(), messages };
  }

  #convertedMessage(name: string, isUser: boolean, message: unknown): OpaqueJsonObject {
    return {
      name,
      is_user: isUser,
      send_date: this.#now().toISOString(),
      mes: String(message ?? ''),
      extra: {},
    };
  }
}

function flattenChubMessage(message: OpaqueJsonObject): OpaqueJsonObject {
  const flattened = cloneJson(message);
  if (isJsonObject(flattened.mes) && flattened.mes.message !== undefined) {
    flattened.mes = flattened.mes.message;
  }
  if (Array.isArray(flattened.swipes)) {
    flattened.swipes = flattened.swipes.map((swipe) =>
      isJsonObject(swipe) && swipe.message !== undefined ? swipe.message : swipe,
    );
  }
  return flattened;
}
