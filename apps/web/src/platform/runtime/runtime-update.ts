const RUNTIME_VERSION_URL = '/__pure_tavern/runtime-version.json';
const RELOAD_ATTEMPT_KEY = 'pure-tavern.runtime-reload-attempt';
const BUILD_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/u;

export type RuntimeUpdateCheckResult =
  'current' | 'reloading' | 'reload-suppressed' | 'unavailable';

export interface RuntimeUpdateCheckOptions {
  currentBuildId: string;
  nativeFetch: typeof fetch;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  reload: () => void;
}

export async function checkForRuntimeUpdate(
  options: RuntimeUpdateCheckOptions,
): Promise<RuntimeUpdateCheckResult> {
  let response: Response;
  try {
    response = await options.nativeFetch(RUNTIME_VERSION_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return 'unavailable';
  }
  if (!response.ok) return 'unavailable';

  let value: unknown;
  try {
    value = (await response.json()) as unknown;
  } catch {
    return 'unavailable';
  }
  const remoteBuildId = readBuildId(value);
  if (!remoteBuildId) return 'unavailable';

  if (remoteBuildId === options.currentBuildId) {
    try {
      if (options.storage.getItem(RELOAD_ATTEMPT_KEY) === remoteBuildId) {
        options.storage.removeItem(RELOAD_ATTEMPT_KEY);
      }
    } catch {
      // Storage is only a reload-loop guard; version checks still work without it.
    }
    return 'current';
  }

  try {
    if (options.storage.getItem(RELOAD_ATTEMPT_KEY) === remoteBuildId) {
      return 'reload-suppressed';
    }
    options.storage.setItem(RELOAD_ATTEMPT_KEY, remoteBuildId);
  } catch {
    // A content-addressed Hook URL prevents normal loops even if sessionStorage is unavailable.
  }
  options.reload();
  return 'reloading';
}

export function installRuntimeUpdateWatcher(
  nativeFetch: typeof fetch,
  currentBuildId: string,
): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;

  let checking = false;
  const check = async () => {
    if (checking || document.visibilityState === 'hidden') return;
    checking = true;
    try {
      const result = await checkForRuntimeUpdate({
        currentBuildId,
        nativeFetch,
        storage: window.sessionStorage,
        reload: () => window.location.reload(),
      });
      if (result === 'reload-suppressed') {
        console.warn(
          '[PureTavern Update] A newer runtime exists, but automatic reload was suppressed to prevent a loop.',
        );
      }
    } finally {
      checking = false;
    }
  };

  const onFocus = () => void check();
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') void check();
  };
  const initial = window.setTimeout(() => void check(), 10_000);
  const interval = window.setInterval(() => void check(), 60_000);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    window.clearTimeout(initial);
    window.clearInterval(interval);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

function readBuildId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const buildId = (value as Record<string, unknown>).buildId;
  return typeof buildId === 'string' && BUILD_ID_PATTERN.test(buildId) ? buildId : null;
}
