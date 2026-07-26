import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readConfiguredTarget(productBlock, property, productName) {
  const pattern = new RegExp(`${property}\\s*:\\s*['"]([^'"]+)['"]`, 'u');
  const match = productBlock.match(pattern);
  if (!match?.[1]) {
    throw new Error(
      `Harmony product ${productName} is missing ${property} in build-profile.json5.`,
    );
  }
  return match[1];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function readProductBlock(buildProfile, productName) {
  const namePattern = new RegExp(`name\\s*:\\s*['"]${escapeRegex(productName)}['"]`, 'u');
  const nameMatch = namePattern.exec(buildProfile);
  if (!nameMatch) throw new Error(`Harmony product ${productName} is not defined.`);

  const start = buildProfile.lastIndexOf('{', nameMatch.index);
  if (start < 0) throw new Error(`Harmony product ${productName} has no object definition.`);

  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < buildProfile.length; index += 1) {
    const character = buildProfile[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return buildProfile.slice(start, index + 1);
    }
  }
  throw new Error(`Harmony product ${productName} has an unterminated object definition.`);
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

export async function verifyHarmonySdk({
  hvigorPath,
  projectRoot,
  productName = process.env.HARMONY_PRODUCT ?? 'default',
}) {
  const sdkPackagePath = await findSdkPackage(hvigorPath);
  const metadata = JSON.parse(await readFile(sdkPackagePath, 'utf8'));
  const installedTarget = harmonySdkTarget(metadata);
  const buildProfile = await readFile(path.join(projectRoot, 'build-profile.json5'), 'utf8');
  const productBlock = readProductBlock(buildProfile, productName);
  const compileTarget = readConfiguredTarget(productBlock, 'compileSdkVersion', productName);
  const compatibleTarget = readConfiguredTarget(productBlock, 'compatibleSdkVersion', productName);
  const targetTarget = readConfiguredTarget(productBlock, 'targetSdkVersion', productName);

  if (compileTarget !== installedTarget || targetTarget !== installedTarget) {
    throw new Error(
      `HarmonyOS SDK target mismatch for product ${productName}: CLI provides ${installedTarget}, ` +
        `but build-profile.json5 requests compile=${compileTarget}, compatible=${compatibleTarget}, target=${targetTarget}.`,
    );
  }

  return {
    compatibleTarget,
    compileTarget,
    installedTarget,
    productName,
    sdkPackagePath,
    targetTarget,
  };
}

async function main() {
  const hvigorPath = process.env.HARMONY_HVIGORW;
  if (!hvigorPath)
    throw new Error('HARMONY_HVIGORW is not set. Discover the HarmonyOS tools first.');
  const harmonyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = await verifyHarmonySdk({ hvigorPath, projectRoot: harmonyRoot });
  console.log(
    `Verified HarmonyOS product ${result.productName} against SDK ${result.installedTarget}.`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) await main();
