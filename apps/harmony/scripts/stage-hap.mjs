import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

async function findHaps(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await findHaps(target)));
    else if (entry.isFile() && entry.name.endsWith('.hap')) files.push(target);
  }
  return files;
}

export function harmonyReleaseAssetName(version) {
  if (!STABLE_SEMVER.test(version)) throw new Error(`Invalid stable release version: ${version}`);
  return `PureTavern-${version}-harmonyos-next-arm64-unsigned.hap`;
}

export async function stageHarmonyHap({ buildRoot, outputRoot, version }) {
  const candidates = await findHaps(path.resolve(buildRoot));
  const unsigned = candidates.filter((candidate) => path.basename(candidate).includes('unsigned'));
  const matches = unsigned.length ? unsigned : candidates;
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one HarmonyOS HAP under ${buildRoot}, found ${matches.length}.`,
    );
  }
  const info = await stat(matches[0]);
  if (!info.isFile() || info.size === 0) throw new Error(`HarmonyOS HAP is empty: ${matches[0]}`);
  const output = path.resolve(outputRoot, harmonyReleaseAssetName(version));
  await mkdir(path.dirname(output), { recursive: true });
  await copyFile(matches[0], output);
  return output;
}

async function main() {
  const [version, buildRoot, outputRoot] = process.argv.slice(2);
  if (!version || !buildRoot || !outputRoot) {
    throw new Error('Usage: node scripts/stage-hap.mjs <version> <build-root> <output-root>');
  }
  const output = await stageHarmonyHap({ version, buildRoot, outputRoot });
  console.log(`Staged ${path.basename(output)}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) await main();
