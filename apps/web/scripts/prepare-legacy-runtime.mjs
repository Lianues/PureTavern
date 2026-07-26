import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import { generateDefaultAssetManifest } from './default-asset-manifest-generator.mjs';
import { generateHookedIndex } from './legacy-index-generator.mjs';
import { generatePresetSeedManifest } from './preset-manifest-generator.mjs';
import { generateTrustedExtensionManifest } from './trusted-extension-manifest-generator.mjs';

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
const featuresRoot = path.join(packageRoot, 'src', 'features');
const brandingRoot = path.join(packageRoot, 'src', 'branding');
const BRANDING_ASSETS = Object.freeze([
  ['pure-tavern-favicon.ico', 'favicon.ico'],
  ['pure-tavern-icon.png', 'img/pure-tavern-icon.png'],
  ['pure-tavern-logo-330.png', 'img/logo.png'],
  ['pure-tavern-system-avatar.png', 'img/five.png'],
  ...[57, 72, 114, 144, 192, 512].map((size) => [
    `apple-icon-${size}x${size}.png`,
    `img/apple-icon-${size}x${size}.png`,
  ]),
]);

const RUNTIME_EXCLUDES = new Set(['index.html', 'UPSTREAM_LICENSE', 'UPSTREAM_SOURCE.md']);
const CLOUDFLARE_PAGES_HEADERS = `
/assets/modern-*
  Cache-Control: public, max-age=31536000, immutable
/
  Cache-Control: no-cache, no-store, must-revalidate
/index.html
  Cache-Control: no-cache, no-store, must-revalidate
/__pure_tavern/runtime-version.json
  Cache-Control: no-cache, no-store, must-revalidate
/__pure_tavern/runtime-marker.js
  Cache-Control: public, max-age=31536000, immutable
/__pure_tavern/legacy-hook.js
  Cache-Control: no-cache, must-revalidate
/pure-tavern-assets-service-worker.js
  Cache-Control: no-cache, must-revalidate
/scripts/extensions/pure-tavern-data-management/*
  Cache-Control: no-cache, must-revalidate
`.trimStart();

export async function prepareLegacyRuntime() {
  const upstreamIndex = await readFile(path.join(upstreamPublicRoot, 'index.html'), 'utf8');
  // Single source of truth for the release version; scripts/set-release-version.mjs
  // already rewrites this file, so no version is hardcoded in web sources.
  const { version: appVersion } = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  const buildId = randomUUID().replaceAll('-', '');
  const generatedIndex = generateHookedIndex(upstreamIndex, buildId);

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
  const [presetManifest, defaultAssetManifest, trustedExtensionManifest] = await Promise.all([
    generatePresetSeedManifest(upstreamDefaultContentRoot),
    generateDefaultAssetManifest(upstreamDefaultContentRoot),
    generateTrustedExtensionManifest(upstreamPublicRoot),
  ]);
  trustedExtensionManifest.extensions.push(await loadDataManagementExtensionDefinition());
  trustedExtensionManifest.extensions.sort((left, right) =>
    left.legacyName.localeCompare(right.legacyName, 'en'),
  );
  await Promise.all([
    writeFile(
      path.join(compatibilityAssetsRoot, 'default-presets.json'),
      JSON.stringify(presetManifest),
      'utf8',
    ),
    writeFile(
      path.join(compatibilityAssetsRoot, 'default-assets.json'),
      JSON.stringify(defaultAssetManifest),
      'utf8',
    ),
    writeFile(
      path.join(compatibilityAssetsRoot, 'trusted-extensions.json'),
      JSON.stringify(trustedExtensionManifest),
      'utf8',
    ),
    writeFile(
      path.join(compatibilityAssetsRoot, 'runtime-version.json'),
      JSON.stringify({ buildId }),
      'utf8',
    ),
    writeFile(path.join(compatibilityAssetsRoot, 'runtime-marker.js'), "'use strict';\n", 'utf8'),
    writeFile(path.join(generatedPublicRoot, '_headers'), CLOUDFLARE_PAGES_HEADERS, 'utf8'),
  ]);
  await copyBrandingAssets();
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
  await copyFeatureRuntimeAssets();

  await build({
    entryPoints: [path.join(packageRoot, 'scripts', 'legacy-lib-entry.mjs')],
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
    define: {
      __PURE_TAVERN_BUILD_ID__: JSON.stringify(buildId),
      __PURE_TAVERN_VERSION__: JSON.stringify(appVersion),
    },
  });

  await writeFile(generatedIndexPath, generatedIndex, 'utf8');
  await writeFile(path.join(generatedPublicRoot, 'index.html'), generatedIndex, 'utf8');
  console.log(
    `Prepared Legacy runtime: ${path.relative(packageRoot, generatedIndexPath)} + ${path.relative(packageRoot, generatedPublicRoot)}`,
  );
}

