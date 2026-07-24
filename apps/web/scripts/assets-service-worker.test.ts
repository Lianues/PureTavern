import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(
  scriptsDirectory,
  '../src/features/assets/infrastructure/pure-tavern-assets-service-worker.js',
);

describe('shared Assets Service Worker', () => {
  it('opens the existing Dexie database without owning a native schema version', async () => {
    const source = await readFile(workerPath, 'utf8');

    expect(source).toContain('indexedDB.open(DATABASE_NAME);');
    expect(source).not.toMatch(/indexedDB\.open\(DATABASE_NAME\s*,/u);
    expect(source).not.toContain('createObjectStore');
  });

  it('covers all browser resource namespaces without a second Characters worker', async () => {
    const source = await readFile(workerPath, 'utf8');

    for (const namespace of [
      '/thumbnail',
      '/backgrounds/',
      '/User Avatars/',
      '/user/files/',
      '/user/images/',
      '/characters/',
      '/assets/',
    ]) {
      expect(source).toContain(namespace);
    }
    expect(source).toContain("[CHARACTERS_MODULE, 'avatars', avatarFile]");
    expect(source).toContain("[ASSETS_MODULE, 'path-aliases', legacyPath]");
  });
});
