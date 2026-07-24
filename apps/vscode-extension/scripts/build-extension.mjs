import { access, cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(extensionRoot, '../..');
const webDist = path.join(workspaceRoot, 'apps', 'web', 'dist');
const outputRoot = path.join(extensionRoot, 'dist');

await access(path.join(webDist, 'index.html'));
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await build({
  entryPoints: [path.join(extensionRoot, 'src', 'extension.ts')],
  outfile: path.join(outputRoot, 'extension.cjs'),
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: ['node20'],
  sourcemap: false,
  logLevel: 'info',
});
await cp(webDist, path.join(outputRoot, 'web'), { recursive: true, force: true });
console.log('Built PureTavern VS Code extension with packaged web dist.');
