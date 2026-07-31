import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(desktopRoot, 'src/local-backend-bridge.ts');
const targetPath = path.join(desktopRoot, 'src-tauri/generated/local-backend-bridge.js');
const check = process.argv.includes('--check');

export async function buildDesktopLocalBackendBridge() {
  const result = await build({
    entryPoints: [sourcePath],
    outfile: targetPath,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
  });
  const output = `// Generated from apps/desktop/src/local-backend-bridge.ts.\n${result.outputFiles[0].text}`;
  if (check) {
    const current = await readFile(targetPath, 'utf8').catch(() => '');
    if (current !== output) {
      throw new Error('Desktop local backend bridge is stale. Run pnpm bridge:build.');
    }
    console.log('PureTavern desktop local backend bridge is current.');
    return targetPath;
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, output, 'utf8');
  console.log('Built PureTavern desktop local backend bridge.');
  return targetPath;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) await buildDesktopLocalBackendBridge();
