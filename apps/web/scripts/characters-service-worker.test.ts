import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(
  scriptsDirectory,
  '../src/features/characters/infrastructure/characters-service-worker.js',
);

describe('Characters avatar Service Worker', () => {
  it('opens the existing Dexie database without declaring a native IndexedDB version', async () => {
    const source = await readFile(workerPath, 'utf8');

    expect(source).toContain('indexedDB.open(DATABASE_NAME);');
    expect(source).not.toMatch(/indexedDB\.open\(DATABASE_NAME\s*,/u);
    expect(source).not.toContain('createObjectStore');
  });
});
