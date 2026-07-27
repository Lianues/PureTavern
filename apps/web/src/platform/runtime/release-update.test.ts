import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkForReleaseUpdate,
  compareStableVersions,
  installReleaseUpdateCheck,
  releasePackageUrl,
  releasePageUrl,
  showReleaseUpdateNotice,
} from './release-update';

afterEach(() => {
  vi.useRealTimers();
  window.sessionStorage.clear();
  window.localStorage.clear();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.documentElement.lang = '';
});

describe('release update checks', () => {
  it('compares strict stable semantic versions numerically', () => {
    expect(compareStableVersions('0.2.0', '0.1.9')).toBe(1);
    expect(compareStableVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareStableVersions('1.2.3', '2.0.0')).toBe(-1);
    expect(compareStableVersions('01.2.3', '1.2.3')).toBeNull();
    expect(compareStableVersions('1.2.3-beta.1', '1.2.3')).toBeNull();
  });

  it('checks jsDelivr latest once with an hourly cache key and returns a fixed release URL', async () => {
    const nativeFetch = jsonFetch({ version: '0.2.0' });

    await expect(
      checkForReleaseUpdate({
        currentVersion: '0.1.4',
        nativeFetch,
        now: 123 * 60 * 60 * 1_000,
      }),
    ).resolves.toEqual({
      status: 'available',
      update: {
        currentVersion: '0.1.4',
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/Lianues/PureTavern/releases/tag/v0.2.0',
      },
    });

    expect(nativeFetch).toHaveBeenCalledWith(
      'https://cdn.jsdelivr.net/gh/Lianues/PureTavern@latest/package.json?check=123',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'omit',
        mode: 'cors',
        referrerPolicy: 'no-referrer',
      }),
    );
    expect(releasePackageUrl(124 * 60 * 60 * 1_000 - 1)).toContain('?check=123');
    expect(releasePageUrl('0.2.0')).toBe(
      'https://github.com/Lianues/PureTavern/releases/tag/v0.2.0',
    );
  });

  it.each(['0.1.4', '0.1.3'])(
    'does not offer the remote %s release to a local 0.1.4 build',
    async (version) => {
      await expect(
        checkForReleaseUpdate({
          currentVersion: '0.1.4',
          nativeFetch: jsonFetch({ version }),
          now: 0,
        }),
      ).resolves.toEqual({ status: 'current' });
    },
  );

  it('silently ignores unavailable, malformed and non-stable release metadata', async () => {
    const values = [
      jsonFetch({ version: 'v0.2.0' }),
      jsonFetch({ version: '0.2.0-beta.1' }),
      jsonFetch({}),
      vi.fn(async () => Promise.reject(new TypeError('offline'))) as typeof fetch,
    ];

    for (const nativeFetch of values) {
      await expect(
        checkForReleaseUpdate({ currentVersion: '0.1.4', nativeFetch, now: 0 }),
      ).resolves.toEqual({ status: 'unavailable' });
    }
  });
});

describe('release update notice', () => {
  it('renders a localized non-native notice with safe download and later actions', () => {
    const onDismiss = vi.fn();
    const notice = showReleaseUpdateNotice(
      {
        currentVersion: '0.1.4',
        latestVersion: '0.2.0',
        releaseUrl: releasePageUrl('0.2.0'),
      },
      { document, language: 'zh-CN', onDismiss },
    );

    expect(notice?.textContent).toContain('发现 PureTavern 新版本');
    expect(notice?.textContent).toContain('0.1.4');
    expect(notice?.textContent).toContain('0.2.0');
    expect(notice?.textContent).toContain('跳过此版本');
    const download = notice?.querySelector<HTMLAnchorElement>(
      '.pure-tavern-release-update-download',
    );
    expect(download?.href).toBe('https://github.com/Lianues/PureTavern/releases/tag/v0.2.0');
    expect(download?.target).toBe('_blank');
    expect(download?.rel).toBe('noopener noreferrer');

    notice?.querySelector<HTMLButtonElement>('.pure-tavern-release-update-later')?.click();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(document.getElementById('pure-tavern-release-update')).toBeNull();
  });

  it('checks once during startup and remembers a dismissed release for the session', async () => {
    const nativeFetch = jsonFetch({ version: '0.2.0' });
    const dispose = installReleaseUpdateCheck(nativeFetch, '0.1.4');

    await vi.waitFor(() => {
      expect(document.getElementById('pure-tavern-release-update')).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>('.pure-tavern-release-update-later')?.click();
    dispose();

    const disposeAgain = installReleaseUpdateCheck(nativeFetch, '0.1.4');
    await vi.waitFor(() => {
      expect(nativeFetch).toHaveBeenCalledTimes(2);
    });
    expect(document.getElementById('pure-tavern-release-update')).toBeNull();
    disposeAgain();
  });

  it('persists a skipped version across startups but offers the next release', async () => {
    const skippedFetch = jsonFetch({ version: '0.2.0' });
    const dispose = installReleaseUpdateCheck(skippedFetch, '0.1.4');
    await vi.waitFor(() => {
      expect(document.querySelector('.pure-tavern-release-update-skip')).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>('.pure-tavern-release-update-skip')?.click();
    dispose();

    document.body.innerHTML = '';
    const disposeSkipped = installReleaseUpdateCheck(skippedFetch, '0.1.4');
    await vi.waitFor(() => {
      expect(skippedFetch).toHaveBeenCalledTimes(2);
    });
    expect(document.getElementById('pure-tavern-release-update')).toBeNull();
    disposeSkipped();

    const nextFetch = jsonFetch({ version: '0.2.1' });
    const disposeNext = installReleaseUpdateCheck(nextFetch, '0.1.4');
    await vi.waitFor(() => {
      expect(document.getElementById('pure-tavern-release-update')).not.toBeNull();
    });
    expect(document.getElementById('pure-tavern-release-update')?.textContent).toContain('0.2.1');
    disposeNext();
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
