import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface TestReleaseWorkflow {
  name: string;
  on: {
    workflow_dispatch: {
      inputs: { version: { required: boolean; type: string } };
    };
    push?: unknown;
  };
  jobs: Record<string, { needs?: string[] }>;
}

describe('manual test release workflow', () => {
  it('builds every package before committing and publishing the marked test release', async () => {
    const [source, desktopSource, androidSource, iosSource, stagingSource] = await Promise.all([
      readFile('../../.github/workflows/test-release.yml', 'utf8'),
      readFile('../../.github/workflows/desktop-bundles.yml', 'utf8'),
      readFile('../../.github/workflows/android-apk.yml', 'utf8'),
      readFile('../../.github/workflows/ios-ipa.yml', 'utf8'),
      readFile('../../scripts/stage-desktop-release.mjs', 'utf8'),
    ]);
    const workflow = parse(source) as TestReleaseWorkflow;
    for (const workflowSource of [desktopSource, androidSource, iosSource]) {
      expect(() => parse(workflowSource)).not.toThrow();
    }

    expect(workflow.name).toBe('Build Test Release');
    expect(workflow.on).toEqual({
      workflow_dispatch: {
        inputs: {
          version: expect.objectContaining({ required: true, type: 'string' }),
        },
      },
    });
    expect(workflow.on.push).toBeUndefined();
    expect(Object.keys(workflow.jobs)).toEqual([
      'preflight',
      'web',
      'android',
      'desktop',
      'ios',
      'vscode',
      'publish',
    ]);
    expect(workflow.jobs.publish.needs).toEqual([
      'preflight',
      'web',
      'android',
      'desktop',
      'ios',
      'vscode',
    ]);
    expect(source).toContain('PureTavern-$RELEASE_VERSION-web.zip');
    expect(source).toContain('release-vscode');
    expect(source).toContain('apps/vscode-extension/release/*.vsix');
    expect(source).toContain('apps/vscode-extension/README.md');
    expect(source).toContain('TAG="test-v$RELEASE_VERSION"');
    expect(source).toContain('TITLE="$RELEASE_VERSION Test"');
    expect(source).toContain('git commit --allow-empty');
    expect(source).toContain('git push --atomic');
    expect(source).not.toContain('is already committed');
    expect(source).toContain('--prerelease');
    expect(source).toContain('--notes-file release-notes.txt');
    for (const workflowSource of [source, desktopSource]) {
      const stageCommand = workflowSource
        .split('\n')
        .find((line) => line.includes('node scripts/stage-desktop-release.mjs'));
      expect(stageCommand).toContain('"${{ env.RELEASE_VERSION }}"');
      expect(stageCommand).not.toContain('"$RELEASE_VERSION"');
      expect(workflowSource).toContain('x86_64-apple-darwin');
      expect(workflowSource).toContain('aarch64-apple-darwin');
      expect(workflowSource).toContain('appimage,deb,rpm');
      expect(workflowSource).toContain('compression-level: 0');
      expect(workflowSource).not.toContain('bundle/**/*');
    }
    expect(source).toContain('PureTavern-$RELEASE_VERSION-android-universal.apk');
    expect(source).toContain('PureTavern-$RELEASE_VERSION-ios-unsigned.ipa');
    expect(androidSource).toContain('android-universal.apk');
    expect(androidSource).toContain('require("./package.json").version');
    expect(androidSource).toContain('-ci.');
    expect(androidSource).not.toContain('0.1.0-ci.');
    expect(iosSource).toContain('ios-unsigned.ipa');
    expect(stagingSource).toContain('desktopReleaseAssetNames');
    expect(stagingSource).toContain('pure-tavern-desktop.exe');
    expect(stagingSource).toContain("'appimage'");
    expect(stagingSource).toContain("'rpm'");
  });
});
