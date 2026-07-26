import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { assertFile, runHarmonyExecutable } from './harmony-toolchain.mjs';
import { verifyHarmonySdk } from './verify-sdk.mjs';

const harmonyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = await assertFile(process.env.HARMONY_HVIGORW ?? '');
const productName = process.env.HARMONY_PRODUCT ?? 'default';
const sdk = await verifyHarmonySdk({
  hvigorPath: executable,
  productName,
  projectRoot: harmonyRoot,
});
console.log(`Using HarmonyOS product ${productName} with SDK ${sdk.installedTarget}.`);
const args = [
  'assembleHap',
  '--mode',
  'module',
  '-p',
  `product=${productName}`,
  '-p',
  'module=entry@default',
  '-p',
  'buildMode=release',
  '--no-daemon',
];
await runHarmonyExecutable(executable, args, { cwd: harmonyRoot });
