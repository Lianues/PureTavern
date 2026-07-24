import { describe, expect, it } from 'vitest';

import {
  BrowserChatImportExportAdapter,
  ChatImportError,
} from '../infrastructure/chat-import-export-adapter';

const fixedNow = new Date('2026-07-24T02:00:00.000Z');

function jsonFile(value: unknown): Blob {
  return new Blob([JSON.stringify(value)], { type: 'application/json' });
}

describe('BrowserChatImportExportAdapter', () => {
  it('parses native JSONL line-by-line, validates its header and flattens Chub swipe values', async () => {
    const codec = new BrowserChatImportExportAdapter(() => fixedNow);
    const source = [
      JSON.stringify({
        chat_metadata: { integrity: 'slug', future: { keep: true } },
        user_name: 'unused',
        character_name: 'unused',
        unknown_header: 1,
      }),
      JSON.stringify({
        name: 'Bot',
        mes: { message: 'primary', id: 1 },
        swipes: [{ message: 'first' }, 'second'],
        swipe_info: [{ extra: { retain: true } }],
        extra: { bookmark_link: 'branch' },
        future: ['opaque'],
      }),
    ].join('\n');

    const [document] = await codec.import(new Blob([source]), {
      fileType: 'jsonl',
      userName: 'User',
      characterName: 'Bot',
    });
    expect(document).toEqual({
      header: {
        chat_metadata: { integrity: 'slug', future: { keep: true } },
        user_name: 'unused',
        character_name: 'unused',
        unknown_header: 1,
      },
      messages: [
        {
          name: 'Bot',
          mes: 'primary',
          swipes: ['first', 'second'],
          swipe_info: [{ extra: { retain: true } }],
          extra: { bookmark_link: 'branch' },
          future: ['opaque'],
        },
      ],
    });
    expect(codec.export(document!, 'jsonl')).toContain('"unknown_header":1');

    await expect(
      codec.import(new Blob(['{"not":"a header"}\n{"mes":"x"}']), {
        fileType: 'jsonl',
        userName: 'User',
        characterName: 'Bot',
      }),
    ).rejects.toThrow('header is not recognized');
    await expect(
      codec.import(new Blob(['{"chat_metadata":{}}\nnot-json']), {
        fileType: 'jsonl',
        userName: 'User',
        characterName: 'Bot',
      }),
    ).rejects.toThrow('line 2');
  });

  it.each([
    ['Ooba', { data_visible: [['hello', 'hi']] }, ['User:hello', 'Bot:hi']],
    [
      'Agnai',
      { messages: [{ userId: 'u', msg: 'hello' }, { msg: 'hi' }] },
      ['User:hello', 'Bot:hi'],
    ],
    [
      'Kobold Lite',
      {
        savedsettings: { chatname: 'KUser', chatopponent: 'KBot||$||meta' },
        prompt: '{{[INPUT]}} prompt',
        actions: ['{{[OUTPUT]}} reply'],
      },
      ['KUser:prompt', 'KBot:reply'],
    ],
    [
      'RisuAI',
      {
        type: 'risuChat',
        data: {
          message: [
            { role: 'user', data: 'hello', time: fixedNow.getTime() },
            { role: 'assistant', data: 'hi', name: 'Risu Bot', time: fixedNow.getTime() },
          ],
        },
      },
      ['User:hello', 'Risu Bot:hi'],
    ],
  ])('converts %s JSON chat input', async (_name, source, expected) => {
    const codec = new BrowserChatImportExportAdapter(() => fixedNow);
    const [document] = await codec.import(jsonFile(source), {
      fileType: 'json',
      userName: 'User',
      characterName: 'Bot',
    });
    expect(document?.messages.map((message) => `${message.name}:${message.mes}`)).toEqual(expected);
  });

  it('converts each CAI Tools history into an independent chat', async () => {
    const codec = new BrowserChatImportExportAdapter(() => fixedNow);
    const documents = await codec.import(
      jsonFile({
        histories: {
          histories: [
            { msgs: [{ src: { is_human: true }, text: 'one' }] },
            { msgs: [{ src: { is_human: false }, text: 'two' }] },
          ],
        },
      }),
      { fileType: 'json', userName: 'User', characterName: 'Bot' },
    );
    expect(documents).toHaveLength(2);
    expect(documents[0]?.messages[0]?.name).toBe('User');
    expect(documents[1]?.messages[0]?.name).toBe('Bot');
  });

  it('exports JSONL losslessly and TXT without hidden system messages', () => {
    const codec = new BrowserChatImportExportAdapter(() => fixedNow);
    const document = {
      header: { chat_metadata: { custom: true }, future: 1 },
      messages: [
        { name: 'Hidden', mes: 'secret', is_system: true, extra: {} },
        { name: 'User', mes: 'raw', extra: { display_text: 'display\ntext', future: 1 } },
        { name: 'Bot', mes: 'reply', swipes: ['reply', 'other'] },
      ],
    };
    const jsonl = codec.export(document, 'jsonl');
    expect(jsonl.split('\n').map((line) => JSON.parse(line))).toEqual([
      document.header,
      ...document.messages,
    ]);
    expect(codec.export(document, 'txt')).toBe('User: display\ntext\n\nBot: reply\n\n');
  });

  it('rejects empty and unknown chat imports', async () => {
    const codec = new BrowserChatImportExportAdapter(() => fixedNow);
    await expect(
      codec.import(new Blob([]), {
        fileType: 'jsonl',
        userName: 'User',
        characterName: 'Bot',
      }),
    ).rejects.toBeInstanceOf(ChatImportError);
    await expect(
      codec.import(jsonFile({ unknown: true }), {
        fileType: 'json',
        userName: 'User',
        characterName: 'Bot',
      }),
    ).rejects.toThrow('not recognized');
  });
});
