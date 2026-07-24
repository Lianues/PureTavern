import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const BACKGROUND_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export async function generateDefaultAssetManifest(defaultContentRoot) {
  const directory = path.join(defaultContentRoot, 'backgrounds');
  const entries = await readdir(directory, { withFileTypes: true });
  const backgrounds = [];

  for (const entry of entries
    .filter(
      (candidate) =>
        candidate.isFile() && BACKGROUND_EXTENSIONS.has(path.extname(candidate.name).toLowerCase()),
    )
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const raw = await readFile(path.join(directory, entry.name));
    backgrounds.push({
      name: entry.name,
      sourceHash: createHash('sha256').update(raw).digest('hex'),
    });
  }

  return { version: 1, backgrounds };
}
