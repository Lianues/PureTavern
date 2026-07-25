import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverHarmonyTools } from './harmony-toolchain.mjs';

const defaultRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../node_modules/@hmtools/hmos-cli-lite-linux',
);
const roots = process.argv.slice(2);
if (process.env.HMOS_CLI_ROOT) roots.push(process.env.HMOS_CLI_ROOT);
if (!roots.length) roots.push(defaultRoot);

const tools = await discoverHarmonyTools(roots);
console.error(`Discovered HarmonyOS hvigor: ${tools.hvigor}`);
console.error(`Discovered HarmonyOS ohpm: ${tools.ohpm}`);
console.log(`HARMONY_HVIGORW=${tools.hvigor}`);
console.log(`HARMONY_OHPM=${tools.ohpm}`);
