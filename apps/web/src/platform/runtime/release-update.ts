const RELEASE_PACKAGE_URL = 'https://cdn.jsdelivr.net/gh/Lianues/PureTavern@latest/package.json';
const RELEASE_PAGE_PREFIX = 'https://github.com/Lianues/PureTavern/releases/tag/v';
const RELEASE_CHECK_HOUR_MS = 60 * 60 * 1_000;
const DISMISSED_VERSION_KEY = 'pure-tavern.release-update.dismissed';
const SKIPPED_VERSION_KEY = 'pure-tavern.release-update.skipped';
const NOTICE_ID = 'pure-tavern-release-update';
const NOTICE_STYLE_ID = 'pure-tavern-release-update-style';
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export interface ReleaseUpdate {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
}

export type ReleaseUpdateCheckResult =
  { status: 'available'; update: ReleaseUpdate } | { status: 'current' | 'unavailable' };

export interface ReleaseUpdateCheckOptions {
  currentVersion: string;
  nativeFetch: typeof fetch;
  now?: number;
}

export interface ReleaseUpdateNoticeOptions {
  document?: Document;
  language?: string;
  onDismiss?: () => void;
  onSkip?: () => void;
}

export async function checkForReleaseUpdate(
  options: ReleaseUpdateCheckOptions,
): Promise<ReleaseUpdateCheckResult> {
  if (!parseStableVersion(options.currentVersion)) return { status: 'unavailable' };

  let response: Response;
  try {
    response = await options.nativeFetch(releasePackageUrl(options.now ?? Date.now()), {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      mode: 'cors',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    return { status: 'unavailable' };
  }
  if (!response.ok) return { status: 'unavailable' };

  let value: unknown;
  try {
    value = (await response.json()) as unknown;
  } catch {
    return { status: 'unavailable' };
  }
  const latestVersion = readPackageVersion(value);
  if (!latestVersion) return { status: 'unavailable' };

  const comparison = compareStableVersions(latestVersion, options.currentVersion);
  if (comparison === null) return { status: 'unavailable' };
  if (comparison <= 0) return { status: 'current' };

  return {
    status: 'available',
    update: {
      currentVersion: options.currentVersion,
      latestVersion,
      releaseUrl: releasePageUrl(latestVersion),
    },
  };
}

export function installReleaseUpdateCheck(
  nativeFetch: typeof fetch,
  currentVersion: string,
): () => void {
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    !parseStableVersion(currentVersion)
  ) {
    return () => undefined;
  }

  let disposed = false;
  let notice: HTMLElement | null = null;
  void checkForReleaseUpdate({ currentVersion, nativeFetch }).then((result) => {
    if (disposed || result.status !== 'available') return;
    const sessionStorage = sessionStorageSafely(window);
    const localStorage = localStorageSafely(window);
    if (
      readStoredVersion(sessionStorage, DISMISSED_VERSION_KEY) === result.update.latestVersion ||
      readStoredVersion(localStorage, SKIPPED_VERSION_KEY) === result.update.latestVersion
    ) {
      return;
    }
    notice = showReleaseUpdateNotice(result.update, {
      document,
      language: document.documentElement.lang || window.navigator.language,
      onDismiss: () =>
        writeStoredVersion(sessionStorage, DISMISSED_VERSION_KEY, result.update.latestVersion),
      onSkip: () =>
        writeStoredVersion(localStorage, SKIPPED_VERSION_KEY, result.update.latestVersion),
    });
  });

  return () => {
    disposed = true;
    notice?.remove();
  };
}

export function showReleaseUpdateNotice(
  update: ReleaseUpdate,
  options: ReleaseUpdateNoticeOptions = {},
): HTMLElement | null {
  const ownerDocument = options.document ?? globalThis.document;
  if (!ownerDocument?.body) return null;

  const existing = ownerDocument.getElementById(NOTICE_ID);
  if (existing instanceof HTMLElement) return existing;
  ensureNoticeStyle(ownerDocument);

  const chinese = /^zh(?:-|$)/iu.test(options.language ?? ownerDocument.documentElement.lang ?? '');
  const notice = ownerDocument.createElement('aside');
  notice.id = NOTICE_ID;
  notice.setAttribute('role', 'dialog');
  notice.setAttribute('aria-modal', 'false');

  const title = ownerDocument.createElement('strong');
  title.id = `${NOTICE_ID}-title`;
  title.className = 'pure-tavern-release-update-title';
  title.textContent = chinese ? '发现 PureTavern 新版本' : 'A new PureTavern version is available';
  notice.setAttribute('aria-labelledby', title.id);

  const message = ownerDocument.createElement('p');
  message.textContent = chinese
    ? `PureTavern ${update.latestVersion} 已发布，当前版本为 ${update.currentVersion}。`
    : `PureTavern ${update.latestVersion} is available. You are using ${update.currentVersion}.`;

  const actions = ownerDocument.createElement('div');
  actions.className = 'pure-tavern-release-update-actions';

  const later = ownerDocument.createElement('button');
  later.type = 'button';
  later.className = 'pure-tavern-release-update-later';
  later.textContent = chinese ? '稍后' : 'Later';

  const skip = ownerDocument.createElement('button');
  skip.type = 'button';
  skip.className = 'pure-tavern-release-update-skip';
  skip.textContent = chinese ? '跳过此版本' : 'Skip this version';

  const download = ownerDocument.createElement('a');
  download.className = 'pure-tavern-release-update-download';
  download.href = update.releaseUrl;
  download.target = '_blank';
  download.rel = 'noopener noreferrer';
  download.textContent = chinese ? '前往下载' : 'Download';

  const close = (callback?: () => void) => {
    callback?.();
    notice.remove();
  };
  later.addEventListener('click', () => close(options.onDismiss));
  skip.addEventListener('click', () => close(options.onSkip));
  download.addEventListener('click', () => close(options.onDismiss));

  actions.append(later, skip, download);
  notice.append(title, message, actions);
  ownerDocument.body.append(notice);
  return notice;
}

export function compareStableVersions(left: string, right: string): number | null {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  if (!leftParts || !rightParts) return null;
  const differences = [
    leftParts[0] - rightParts[0],
    leftParts[1] - rightParts[1],
    leftParts[2] - rightParts[2],
  ];
  const difference = differences.find((part) => part !== 0);
  return difference === undefined ? 0 : Math.sign(difference);
}

export function releasePageUrl(version: string): string {
  if (!parseStableVersion(version))
    throw new TypeError(`Invalid stable release version: ${version}`);
  return `${RELEASE_PAGE_PREFIX}${version}`;
}

export function releasePackageUrl(now: number): string {
  const hour = Math.floor(now / RELEASE_CHECK_HOUR_MS);
  return `${RELEASE_PACKAGE_URL}?check=${hour}`;
}

function parseStableVersion(version: string): readonly [number, number, number] | null {
  const match = STABLE_VERSION_PATTERN.exec(version);
  if (!match) return null;
  const parts: [number, number, number] = [
    Number(match[1] ?? Number.NaN),
    Number(match[2] ?? Number.NaN),
    Number(match[3] ?? Number.NaN),
  ];
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return parts;
}

function readPackageVersion(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const version = (value as Record<string, unknown>).version;
  return typeof version === 'string' && parseStableVersion(version) ? version : null;
}

type UpdateStorage = Pick<Storage, 'getItem' | 'setItem'>;

function sessionStorageSafely(ownerWindow: Window): UpdateStorage | null {
  try {
    return ownerWindow.sessionStorage;
  } catch {
    return null;
  }
}

function localStorageSafely(ownerWindow: Window): UpdateStorage | null {
  try {
    return ownerWindow.localStorage;
  } catch {
    return null;
  }
}

function readStoredVersion(storage: Pick<Storage, 'getItem'> | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStoredVersion(
  storage: Pick<Storage, 'setItem'> | null,
  key: string,
  version: string,
): void {
  try {
    storage?.setItem(key, version);
  } catch {
    // The notice still closes when browser storage is unavailable.
  }
}

function ensureNoticeStyle(ownerDocument: Document): void {
  if (ownerDocument.getElementById(NOTICE_STYLE_ID)) return;
  const style = ownerDocument.createElement('style');
  style.id = NOTICE_STYLE_ID;
  style.textContent = `
#${NOTICE_ID} {
  position: fixed;
  z-index: 2147483647;
  right: 16px;
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  width: min(420px, calc(100vw - 32px));
  box-sizing: border-box;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 12px;
  color: var(--SmartThemeBodyColor, #f7f7f7);
  background: rgba(25, 25, 28, 0.96);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.38);
  font: 14px/1.5 system-ui, sans-serif;
}
#${NOTICE_ID} .pure-tavern-release-update-title {
  display: block;
  margin-bottom: 6px;
  font-size: 16px;
}
#${NOTICE_ID} p {
  margin: 0;
}
#${NOTICE_ID} .pure-tavern-release-update-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}
#${NOTICE_ID} button,
#${NOTICE_ID} a {
  min-height: 36px;
  box-sizing: border-box;
  padding: 7px 13px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 8px;
  color: inherit;
  background: transparent;
  font: inherit;
  text-decoration: none;
  cursor: pointer;
}
#${NOTICE_ID} .pure-tavern-release-update-download {
  border-color: #6d8cff;
  background: #4f6fe8;
  color: #fff;
}
#${NOTICE_ID} button:focus-visible,
#${NOTICE_ID} a:focus-visible {
  outline: 2px solid #9db0ff;
  outline-offset: 2px;
}
`;
  ownerDocument.head.append(style);
}
