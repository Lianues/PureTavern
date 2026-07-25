import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  discoverHarmonyTools,
  patchOptionalImageTranscoder,
  sanitizeHarmonyTools,
} from './harmony-toolchain.mjs';

const defaultRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../node_modules/@hmtools/hmos-cli-lite-linux',
);
const roots = process.argv.slice(2);
if (process.env.HMOS_CLI_ROOT) roots.push(process.env.HMOS_CLI_ROOT);
if (!roots.length) roots.push(defaultRoot);

const removed = await sanitizeHarmonyTools(roots);
if (removed > 0) {
  console.error(`Removed ${removed} AppleDouble metadata entries from HarmonyOS CLI tools.`);
}
const transcoderPatch = await patchOptionalImageTranscoder(roots);
console.error(
  transcoderPatch.patched > 0
    ? `Patched ${transcoderPatch.patched} eager HarmonyOS image transcoder setup(s).`
    : 'HarmonyOS image transcoder setup is already optional.',
);
const tools = await discoverHarmonyTools(roots);
console.error(`Discovered HarmonyOS hvigor: ${tools.hvigor}`);
console.error(`Discovered HarmonyOS ohpm: ${tools.ohpm}`);
console.log(`HARMONY_HVIGORW=${tools.hvigor}`);
console.log(`HARMONY_OHPM=${tools.ohpm}`);
