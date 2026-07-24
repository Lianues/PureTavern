import { describe, expect, it, vi } from 'vitest';

import { checkForRuntimeUpdate } from './runtime-update';

const currentBuildId = 'aaaaaaaaaaaaaaaa';
const nextBuildId = 'bbbbbbbbbbbbbbbb';

describe('runtime update checks', () => {
  it('keeps the page when the deployed runtime matches', async () => {
    const storage = createStorage([[reloadKey(), currentBuildId]]);
    const reload = vi.fn();

    await expect(
      checkForRuntimeUpdate({
        currentBuildId,
        nativeFetch: jsonFetch({ buildId: currentBuildId }),
        storage,
        reload,
      }),
    ).resolves.toBe('current');
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(reloadKey())).toBeNull();
  });

  it('forces one reload when a newer build is deployed', async () => {
    const storage = createStorage();
    const reload = vi.fn();
    const options = {
      currentBuildId,
      nativeFetch: jsonFetch({ buildId: nextBuildId }),
      storage,
      reload,
    };

    await expect(checkForRuntimeUpdate(options)).resolves.toBe('reloading');
    expect(storage.getItem(reloadKey())).toBe(nextBuildId);
    expect(reload).toHaveBeenCalledOnce();

    await expect(checkForRuntimeUpdate(options)).resolves.toBe('reload-suppressed');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not reload for unavailable or malformed version responses', async () => {
    const reload = vi.fn();
    await expect(
      checkForRuntimeUpdate({
        currentBuildId,
        nativeFetch: jsonFetch({ buildId: '../unsafe' }),
        storage: createStorage(),
        reload,
      }),
    ).resolves.toBe('unavailable');
    expect(reload).not.toHaveBeenCalled();
  });
});

function jsonFetch(value: unknown): typeof fetch {
  return vi.fn(async () =>
    Promise.resolve(
      new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  ) as typeof fetch;
}

function createStorage(entries: readonly (readonly [string, string])[] = []) {
  const values = new Map(entries);
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

function reloadKey(): string {
  return 'pure-tavern.runtime-reload-attempt';
}
