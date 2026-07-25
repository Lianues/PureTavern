import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { assertFile, runHarmonyExecutable } from './harmony-toolchain.mjs';

const harmonyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = await assertFile(process.env.HARMONY_OHPM ?? '');
await runHarmonyExecutable(executable, ['install', '--all'], { cwd: harmonyRoot });
