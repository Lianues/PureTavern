import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  desktopReleaseAssetNames,
  stageDesktopRelease,
} from '../../../scripts/stage-desktop-release.mjs';

describe('desktop release asset staging', () => {
  it('uses normalized platform, architecture and format names', () => {
    expect(desktopReleaseAssetNames('windows', 'x64', '0.1.0')).toEqual({
      setup: 'PureTavern-0.1.0-windows-x64-setup.exe',
      portable: 'PureTavern-0.1.0-windows-x64-portable.exe',
    });
    expect(desktopReleaseAssetNames('macos', 'x64', '0.1.0')).toEqual({
      dmg: 'PureTavern-0.1.0-macos-x64.dmg',
    });
    expect(desktopReleaseAssetNames('macos', 'arm64', '0.1.0')).toEqual({
      dmg: 'PureTavern-0.1.0-macos-arm64.dmg',
    });
    expect(desktopReleaseAssetNames('linux', 'x64', '0.1.0')).toEqual({
      appimage: 'PureTavern-0.1.0-linux-x64.AppImage',
      deb: 'PureTavern-0.1.0-linux-x64.deb',
      rpm: 'PureTavern-0.1.0-linux-x64.rpm',
    });
    expect(() => desktopReleaseAssetNames('linux', 'arm64', '0.1.0')).toThrow(
      'Unsupported desktop release target',
    );
  });

  it('stages the Windows installer and standalone executable without temporary bundle files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pure-tavern-desktop-assets-'));
    const releaseRoot = path.join(root, 'target', 'release');
    const outputRoot = path.join(root, 'output');
    try {
      await mkdir(path.join(releaseRoot, 'bundle', 'nsis'), { recursive: true });
      await writeFile(path.join(releaseRoot, 'bundle', 'nsis', 'generated-setup.exe'), 'setup');
      await writeFile(path.join(releaseRoot, 'pure-tavern-desktop.exe'), 'portable');

      await expect(
        stageDesktopRelease({
          platform: 'windows',
          arch: 'x64',
          version: '1.2.3',
          releaseRoot,
          outputRoot,
        }),
      ).resolves.toHaveLength(2);
      await expect(
        readFile(path.join(outputRoot, 'PureTavern-1.2.3-windows-x64-setup.exe'), 'utf8'),
      ).resolves.toBe('setup');
      await expect(
        readFile(path.join(outputRoot, 'PureTavern-1.2.3-windows-x64-portable.exe'), 'utf8'),
      ).resolves.toBe('portable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
