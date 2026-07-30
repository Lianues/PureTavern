import type {
  GenerationTransportSnapshot,
  GenerationTransportState,
} from '../application/generation-transport-state';

const PROFILE_SELECT_SELECTOR = '#connection_profiles';
const UI_ROOT_ID = 'pure_tavern_generation_transport';
const STYLE_ID = 'pure_tavern_generation_transport_style';

export interface RemoteBackendConnector {
  connect(): Promise<void>;
}

export interface GenerationTransportUiOptions {
  isNativeApp?: () => boolean;
}

interface PlatformGlobals {
  Capacitor?: {
    isNativePlatform?: () => boolean;
  };
  __PURE_TAVERN_PLATFORM__?: unknown;
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
}

interface UiBinding {
  root: HTMLElement;
  dispose(): void;
}

export function isNativePureTavernApp(
  scope: PlatformGlobals = globalThis as PlatformGlobals,
): boolean {
  if (scope.__PURE_TAVERN_PLATFORM__ === 'harmony') return true;
  if (scope.__TAURI__ || scope.__TAURI_INTERNALS__) return true;
  try {
    return scope.Capacitor?.isNativePlatform?.call(scope.Capacitor) === true;
  } catch {
    return false;
  }
}

/** 在不修改 Connection Manager 上游模板的前提下增加调用模式和远程后端配置。 */
export function installGenerationTransportUi(
  state: GenerationTransportState,
  connector: RemoteBackendConnector,
  options: GenerationTransportUiOptions = {},
): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => undefined;
  }

  const isNativeApp = options.isNativeApp ?? isNativePureTavernApp;
  const style = installStyle();
  let binding: UiBinding | null = null;

  const apply = () => {
    if (binding && !binding.root.isConnected) {
      binding.dispose();
      binding = null;
    }
    if (binding) return;

    const profileSelect = document.querySelector<HTMLSelectElement>(PROFILE_SELECT_SELECTOR);
    const profileRow = profileSelect?.parentElement;
    if (!profileSelect || !profileRow) return;

    binding = createBinding(state, connector, isNativeApp());
    profileRow.before(binding.root);
  };

  const observer = new MutationObserver(apply);
  apply();
  observer.observe(document.documentElement, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    binding?.dispose();
    binding?.root.remove();
    binding = null;
    style.remove();
  };
}

function createBinding(
  state: GenerationTransportState,
  connector: RemoteBackendConnector,
  isNativeApp: boolean,
): UiBinding {
  const root = document.createElement('section');
  root.id = UI_ROOT_ID;
  root.className = 'wide100p';
  root.innerHTML = `
    <div class="pure-tavern-transport-mode-row flex-container flexNoWrap alignItemsCenter">
      <label class="pure-tavern-transport-label" for="pure_tavern_generation_transport_mode">LLM 调用方式</label>
      <select class="text_pole flex1" id="pure_tavern_generation_transport_mode">
        <option value="frontend">当前前端调用</option>
        ${isNativeApp ? '<option value="local" disabled title="暂未实现">本地后端调用</option>' : ''}
        <option value="remote">远程后端调用</option>
      </select>
      <button id="pure_tavern_remote_backend_toggle" class="menu_button" type="button" title="打开远程后端配置" aria-controls="pure_tavern_remote_backend_panel" aria-expanded="false" hidden>
        <span class="fa-solid fa-server" aria-hidden="true"></span>
        <span>远程配置</span>
      </button>
    </div>
    <form id="pure_tavern_remote_backend_panel" class="pure-tavern-remote-backend-panel" hidden>
      <label for="pure_tavern_remote_backend_url">
        <span>URL</span>
        <input id="pure_tavern_remote_backend_url" class="text_pole" type="url" inputmode="url" autocomplete="off" placeholder="http://192.168.1.10:8000">
      </label>
      <label for="pure_tavern_remote_backend_key">
        <span>Key</span>
        <input id="pure_tavern_remote_backend_key" class="text_pole" type="password" autocomplete="off" placeholder="远程后端访问 Key">
      </label>
      <div class="pure-tavern-remote-backend-actions flex-container alignItemsCenter">
        <button id="pure_tavern_remote_backend_connect" class="menu_button" type="submit">连接</button>
        <span id="pure_tavern_remote_backend_status" role="status" aria-live="polite">未连接</span>
      </div>
    </form>
  `;

  const modeSelect = root.querySelector<HTMLSelectElement>(
    '#pure_tavern_generation_transport_mode',
  );
  const toggleButton = root.querySelector<HTMLButtonElement>('#pure_tavern_remote_backend_toggle');
  const panel = root.querySelector<HTMLFormElement>('#pure_tavern_remote_backend_panel');
  const urlInput = root.querySelector<HTMLInputElement>('#pure_tavern_remote_backend_url');
  const keyInput = root.querySelector<HTMLInputElement>('#pure_tavern_remote_backend_key');
  const connectButton = root.querySelector<HTMLButtonElement>(
    '#pure_tavern_remote_backend_connect',
  );
  const status = root.querySelector<HTMLElement>('#pure_tavern_remote_backend_status');
  if (
    !modeSelect ||
    !toggleButton ||
    !panel ||
    !urlInput ||
    !keyInput ||
    !connectButton ||
    !status
  ) {
    throw new Error('PureTavern generation transport controls could not be created.');
  }

  const syncConfig = () => state.updateRemoteConfig(urlInput.value, keyInput.value);
  const onModeChange = () => {
    if (modeSelect.value === 'frontend' || modeSelect.value === 'remote') {
      state.setMode(modeSelect.value);
    }
  };
  const onToggle = () => {
    const open = panel.hidden;
    panel.hidden = !open;
    toggleButton.setAttribute('aria-expanded', String(open));
  };
  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    syncConfig();
    void connector.connect().catch(() => undefined);
  };

  modeSelect.addEventListener('change', onModeChange);
  toggleButton.addEventListener('click', onToggle);
  urlInput.addEventListener('input', syncConfig);
  keyInput.addEventListener('input', syncConfig);
  panel.addEventListener('submit', onSubmit);

  const unsubscribe = state.subscribe((snapshot) => {
    renderSnapshot(
      snapshot,
      modeSelect,
      toggleButton,
      panel,
      urlInput,
      keyInput,
      connectButton,
      status,
    );
  });

  return {
    root,
    dispose() {
      unsubscribe();
      modeSelect.removeEventListener('change', onModeChange);
      toggleButton.removeEventListener('click', onToggle);
      urlInput.removeEventListener('input', syncConfig);
      keyInput.removeEventListener('input', syncConfig);
      panel.removeEventListener('submit', onSubmit);
    },
  };
}

