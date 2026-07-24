import { describe, expect, it } from 'vitest';

import type { ModuleRecordStore } from '@/platform/storage/app-storage';

import {
  seedDefaultBackgrounds,
  type DefaultBackgroundSeedDiagnostics,
} from '../infrastructure/default-background-seeder';
import { bytesFromBase64, createMemoryHarness, ONE_BY_ONE_PNG_BASE64 } from './test-helpers';

function createRecordStoreStub(): ModuleRecordStore {
  const values = new Map<string, unknown>();
  return {
    async get<T>(collection: string, id: string) {
      const value = values.get(`${collection}\u001f${id}`);
      return value === undefined
        ? null
        : { id, value: structuredClone(value) as T, updatedAt: new Date().toISOString() };
    },
    async put<T>(collection: string, id: string, value: T) {
      values.set(`${collection}\u001f${id}`, structuredClone(value));
    },
  } as unknown as ModuleRecordStore;
}

function diagnostics(): DefaultBackgroundSeedDiagnostics {
  return { status: 'pending', seeded: 0, message: null };
}

describe('seedDefaultBackgrounds', () => {
  it('seeds new upstream defaults once and preserves user deletion as a tombstone', async () => {
    let names = ['default.png'];
    const nativeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/__pure_tavern/default-assets.json')) {
        return new Response(
          JSON.stringify({
            version: 1,
            backgrounds: names.map((name) => ({ name, sourceHash: 'a'.repeat(64) })),
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(Uint8Array.from(bytesFromBase64(ONE_BY_ONE_PNG_BASE64)).buffer, {
        headers: { 'Content-Type': 'image/png' },
      });
    }) as typeof fetch;
    const records = createRecordStoreStub();
    const { service } = createMemoryHarness(nativeFetch);

    const first = diagnostics();
    await seedDefaultBackgrounds(service, records, nativeFetch, first);
    expect(first).toMatchObject({ status: 'ready', seeded: 1, message: null });
    await expect(service.listBackgrounds()).resolves.toMatchObject({
      images: [{ filename: 'default.png' }],
    });

    await service.deleteBackground('default.png');
    const afterDelete = diagnostics();
    await seedDefaultBackgrounds(service, records, nativeFetch, afterDelete);
    expect(afterDelete.seeded).toBe(0);
    await expect(service.listBackgrounds()).resolves.toMatchObject({ images: [] });

    names = ['default.png', 'new-default.png'];
    const afterUpgrade = diagnostics();
    await seedDefaultBackgrounds(service, records, nativeFetch, afterUpgrade);
    expect(afterUpgrade.seeded).toBe(1);
    await expect(service.listBackgrounds()).resolves.toMatchObject({
      images: [{ filename: 'new-default.png' }],
    });
  });
});
