import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const LEGACY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/u;

export async function generateTrustedExtensionManifest(upstreamPublicRoot) {
  const extensionsRoot = path.join(upstreamPublicRoot, 'scripts', 'extensions');
  const entries = await readdir(extensionsRoot, { withFileTypes: true });
  const extensions = [];

  for (const entry of entries
    .filter((candidate) => candidate.isDirectory() && LEGACY_NAME_PATTERN.test(candidate.name))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const manifestPath = path.join(extensionsRoot, entry.name, 'manifest.json');
    let raw;
    try {
      raw = await readFile(manifestPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }

    let manifest;
    try {
      manifest = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      throw new Error(`Invalid trusted extension manifest: ${entry.name}/manifest.json`, {
        cause: error,
      });
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error(`Trusted extension manifest must be an object: ${entry.name}`);
    }
    if (manifest.js !== 'index.js') {
      throw new Error(`Trusted extension must use the audited index.js entry: ${entry.name}`);
    }
    await access(path.join(extensionsRoot, entry.name, manifest.js));

    extensions.push({
      extensionId: `legacy.builtin.${entry.name}`,
      legacyName: entry.name,
      displayName:
        typeof manifest.display_name === 'string' && manifest.display_name
          ? manifest.display_name
          : entry.name,
      version:
        typeof manifest.version === 'string' && manifest.version ? manifest.version : '0.0.0',
      author: typeof manifest.author === 'string' ? manifest.author : '',
      scriptPath: `/scripts/extensions/${entry.name}/index.js`,
      ...(typeof manifest.description === 'string' && manifest.description
        ? { description: manifest.description }
        : {}),
      sourceHash: createHash('sha256').update(raw).digest('hex'),
    });
  }

  return { version: 1, extensions };
}
