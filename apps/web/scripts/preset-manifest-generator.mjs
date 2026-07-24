import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const PRESET_SEED_SOURCES = Object.freeze([
  ['context', 'presets/context'],
  ['instruct', 'presets/instruct'],
  ['kobold', 'presets/kobold'],
  ['moving-ui', 'presets/moving-ui'],
  ['novel', 'presets/novel'],
  ['openai', 'presets/openai'],
  ['quick-reply', 'presets/quick-replies'],
  ['reasoning', 'presets/reasoning'],
  ['sysprompt', 'presets/sysprompt'],
  ['textgenerationwebui', 'presets/textgen'],
  ['theme', 'themes'],
]);

export async function generatePresetSeedManifest(defaultContentRoot) {
  const presets = [];

  for (const [type, relativeDirectory] of PRESET_SEED_SOURCES) {
    const directory = path.join(defaultContentRoot, ...relativeDirectory.split('/'));
    const entries = await readdir(directory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.json')
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'));

    for (const fileName of files) {
      const raw = await readFile(path.join(directory, fileName));
      let value;
      try {
        value = JSON.parse(raw.toString('utf8'));
      } catch (error) {
        throw new Error(`Invalid upstream preset JSON: ${relativeDirectory}/${fileName}`, {
          cause: error,
        });
      }
      presets.push({
        type,
        name: path.parse(fileName).name,
        value,
        sourceHash: createHash('sha256').update(raw).digest('hex'),
      });
    }
  }

  return { version: 1, presets };
}
