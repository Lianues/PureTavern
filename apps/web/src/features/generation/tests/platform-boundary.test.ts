/// <reference types="node" />

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const featureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.resolve(featureRoot, '../../..');
const forbiddenPlatformCode =
  /Capacitor|__TAURI|@tauri-apps|@kit\.NetworkKit|URLSession|WKUserScript|PureTavernLocalServer|PureTavernHarmonyLocalServer|pure_tavern_local_(?:start|cancel)_request|X-Pure-Tavern-VSCode|vscode-local-backend/u;

describe('Generation platform boundary', () => {
  it('contains only the versioned host bridge and no shell-specific adapter', async () => {
    const sourceFiles = (await listFiles(featureRoot)).filter(
      (file) => file.endsWith('.ts') && !file.includes(`${path.sep}tests${path.sep}`),
    );
    const sources = await Promise.all(sourceFiles.map((file) => readFile(file, 'utf8')));

    expect(
      sourceFiles.some((file) =>
        /android|ios|harmony|tauri|vscode|platform-local/iu.test(path.basename(file)),
      ),
    ).toBe(false);
    expect(sources.join('\n')).not.toMatch(forbiddenPlatformCode);
    expect(sources.join('\n')).toContain('__PURE_TAVERN_LOCAL_BACKEND__');
    expect(sources.join('\n')).toContain('pure-tavern-local-backend');

    const webPackage = JSON.parse(await readFile(path.join(webRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(webPackage.dependencies?.['@tauri-apps/api']).toBeUndefined();
  });
});

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolute)));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}
