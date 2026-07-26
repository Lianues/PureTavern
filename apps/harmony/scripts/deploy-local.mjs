import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { assertFile, runHarmonyExecutable } from './harmony-toolchain.mjs';

const harmonyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundleName = 'com.puretavern.harmony';
const abilityName = 'EntryAbility';

async function findHaps(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const results = [];
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...(await findHaps(candidate)));
    else if (entry.isFile() && entry.name.endsWith('.hap')) {
      const info = await stat(candidate);
      results.push({ path: candidate, modifiedAt: info.mtimeMs });
    }
  }
  return results;
}

const hdc = await assertFile(process.env.HARMONY_HDC ?? '');
const target = process.env.HARMONY_TARGET?.trim();
const haps = await findHaps(path.join(harmonyRoot, 'entry/build'));
const latest = haps.sort((left, right) => right.modifiedAt - left.modifiedAt)[0];
if (!latest) {
  throw new Error('No Harmony HAP exists under apps/harmony/entry/build. Build the app first.');
}

const targetArgs = target ? ['-t', target] : [];
await runHarmonyExecutable(hdc, [...targetArgs, 'install', '-r', latest.path], {
  cwd: harmonyRoot,
});
await runHarmonyExecutable(
  hdc,
  [...targetArgs, 'shell', 'aa', 'start', '-a', abilityName, '-b', bundleName],
  { cwd: harmonyRoot },
);
console.log(`Installed and started ${bundleName} from ${latest.path}.`);
