import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyReleaseVersion,
  assertReleaseVersion,
  harmonyVersionCode,
} from '../../../scripts/set-release-version.mjs';

const PACKAGE_FILES = [
  'package.json',
  'apps/desktop/package.json',
  'apps/harmony/package.json',
  'apps/mobile/package.json',
  'apps/server/package.json',
  'apps/vscode-extension/package.json',
  'apps/web/package.json',
  'packages/contracts/package.json',
  'packages/shared/package.json',
];

async function fixtureFile(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

describe('test release versioning', () => {
  it('exposes one root command for updating every release version', async () => {
    const rootPackage = JSON.parse(await readFile('../../package.json', 'utf8'));
    expect(rootPackage.scripts['version:set']).toBe('node scripts/set-release-version.mjs');
  });

  it('accepts stable versions and rejects prefixed or prerelease versions', () => {
    expect(assertReleaseVersion('1.2.3')).toBe('1.2.3');
    expect(() => assertReleaseVersion('v1.2.3')).toThrow(/stable SemVer/u);
    expect(() => assertReleaseVersion('1.2.3-beta.1')).toThrow(/stable SemVer/u);
    expect(harmonyVersionCode('0.1.0')).toBe(1001);
    expect(harmonyVersionCode('1.2.3')).toBe(1_002_004);
  });

  it('updates every release-owned version without touching unrelated package versions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pure-tavern-release-version-'));
    try {
      await Promise.all(
        PACKAGE_FILES.map((relativePath) =>
          fixtureFile(root, relativePath, '{"name":"fixture","version":"0.1.0"}\n'),
        ),
      );
      await fixtureFile(root, 'apps/desktop/src-tauri/tauri.conf.json', '{"version":"0.1.0"}\n');
      await fixtureFile(
        root,
        'apps/harmony/AppScope/app.json5',
        "{ app: { versionCode: 1001, versionName: '0.1.0' } }\n",
      );
      await fixtureFile(
        root,
        'apps/harmony/entry/oh-package.json5',
        "{ name: 'entry', version: '1.0.0' }\n",
      );
      await fixtureFile(
        root,
        'apps/desktop/src-tauri/Cargo.toml',
        '[package]\nname = "pure-tavern-desktop"\nversion = "0.1.0"\n',
      );
      await fixtureFile(
        root,
        'apps/desktop/src-tauri/Cargo.lock',
        '[[package]]\nname = "dependency"\nversion = "0.1.0"\n\n[[package]]\nname = "pure-tavern-desktop"\nversion = "0.1.0"\n',
      );
      await fixtureFile(
        root,
        'apps/mobile/android/app/build.gradle',
        "def pureTavernVersionCode = (System.getenv('PURE_TAVERN_VERSION_CODE') ?: '1').toInteger()\ndef pureTavernVersionName = System.getenv('PURE_TAVERN_VERSION_NAME') ?: '0.1.0'\n",
      );
      await fixtureFile(
        root,
        'apps/mobile/ios/App/App.xcodeproj/project.pbxproj',
        'CURRENT_PROJECT_VERSION = 1;\nMARKETING_VERSION = 0.1.0;\nCURRENT_PROJECT_VERSION = 1;\nMARKETING_VERSION = 0.1.0;\n',
      );
      await fixtureFile(
        root,
        'apps/vscode-extension/README.md',
        'code --install-extension apps/vscode-extension/release/PureTavern-VSCode-0.1.0.vsix\n',
      );
      await fixtureFile(
        root,
        'apps/web/src/features/import-export/application/archive-service.ts',
        "this.#appVersion = options.appVersion ?? '0.1.0';\n",
      );
      await fixtureFile(root, 'apps/web/src/legacy-hook/bootstrap.ts', "hookVersion: '0.1.0',\n");

      await expect(applyReleaseVersion(root, '1.2.3')).resolves.toEqual({
        version: '1.2.3',
        tag: 'test-v1.2.3',
        title: '1.2.3 Test',
      });

      for (const relativePath of PACKAGE_FILES) {
        const value = JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
        expect(value.version).toBe('1.2.3');
      }
      expect(await readFile(path.join(root, 'apps/harmony/AppScope/app.json5'), 'utf8')).toBe(
        "{ app: { versionCode: 1002004, versionName: '1.2.3' } }\n",
      );
      expect(await readFile(path.join(root, 'apps/harmony/entry/oh-package.json5'), 'utf8')).toBe(
        "{ name: 'entry', version: '1.0.0' }\n",
      );
      expect(await readFile(path.join(root, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8')).toBe(
        '[[package]]\nname = "dependency"\nversion = "0.1.0"\n\n[[package]]\nname = "pure-tavern-desktop"\nversion = "1.2.3"\n',
      );
      expect(await readFile(path.join(root, 'apps/mobile/android/app/build.gradle'), 'utf8')).toBe(
        "def pureTavernVersionCode = (System.getenv('PURE_TAVERN_VERSION_CODE') ?: '1002004').toInteger()\ndef pureTavernVersionName = System.getenv('PURE_TAVERN_VERSION_NAME') ?: '1.2.3'\n",
      );
      expect(
        await readFile(
          path.join(root, 'apps/mobile/ios/App/App.xcodeproj/project.pbxproj'),
          'utf8',
        ),
      ).toBe(
        'CURRENT_PROJECT_VERSION = 1002004;\nMARKETING_VERSION = 1.2.3;\nCURRENT_PROJECT_VERSION = 1002004;\nMARKETING_VERSION = 1.2.3;\n',
      );
      expect(await readFile(path.join(root, 'apps/vscode-extension/README.md'), 'utf8')).toContain(
        'PureTavern-VSCode-1.2.3.vsix',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
