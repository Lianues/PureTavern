import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readConfiguredTarget(buildProfile, property) {
  const pattern = new RegExp(`${property}\\s*:\\s*['"]([^'"]+)['"]`, 'u');
  const match = buildProfile.match(pattern);
  if (!match?.[1])
    throw new Error(`Harmony project is missing ${property} in build-profile.json5.`);
  return match[1];
}

async function findSdkPackage(hvigorPath) {
  let current = path.resolve(path.dirname(hvigorPath));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(current, 'sdk', 'default', 'sdk-pkg.json');
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile()) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate bundled HarmonyOS sdk-pkg.json from hvigor: ${hvigorPath}`);
}

export function harmonySdkTarget(metadata) {
  const platformVersion = metadata?.data?.platformVersion;
  const apiVersion = metadata?.data?.apiVersion;
  if (typeof platformVersion !== 'string' || typeof apiVersion !== 'string') {
    throw new Error(
      'HarmonyOS sdk-pkg.json does not declare data.platformVersion and data.apiVersion.',
    );
  }
  return `${platformVersion}(${apiVersion})`;
}

export async function verifyHarmonySdk({ hvigorPath, projectRoot }) {
  const sdkPackagePath = await findSdkPackage(hvigorPath);
  const metadata = JSON.parse(await readFile(sdkPackagePath, 'utf8'));
  const installedTarget = harmonySdkTarget(metadata);
  const buildProfile = await readFile(path.join(projectRoot, 'build-profile.json5'), 'utf8');
  const compileTarget = readConfiguredTarget(buildProfile, 'compileSdkVersion');
  const compatibleTarget = readConfiguredTarget(buildProfile, 'compatibleSdkVersion');
  const targetTarget = readConfiguredTarget(buildProfile, 'targetSdkVersion');

  if (
    compileTarget !== installedTarget ||
    compatibleTarget !== installedTarget ||
    targetTarget !== installedTarget
  ) {
    throw new Error(
      `HarmonyOS SDK target mismatch: CLI provides ${installedTarget}, ` +
        `but build-profile.json5 requests compile=${compileTarget}, compatible=${compatibleTarget}, target=${targetTarget}.`,
    );
  }

  return { compatibleTarget, compileTarget, installedTarget, sdkPackagePath, targetTarget };
}

async function main() {
  const hvigorPath = process.env.HARMONY_HVIGORW;
  if (!hvigorPath)
    throw new Error('HARMONY_HVIGORW is not set. Discover the HarmonyOS tools first.');
  const harmonyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = await verifyHarmonySdk({ hvigorPath, projectRoot: harmonyRoot });
  console.log(`Verified bundled HarmonyOS SDK ${result.installedTarget}.`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) await main();
