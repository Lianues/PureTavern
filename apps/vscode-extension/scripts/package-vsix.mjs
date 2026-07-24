import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVSIX } from '@vscode/vsce';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
const releaseRoot = path.join(extensionRoot, 'release');
const packagePath = path.join(releaseRoot, `PureTavern-VSCode-${manifest.version}.vsix`);

await mkdir(releaseRoot, { recursive: true });
await rm(packagePath, { force: true });
await createVSIX({
  cwd: extensionRoot,
  packagePath,
  dependencies: false,
});
console.log(`Created ${path.relative(extensionRoot, packagePath)}.`);
