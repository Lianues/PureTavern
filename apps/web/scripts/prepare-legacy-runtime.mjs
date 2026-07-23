import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { generateHookedIndex } from './legacy-index-generator.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstreamPublicRoot = path.join(packageRoot, 'legacy', 'upstream', 'public');
const upstreamDefaultContentRoot = path.join(
  packageRoot,
  'legacy',
  'upstream',
  'default',
  'content',
);
const upstreamDefaultSettings = path.join(upstreamDefaultContentRoot, 'settings.json');
const upstreamMetadataPath = path.join(packageRoot, 'legacy', 'upstream.json');
const generatedPublicRoot = path.join(packageRoot, '.generated', 'public');
const generatedIndexPath = path.join(packageRoot, 'index.html');

const RUNTIME_EXCLUDES = new Set(['index.html', 'UPSTREAM_LICENSE', 'UPSTREAM_SOURCE.md']);

export async function prepareLegacyRuntime() {
  const upstreamIndex = await readFile(path.join(upstreamPublicRoot, 'index.html'), 'utf8');
  const generatedIndex = generateHookedIndex(upstreamIndex);

  await rm(generatedPublicRoot, { recursive: true, force: true });
  await mkdir(generatedPublicRoot, { recursive: true });

  const entries = await readdir(upstreamPublicRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (RUNTIME_EXCLUDES.has(entry.name)) continue;
    await cp(
      path.join(upstreamPublicRoot, entry.name),
      path.join(generatedPublicRoot, entry.name),
      {
        recursive: true,
        force: true,
      },
    );
  }

  const compatibilityAssetsRoot = path.join(generatedPublicRoot, '__pure_tavern');
  await mkdir(compatibilityAssetsRoot, { recursive: true });
  await cp(upstreamDefaultSettings, path.join(compatibilityAssetsRoot, 'default-settings.json'), {
    force: true,
  });
  await cp(upstreamMetadataPath, path.join(compatibilityAssetsRoot, 'upstream.json'), {
    force: true,
  });
  await mkdir(path.join(generatedPublicRoot, 'User Avatars'), { recursive: true });
  await cp(
    path.join(upstreamDefaultContentRoot, 'user-default.png'),
    path.join(generatedPublicRoot, 'User Avatars', 'user-default.png'),
    { force: true },
  );
  await cp(
    path.join(upstreamDefaultContentRoot, 'backgrounds'),
    path.join(generatedPublicRoot, 'backgrounds'),
    { recursive: true, force: true },
  );

  await build({
    entryPoints: [path.join(upstreamPublicRoot, 'lib.js')],
    outfile: path.join(generatedPublicRoot, 'lib.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    sourcemap: false,
    logLevel: 'silent',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });
  await build({
    entryPoints: [path.join(packageRoot, 'src', 'legacy-hook', 'bootstrap.ts')],
    outfile: path.join(compatibilityAssetsRoot, 'legacy-hook.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    sourcemap: false,
    logLevel: 'silent',
  });

  await writeFile(generatedIndexPath, generatedIndex, 'utf8');
  await writeFile(path.join(generatedPublicRoot, 'index.html'), generatedIndex, 'utf8');
  console.log(
    `Prepared Legacy runtime: ${path.relative(packageRoot, generatedIndexPath)} + ${path.relative(packageRoot, generatedPublicRoot)}`,
  );
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  await prepareLegacyRuntime();
}
