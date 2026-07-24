import { describe, expect, it } from 'vitest';

import { CapabilityRegistry, defineCapability } from '@/platform/features/capability-registry';
import { CompatibilityRouter } from '@/platform/legacy/compatibility-router';

import { ChatService } from '../application/chat-service';
import { OwnerIdentityResolver } from '../application/owner-identity-resolver';
import { BrowserChatImportExportAdapter } from '../infrastructure/chat-import-export-adapter';
import {
  MemoryChatRepository,
  MemoryMessageRepository,
  MemoryOwnerAliasRepository,
} from '../infrastructure/resilient-repositories';
import { registerChatsLegacyRoutes } from '../legacy/register-routes';

function createRouterHarness() {
  let id = 0;
  const service = new ChatService(
    new MemoryChatRepository(),
    new MemoryMessageRepository(),
    new OwnerIdentityResolver(new MemoryOwnerAliasRepository()),
    new BrowserChatImportExportAdapter(() => new Date('2026-07-24T00:00:00.000Z')),
    () => new Date('2026-07-24T00:00:00.000Z'),
    () => `id-${++id}`,
  );
  const router = new CompatibilityRouter();
  registerChatsLegacyRoutes(router, service);
  return { router, service };
}

async function postJson(
  router: CompatibilityRouter,
  pathname: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const url = new URL(`https://example.test${pathname}`);
  const response = await router.dispatch(
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    url,
  );
  if (!response) throw new Error(`Route was not handled: ${pathname}`);
  return response;
}

describe('Chats Legacy routes', () => {
  it('serves save/get/list/search/recent/rename/export/delete DTOs', async () => {
    const { router } = createRouterHarness();
    const chat = [
      {
        chat_metadata: { integrity: 'slug', metadata: true },
        user_name: 'unused',
        character_name: 'unused',
      },
      {
        name: 'Alice',
        is_user: false,
        send_date: '2026-07-24T00:00:00.000Z',
        mes: 'hello route',
        extra: {},
      },
    ];

    expect(
      await (
        await postJson(router, '/api/chats/save', {
          ch_name: 'Alice',
          file_name: 'main',
          avatar_url: 'Alice.png',
          chat,
        })
      ).json(),
    ).toEqual({ ok: true });
    expect(
      await (
        await postJson(router, '/api/chats/get', {
          ch_name: 'Alice',
          file_name: 'main',
          avatar_url: 'Alice.png',
        })
      ).json(),
    ).toEqual(chat);
    expect(
      await (
        await postJson(router, '/api/characters/chats', {
          avatar_url: 'Alice.png',
          metadata: true,
        })
      ).json(),
    ).toMatchObject([
      {
        file_name: 'main.jsonl',
        file_id: 'main',
        chat_items: 1,
        chat_metadata: { integrity: 'slug', metadata: true },
      },
    ]);
    expect(
      await (
        await postJson(router, '/api/chats/search', {
          query: 'hello route',
          avatar_url: 'Alice.png',
          group_id: null,
        })
      ).json(),
    ).toMatchObject([{ file_name: 'main', message_count: 1 }]);
    expect(
      await (await postJson(router, '/api/chats/recent', { max: 10, pinned: [] })).json(),
    ).toMatchObject([{ avatar: 'Alice.png', file_name: 'main.jsonl', chat_items: 1 }]);

    expect(
      await (
        await postJson(router, '/api/chats/rename', {
          is_group: false,
          avatar_url: 'Alice.png',
          original_file: 'main.jsonl',
          renamed_file: 'renamed.jsonl',
        })
      ).json(),
    ).toEqual({ ok: true, sanitizedFileName: 'renamed' });
    const exported = await (
      await postJson(router, '/api/chats/export', {
        is_group: false,
        avatar_url: 'Alice.png',
        file: 'renamed.jsonl',
        exportfilename: 'renamed.txt',
        format: 'txt',
      })
    ).json();
    expect(exported).toEqual({
      message: 'Chat saved to renamed.txt',
      result: 'Alice: hello route\n\n',
    });

    expect(
      await (
        await postJson(router, '/api/chats/delete', {
          chatfile: 'renamed.jsonl',
          avatar_url: 'Alice.png',
        })
      ).json(),
    ).toEqual({ ok: true });
    expect(
      await (
        await postJson(router, '/api/chats/get', {
          file_name: 'renamed',
          avatar_url: 'Alice.png',
        })
      ).json(),
    ).toEqual([]);
  });

  it('imports multipart JSONL and reports validation/integrity errors with upstream-compatible status', async () => {
    const { router } = createRouterHarness();
    const formData = new FormData();
    formData.append('file_type', 'jsonl');
    formData.append('avatar_url', 'Alice.png');
    formData.append('character_name', 'Alice');
    formData.append('user_name', 'User');
    formData.append(
      'file',
      new File(
        [
          '{"chat_metadata":{"integrity":"imported"},"user_name":"unused","character_name":"unused"}\n',
          '{"name":"Alice","is_user":false,"mes":"imported message","extra":{}}',
        ],
        'import.jsonl',
        { type: 'application/jsonl' },
      ),
    );
    const url = new URL('https://example.test/api/chats/import');
    const importRequest = new Request(url, { method: 'POST' });
    Object.defineProperty(importRequest, 'formData', { value: async () => formData });
    const response = await router.dispatch(importRequest, url);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      res: true,
      fileNames: [expect.stringMatching(/\.jsonl$/u)],
    });

    const invalid = await postJson(router, '/api/chats/save', {
      avatar_url: 'Alice.png',
      file_name: 'bad',
      chat: 'not-an-array',
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: true });

    await postJson(router, '/api/chats/save', {
      avatar_url: 'Alice.png',
      file_name: 'integrity',
      chat: [{ chat_metadata: { integrity: 'one' } }],
    });
    const conflict = await postJson(router, '/api/chats/save', {
      avatar_url: 'Alice.png',
      file_name: 'integrity',
      chat: [{ chat_metadata: { integrity: 'two' } }],
    });
    expect(conflict.status).toBe(400);
    expect(await conflict.json()).toEqual({ error: 'integrity' });
  });

  it('leaves group subpaths unregistered and rejects group-shaped calls on shared routes', async () => {
    const { router } = createRouterHarness();
    const groupPath = '/api/chats/group/get';
    const groupUrl = new URL(`https://example.test${groupPath}`);
    const response = await router.dispatch(
      new Request(groupUrl, { method: 'POST', body: '{}' }),
      groupUrl,
    );
    expect(response?.status).toBe(501);
    expect(router.diagnostics.unhandledEndpoints).toContain(`POST ${groupPath}`);

    const shared = await postJson(router, '/api/chats/export', {
      is_group: true,
      file: 'group.jsonl',
      format: 'jsonl',
    });
    expect(shared.status).toBe(501);
    expect(await shared.json()).toMatchObject({ error: 'Group chats are not migrated by M05.' });
  });
});

describe('CapabilityRegistry', () => {
  it('registers and resolves typed optional capabilities and rejects duplicate providers', () => {
    interface ProbeCapability {
      read(): string;
    }
    const token = defineCapability<ProbeCapability>('test.probe.v1');
    const registry = new CapabilityRegistry();
    expect(registry.get(token)).toBeNull();
    registry.register(token, { read: () => 'ok' });
    expect(registry.has(token)).toBe(true);
    expect(registry.get(token)?.read()).toBe('ok');
    expect(() => registry.register(token, { read: () => 'duplicate' })).toThrow(
      'registered more than once',
    );
  });
});
