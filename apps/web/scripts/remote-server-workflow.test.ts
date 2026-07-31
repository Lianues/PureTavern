import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowJob {
  needs?: string | string[];
  uses?: string;
  with?: Record<string, unknown>;
  strategy?: {
    matrix?: {
      include?: Array<Record<string, unknown>>;
    };
  };
}

interface Workflow {
  name: string;
  on: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
}

describe('remote server CI and release workflows', () => {
  it('tests all implementations and packages six Go targets', async () => {
    const source = await readFile('../../.github/workflows/remote-server.yml', 'utf8');
    const workflow = parse(source) as Workflow;

    expect(workflow.name).toBe('Remote Server CI');
    expect(workflow.on).toHaveProperty('workflow_call');
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.on).toHaveProperty('push');
    expect(workflow.on).toHaveProperty('pull_request');
    expect(Object.keys(workflow.jobs)).toEqual(['node', 'python', 'go', 'package']);
    expect(workflow.jobs.package?.needs).toBe('go');

    const targets = workflow.jobs.package?.strategy?.matrix?.include ?? [];
    expect(
      targets.map((target) => [target.platform, target.arch, target.goos, target.goarch]),
    ).toEqual([
      ['windows', 'x64', 'windows', 'amd64'],
      ['windows', 'arm64', 'windows', 'arm64'],
      ['linux', 'x64', 'linux', 'amd64'],
      ['linux', 'arm64', 'linux', 'arm64'],
      ['macos', 'x64', 'darwin', 'amd64'],
      ['macos', 'arm64', 'darwin', 'arm64'],
    ]);
    expect(source).toContain('node --test nodejs/tests/*.test.mjs');
    expect(source).toContain('python -m pytest -q tests');
    expect(source).toContain('go test -race ./...');
    expect(source).toContain('CGO_ENABLED: 0');
    expect(source).toContain('-X main.version=$VERSION');
    expect(source).toContain('-X main.commit=$GITHUB_SHA');
    expect(source).toContain('PureTavern-$VERSION-remote-server-${{ matrix.platform }}');
    expect(source).toContain("format('release-remote-server-{0}-{1}'");
    expect(source).toContain('compression-level: 0');
  });

  it('feeds backend binaries into stable and test GitHub releases', async () => {
    const [releaseSource, testReleaseSource] = await Promise.all([
      readFile('../../.github/workflows/release.yml', 'utf8'),
      readFile('../../.github/workflows/test-release.yml', 'utf8'),
    ]);
    const release = parse(releaseSource) as Workflow;
    const testRelease = parse(testReleaseSource) as Workflow;

    for (const workflow of [release, testRelease]) {
      expect(workflow.jobs['remote-server']).toMatchObject({
        needs: 'preflight',
        uses: './.github/workflows/remote-server.yml',
        with: {
          package_version: '${{ inputs.version }}',
          release_artifacts: true,
        },
      });
      expect(workflow.jobs.publish?.needs).toContain('remote-server');
    }
    expect(releaseSource).toContain('pattern: release-*');
    expect(releaseSource).toContain('SHA256SUMS.txt');
    expect(releaseSource).toContain('Remote Server：Go 单文件后端未做代码签名');
    expect(testReleaseSource).toContain('pattern: release-*');
  });
});