export async function loadDataManagementExtensionDefinition() {
  const extensionRoot = path.join(featuresRoot, 'import-export', 'runtime');
  const manifestPath = path.join(extensionRoot, 'manifest.json');
  const raw = await readFile(manifestPath);
  const manifest = JSON.parse(raw.toString('utf8'));
  if (!manifest || typeof manifest !== 'object' || manifest.js !== 'index.js') {
    throw new Error('PureTavern data management extension manifest is invalid.');
  }
  await access(path.join(extensionRoot, 'index.js'));
  if (manifest.css) await access(path.join(extensionRoot, manifest.css));
  return {
    extensionId: 'pure-tavern.data-management',
    legacyName: 'pure-tavern-data-management',
    displayName: manifest.display_name,
    version: manifest.version,
    author: manifest.author,
    scriptPath: '/scripts/extensions/pure-tavern-data-management/index.js',
    description: manifest.description,
    sourceKind: 'pure-tavern-first-party',
    sourceHash: createHash('sha256').update(raw).digest('hex'),
  };
}

async function copyBrandingAssets() {
  for (const [source, target] of BRANDING_ASSETS) {
    const targetPath = path.join(generatedPublicRoot, target);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(path.join(brandingRoot, source), targetPath, { force: true });
  }
}

async function copyFeatureRuntimeAssets() {
  let entries;
  try {
    entries = await readdir(featuresRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.filter((item) => item.isDirectory())) {
    const manifestPath = path.join(featuresRoot, entry.name, 'runtime-assets.json');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }

    if (!Array.isArray(manifest.assets)) {
      throw new Error(`Invalid runtime asset manifest: ${manifestPath}`);
    }

    for (const asset of manifest.assets) {
      if (!asset || typeof asset.source !== 'string' || typeof asset.publicPath !== 'string') {
        throw new Error(`Invalid runtime asset entry in ${manifestPath}`);
      }
      if (path.isAbsolute(asset.source) || path.isAbsolute(asset.publicPath)) {
        throw new Error(`Runtime asset paths must be relative: ${manifestPath}`);
      }

      const sourcePath = path.resolve(featuresRoot, entry.name, asset.source);
      const targetPath = path.resolve(generatedPublicRoot, asset.publicPath);
      const featureRoot = path.resolve(featuresRoot, entry.name);
      const generatedRoot = path.resolve(generatedPublicRoot);

      if (!isPathInside(sourcePath, featureRoot) || !isPathInside(targetPath, generatedRoot)) {
        throw new Error(`Runtime asset path escapes its allowed root: ${manifestPath}`);
      }

      await mkdir(path.dirname(targetPath), { recursive: true });
      if (asset.bundle === true) {
        await build({
          entryPoints: [sourcePath],
          outfile: targetPath,
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
      } else {
        await cp(sourcePath, targetPath, { recursive: true, force: true });
      }
    }
  }
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  await prepareLegacyRuntime();
}
