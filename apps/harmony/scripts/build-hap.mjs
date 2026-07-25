import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { assertFile, runHarmonyExecutable } from './harmony-toolchain.mjs';

const harmonyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = await assertFile(process.env.HARMONY_HVIGORW ?? '');
const args = [
  'assembleHap',
  '--mode',
  'module',
  '-p',
  'product=default',
  '-p',
  'module=entry@default',
  '-p',
  'buildMode=release',
  '--no-daemon',
];
await runHarmonyExecutable(executable, args, { cwd: harmonyRoot });