function renderSnapshot(
  snapshot: GenerationTransportSnapshot,
  modeSelect: HTMLSelectElement,
  toggleButton: HTMLButtonElement,
  panel: HTMLFormElement,
  urlInput: HTMLInputElement,
  keyInput: HTMLInputElement,
  connectButton: HTMLButtonElement,
  status: HTMLElement,
): void {
  if (modeSelect.querySelector(`option[value="${snapshot.mode}"]`)) {
    modeSelect.value = snapshot.mode;
  }
  if (urlInput.value !== snapshot.remote.url) urlInput.value = snapshot.remote.url;
  if (keyInput.value !== snapshot.remote.key) keyInput.value = snapshot.remote.key;

  const remoteMode = snapshot.mode === 'remote';
  toggleButton.hidden = !remoteMode;
  if (!remoteMode) {
    panel.hidden = true;
    toggleButton.setAttribute('aria-expanded', 'false');
  }

  connectButton.disabled = snapshot.remote.status === 'connecting';
  connectButton.textContent = snapshot.remote.status === 'connecting' ? '正在连接…' : '连接';
  status.dataset.status = snapshot.remote.status;
  switch (snapshot.remote.status) {
    case 'disconnected':
      status.textContent = '未连接';
      break;
    case 'connecting':
      status.textContent = '正在连接…';
      break;
    case 'connected':
      status.textContent = '已连接';
      break;
    case 'error':
      status.textContent = snapshot.remote.error
        ? `连接失败：${snapshot.remote.error}`
        : '连接失败';
      break;
  }
}

function installStyle(): HTMLStyleElement {
  document.getElementById(STYLE_ID)?.remove();
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${UI_ROOT_ID} [hidden] {
      display: none !important;
    }

    #${UI_ROOT_ID} .pure-tavern-transport-mode-row {
      align-items: center;
      width: 100%;
    }

    #${UI_ROOT_ID} .pure-tavern-transport-label {
      flex: 0 0 auto;
      white-space: nowrap;
    }

    #${UI_ROOT_ID} #pure_tavern_generation_transport_mode {
      min-width: 0;
    }

    #${UI_ROOT_ID} #pure_tavern_remote_backend_toggle {
      flex: 0 0 auto;
      gap: 0.35em;
      white-space: nowrap;
    }

    #${UI_ROOT_ID} .pure-tavern-remote-backend-panel {
      margin: 0 0 5px;
      padding: 8px;
      border: 1px solid var(--SmartThemeBorderColor);
      border-radius: 5px;
      background: var(--black30a);
    }

    #${UI_ROOT_ID} .pure-tavern-remote-backend-panel > label {
      display: block;
    }

    #${UI_ROOT_ID} .pure-tavern-remote-backend-actions {
      min-height: 2rem;
    }

    #${UI_ROOT_ID} #pure_tavern_remote_backend_connect {
      flex: 0 0 auto;
      width: auto;
      min-width: 3.5em;
      white-space: nowrap;
      word-break: keep-all;
    }

    #${UI_ROOT_ID} #pure_tavern_remote_backend_status[data-status='connected'] {
      color: #86efac;
    }

    #${UI_ROOT_ID} #pure_tavern_remote_backend_status[data-status='error'] {
      color: #fca5a5;
    }
  `;
  document.head.append(style);
  return style;
}
