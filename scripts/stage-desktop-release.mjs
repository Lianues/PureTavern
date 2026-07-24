import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SUPPORTED_TARGETS = new Set(['windows:x64', 'macos:x64', 'macos:arm64', 'linux:x64']);

export function desktopReleaseAssetNames(platform, arch, version) {
  if (!STABLE_SEMVER.test(version)) throw new Error(`Invalid stable release version: ${version}`);
  const target = `${platform}:${arch}`;
  if (!SUPPORTED_TARGETS.has(target))
    throw new Error(`Unsupported desktop release target: ${target}`);

  const prefix = `PureTavern-${version}-${platform}-${arch}`;
  if (platform === 'windows') {
    return {
      setup: `${prefix}-setup.exe`,
      portable: `${prefix}-portable.exe`,
    };
  }
  if (platform === 'macos') return { dmg: `${prefix}.dmg` };
  return {
    appimage: `${prefix}.AppImage`,
    deb: `${prefix}.deb`,
    rpm: `${prefix}.rpm`,
  };
}

async function findSingleFile(directory, predicate, description) {
  const entries = await readdir(directory, { withFileTypes: true });
  const matches = entries.filter((entry) => entry.isFile() && predicate(entry.name));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${description} in ${directory}, found ${matches.length}.`,
    );
  }
  return path.join(directory, matches[0].name);
}

async function copyAsset(source, outputRoot, outputName) {
  const info = await stat(source);
  if (!info.isFile() || info.size === 0)
    throw new Error(`Release asset is empty or invalid: ${source}`);
  const target = path.join(outputRoot, outputName);
  await copyFile(source, target);
  return target;
}

export async function stageDesktopRelease({ platform, arch, version, releaseRoot, outputRoot }) {
  const names = desktopReleaseAssetNames(platform, arch, version);
  const normalizedReleaseRoot = path.resolve(releaseRoot);
  const normalizedOutputRoot = path.resolve(outputRoot);
  await mkdir(normalizedOutputRoot, { recursive: true });

  if (platform === 'windows') {
    const setup = await findSingleFile(
      path.join(normalizedReleaseRoot, 'bundle', 'nsis'),
      (name) => name.toLowerCase().endsWith('.exe'),
      'NSIS installer',
    );
    const portable = path.join(normalizedReleaseRoot, 'pure-tavern-desktop.exe');
    return Promise.all([
      copyAsset(setup, normalizedOutputRoot, names.setup),
      copyAsset(portable, normalizedOutputRoot, names.portable),
    ]);
  }

  if (platform === 'macos') {
    const dmg = await findSingleFile(
      path.join(normalizedReleaseRoot, 'bundle', 'dmg'),
      (name) => name.toLowerCase().endsWith('.dmg'),
      'macOS DMG',
    );
    return [await copyAsset(dmg, normalizedOutputRoot, names.dmg)];
  }

  const appimage = await findSingleFile(
    path.join(normalizedReleaseRoot, 'bundle', 'appimage'),
    (name) => name.endsWith('.AppImage'),
    'Linux AppImage',
  );
  const deb = await findSingleFile(
    path.join(normalizedReleaseRoot, 'bundle', 'deb'),
    (name) => name.endsWith('.deb'),
    'Linux DEB',
  );
  const rpm = await findSingleFile(
    path.join(normalizedReleaseRoot, 'bundle', 'rpm'),
    (name) => name.endsWith('.rpm'),
    'Linux RPM',
  );
  return Promise.all([
    copyAsset(appimage, normalizedOutputRoot, names.appimage),
    copyAsset(deb, normalizedOutputRoot, names.deb),
    copyAsset(rpm, normalizedOutputRoot, names.rpm),
  ]);
}

async function main() {
  const [platform, arch, version, releaseRoot, outputRoot] = process.argv.slice(2);
  if (!platform || !arch || !version || !releaseRoot || !outputRoot) {
    throw new Error(
      'Usage: node scripts/stage-desktop-release.mjs <platform> <arch> <version> <release-root> <output-root>',
    );
  }
  const staged = await stageDesktopRelease({ platform, arch, version, releaseRoot, outputRoot });
  for (const target of staged) console.log(`Staged ${path.basename(target)}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) await main();
