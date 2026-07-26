import { describe, expect, it, vi } from 'vitest';

import { StoragePersistence } from './storage-persistence';

function manager(overrides: Partial<StorageManager>): StorageManager {
  return {
    persisted: vi.fn(async () => false),
    persist: vi.fn(async () => false),
    estimate: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as StorageManager;
}

describe('StoragePersistence', () => {
  it('requests persistence once and reports the granted mode', async () => {
    const persist = vi.fn(async () => true);
    const storage = manager({ persist });
    const persistence = new StoragePersistence(storage);

    await expect(persistence.ensure()).resolves.toMatchObject({
      mode: 'persistent',
      supported: true,
      requested: true,
      message: null,
    });
    // 重复调用不应该反复烦浏览器。
    await persistence.ensure();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('does not re-request when the origin is already persistent', async () => {
    const persist = vi.fn(async () => false);
    const persistence = new StoragePersistence(
      manager({ persisted: vi.fn(async () => true), persist }),
    );

    await expect(persistence.ensure()).resolves.toMatchObject({ mode: 'persistent' });
    expect(persist).not.toHaveBeenCalled();
  });

  it('reports best-effort with a warning when the browser declines', async () => {
    const persistence = new StoragePersistence(manager({}));
    const state = await persistence.ensure();

    expect(state.mode).toBe('best-effort');
    // 用户必须知道数据可能被整库清掉，这不是一个可以静默的状态。
    expect(state.message).toContain('evicted');
  });

  it('never throws when the browser rejects the request', async () => {
    const persistence = new StoragePersistence(
      manager({
        persisted: vi.fn(async () => {
          throw new Error('SecurityError');
        }),
      }),
    );

    await expect(persistence.ensure()).resolves.toMatchObject({
      mode: 'unknown',
      requested: true,
      message: 'SecurityError',
    });
  });

  it('degrades cleanly where StorageManager is unavailable', async () => {
    const persistence = new StoragePersistence(undefined);
    await expect(persistence.ensure()).resolves.toMatchObject({
      mode: 'unsupported',
      supported: false,
      requested: false,
    });
  });

  it('reports the native container so the panel can drop an un-actionable warning', async () => {
    // Android WebView：接口在，但永远给不了授权。
    const persistence = new StoragePersistence(manager({}), () => 'native-app');
    await expect(persistence.ensure()).resolves.toMatchObject({
      mode: 'best-effort',
      container: 'native-app',
    });
  });

  it('re-detects the container on every read', () => {
    // 启动早期原生桥可能还没注入，缓存判定结果会让安卓端一直被当成普通浏览器。
    let container: 'browser' | 'native-app' = 'browser';
    const persistence = new StoragePersistence(manager({}), () => container);
    expect(persistence.state.container).toBe('browser');
    container = 'native-app';
    expect(persistence.state.container).toBe('native-app');
  });
});
