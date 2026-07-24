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
    const source = await readFile('../../.github/workflows/test-release.yml', 'utf8');
    const workflow = parse(source) as TestReleaseWorkflow;

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
    expect(source).toContain('TAG="test-v$RELEASE_VERSION"');
    expect(source).toContain('TITLE="$RELEASE_VERSION Test"');
    expect(source).toContain('git push --atomic');
    expect(source).toContain('--prerelease');
    expect(source).toContain('--notes-file release-notes.txt');
  });
});
