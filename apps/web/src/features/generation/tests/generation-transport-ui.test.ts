import { afterEach, describe, expect, it, vi } from 'vitest';

import { GenerationTransportState } from '../application/generation-transport-state';
import {
  installGenerationTransportUi,
  isNativePureTavernApp,
} from '../runtime/generation-transport-ui';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

function connectionProfilePanel(): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'wide100p';
  panel.innerHTML = `
    <div class="flex-container alignItemsBaseline">
      <h3><span data-i18n="Connection Profile">API 连接配置</span></h3>
    </div>
    <div class="flex-container" data-testid="legacy-profile-row">
      <select class="text_pole flex1" id="connection_profiles"></select>
    </div>
  `;
  return panel;
}

function install(isNativeApp = false) {
  const state = new GenerationTransportState();
  const connector = { connect: vi.fn(async () => undefined) };
  disposers.push(
    installGenerationTransportUi(state, connector, { isNativeApp: () => isNativeApp }),
  );
  return { state, connector };
}

describe('generation transport Connection Profile hook', () => {
  it('injects above the Legacy flex row and omits local backend mode on Web', async () => {
    install(false);
    const panel = connectionProfilePanel();
    document.body.append(panel);
    await flushMutationObserver();

    const root = panel.querySelector<HTMLElement>('#pure_tavern_generation_transport');
    const legacyRow = panel.querySelector<HTMLElement>('[data-testid="legacy-profile-row"]');
    const mode = panel.querySelector<HTMLSelectElement>('#pure_tavern_generation_transport_mode');
    expect(root).not.toBeNull();
    expect(root?.nextElementSibling).toBe(legacyRow);
    expect(Array.from(mode?.options ?? []).map((option) => option.textContent)).toEqual([
      '当前前端调用',
      '远程后端调用',
    ]);
    expect(mode?.querySelector('option[value="local"]')).toBeNull();
  });

  it('shows a disabled local placeholder in native apps', () => {
    document.body.append(connectionProfilePanel());
    install(true);

    const local = document.querySelector<HTMLOptionElement>('option[value="local"]');
    expect(local?.textContent).toBe('本地后端调用');
    expect(local?.disabled).toBe(true);
  });

  it('reveals the remote button and panel, then passes in-memory URL and key to connect', async () => {
    document.body.append(connectionProfilePanel());
    const { state, connector } = install(false);
    const mode = document.querySelector<HTMLSelectElement>(
      '#pure_tavern_generation_transport_mode',
    )!;
    const toggle = document.querySelector<HTMLButtonElement>('#pure_tavern_remote_backend_toggle')!;
    const panel = document.querySelector<HTMLFormElement>('#pure_tavern_remote_backend_panel')!;
    const url = document.querySelector<HTMLInputElement>('#pure_tavern_remote_backend_url')!;
    const key = document.querySelector<HTMLInputElement>('#pure_tavern_remote_backend_key')!;
    const connect = document.querySelector<HTMLButtonElement>(
      '#pure_tavern_remote_backend_connect',
    )!;

    expect(getComputedStyle(connect).whiteSpace).toBe('nowrap');
    expect(getComputedStyle(connect).wordBreak).toBe('keep-all');
    expect(toggle.hidden).toBe(true);
    mode.value = 'remote';
    mode.dispatchEvent(new Event('change'));
    expect(state.mode).toBe('remote');
    expect(toggle.hidden).toBe(false);

    toggle.click();
    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    url.value = 'http://192.168.1.8:8000';
    url.dispatchEvent(new Event('input'));
    key.value = 'session-only-key';
    key.dispatchEvent(new Event('input'));
    panel.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(connector.connect).toHaveBeenCalledTimes(1);
    expect(state.snapshot.remote).toMatchObject({
      url: 'http://192.168.1.8:8000',
      key: 'session-only-key',
      status: 'disconnected',
    });
    expect(localStorage.length).toBe(0);
  });

  it('reinjects after the dynamic Legacy panel is replaced without losing runtime state', async () => {
    const first = connectionProfilePanel();
    document.body.append(first);
    const { state } = install(false);
    state.setMode('remote');
    state.updateRemoteConfig('http://127.0.0.1:8000', 'memory-key');

    first.remove();
    const second = connectionProfilePanel();
    document.body.append(second);
    await flushMutationObserver();

    expect(document.querySelectorAll('#pure_tavern_generation_transport')).toHaveLength(1);
    expect(
      document.querySelector<HTMLSelectElement>('#pure_tavern_generation_transport_mode')?.value,
    ).toBe('remote');
    expect(document.querySelector<HTMLInputElement>('#pure_tavern_remote_backend_url')?.value).toBe(
      'http://127.0.0.1:8000',
    );
    expect(document.querySelector<HTMLInputElement>('#pure_tavern_remote_backend_key')?.value).toBe(
      'memory-key',
    );
  });
});

describe('native shell detection', () => {
  it('recognizes Capacitor, Tauri and Harmony without treating a plain Web scope as native', () => {
    expect(isNativePureTavernApp({})).toBe(false);
    expect(isNativePureTavernApp({ Capacitor: { isNativePlatform: () => true } })).toBe(true);
    expect(isNativePureTavernApp({ __TAURI_INTERNALS__: {} })).toBe(true);
    expect(isNativePureTavernApp({ __PURE_TAVERN_PLATFORM__: 'harmony' })).toBe(true);
  });
});

async function flushMutationObserver(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
