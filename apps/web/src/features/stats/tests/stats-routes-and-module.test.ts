import { afterEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '@/platform/features/capability-registry';
import { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { AppDatabase } from '@/platform/storage/app-database';
import { AppStorage } from '@/platform/storage/app-storage';
import { initializeStorage } from '@/platform/storage/initialize-storage';

import { chatsFeature } from '../../chats/module';
import { StatsService } from '../application/stats-service';
import { MemoryStatsRepository } from '../infrastructure/resilient-stats-repository';
import { registerStatsLegacyRoutes } from '../legacy/register-routes';
import { statsFeature } from '../module';

const databases: AppDatabase[] = [];

const emptySource = {
  async listChatsForStats() {
    return [];
  },
};

async function post(
  router: CompatibilityRouter,
  pathname: string,
  body: unknown = {},
): Promise<Response> {
  const url = new URL(pathname, 'https://app.example');
  const request = new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const response = await router.dispatch(request, url);
  if (!response) throw new Error(`Route was not handled: ${pathname}`);
  return response;
}

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('Stats Legacy routes', () => {
  it('implements get, update and recreate with original status/body shapes', async () => {
    const router = new CompatibilityRouter();
    const service = new StatsService(new MemoryStatsRepository(), emptySource, { now: () => 99 });
    registerStatsLegacyRoutes(router, service);

    const first = await post(router, '/api/stats/get');
    await expect(first.json()).resolves.toEqual({ timestamp: 99 });

    const update = await post(router, '/api/stats/update', {
      'Alice.png': { user_msg_count: 2 },
    });
    expect(update.status).toBe(200);
    expect(await update.text()).toBe('');
    await expect((await post(router, '/api/stats/get')).json()).resolves.toMatchObject({
      'Alice.png': { user_msg_count: 2 },
      timestamp: 99,
    });

    const recreate = await post(router, '/api/stats/recreate');
    expect(recreate.status).toBe(200);
    expect(await recreate.text()).toBe('');
    await expect((await post(router, '/api/stats/get')).json()).resolves.toEqual({ timestamp: 99 });
  });

  it('returns bounded 400 responses for malformed updates', async () => {
    const router = new CompatibilityRouter();
    registerStatsLegacyRoutes(router, new StatsService(new MemoryStatsRepository(), emptySource));
    const response = await post(router, '/api/stats/update', '{broken');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ pureTavern: true });
  });
});

describe('Stats feature module', () => {
  it('derives and persists stats through the read-only Chats capability', async () => {
    const database = new AppDatabase(`pure-tavern-stats-module-${crypto.randomUUID()}`);
    databases.push(database);
    const storage = new AppStorage(database);
    await initializeStorage(storage);
    const router = new CompatibilityRouter();
    const capabilities = new CapabilityRegistry();

    chatsFeature.install({
      router,
      nativeFetch: window.fetch.bind(window),
      records: storage.records.forModule('chats'),
      blobs: storage.blobs.forModule('chats'),
      capabilities,
    });
    await post(router, '/api/chats/save', {
      ch_name: 'Alice',
      file_name: 'stats-chat',
      avatar_url: 'Alice.png',
      chat: [
        { chat_metadata: {}, user_name: 'User', character_name: 'Alice' },
        {
          name: 'User',
          is_user: true,
          mes: 'hello stats',
          send_date: '2026-07-24T00:00:00.000Z',
        },
        {
          name: 'Alice',
          is_user: false,
          mes: 'hello user',
          send_date: '2026-07-24T00:00:01.000Z',
        },
      ],
    });

    const result = statsFeature.install({
      router,
      nativeFetch: window.fetch.bind(window),
      records: storage.records.forModule('stats'),
      blobs: storage.blobs.forModule('stats'),
      capabilities,
    });
    expect(result.diagnostics).toMatchObject({
      storage: { status: 'ready', backend: 'indexeddb' },
      chatSource: { status: 'ready' },
      consistency: { blocksChatWrites: false },
    });

    expect((await post(router, '/api/stats/recreate')).status).toBe(200);
    const stats = (await (await post(router, '/api/stats/get')).json()) as Record<string, unknown>;
    expect(stats['Alice.png']).toMatchObject({
      user_msg_count: 1,
      non_user_msg_count: 1,
      user_word_count: 2,
      non_user_word_count: 2,
    });
    expect(await storage.records.forModule('stats').get('documents', 'current')).not.toBeNull();
  });
});
