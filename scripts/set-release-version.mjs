import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_FILES = Object.freeze([
  'package.json',
  'apps/desktop/package.json',
  'apps/harmony/package.json',
  'apps/mobile/package.json',
  'apps/server/package.json',
  'apps/vscode-extension/package.json',
  'apps/web/package.json',
  'packages/contracts/package.json',
  'packages/shared/package.json',
]);

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function assertReleaseVersion(version) {
  if (!STABLE_SEMVER.test(version)) {
    throw new Error(
      `Release version must be stable SemVer without a v prefix (for example 0.2.0): ${version}`,
    );
  }
  return version;
}

export function harmonyVersionCode(version) {
  const [major, minor, patch] = assertReleaseVersion(version).split('.').map(Number);
  const code = major * 1_000_000 + minor * 1_000 + patch + 1;
  if (!Number.isSafeInteger(code) || code > 2_147_483_647) {
    throw new Error(`Release version cannot be represented as a HarmonyOS versionCode: ${version}`);
  }
  return code;
}

async function updateJson(root, relativePath, mutate) {
  const target = path.join(root, relativePath);
  const value = JSON.parse(await readFile(target, 'utf8'));
  mutate(value);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function replaceText(root, relativePath, pattern, replacement, expectedCount = 1) {
  const target = path.join(root, relativePath);
  const current = await readFile(target, 'utf8');
  const matches = current.match(pattern);
  if ((matches?.length ?? 0) !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} version match(es) in ${relativePath}, found ${matches?.length ?? 0}.`,
    );
  }
  await writeFile(target, current.replace(pattern, replacement), 'utf8');
}

export async function applyReleaseVersion(root, requestedVersion) {
  const version = assertReleaseVersion(requestedVersion);
  const harmonyCode = harmonyVersionCode(version);

  await Promise.all(
    PACKAGE_FILES.map((relativePath) =>
      updateJson(root, relativePath, (value) => {
        value.version = version;
      }),
    ),
  );

  await updateJson(root, 'apps/desktop/src-tauri/tauri.conf.json', (value) => {
    value.version = version;
  });

  await replaceText(
    root,
    'apps/desktop/src-tauri/Cargo.toml',
    /^version = "[^"]+"$/gmu,
    `version = "${version}"`,
  );
  await replaceText(
    root,
    'apps/desktop/src-tauri/Cargo.lock',
    /(\[\[package\]\]\r?\nname = "pure-tavern-desktop"\r?\nversion = ")[^"]+("\r?\n)/gu,
    `$1${version}$2`,
  );
  await replaceText(
    root,
    'apps/harmony/AppScope/app.json5',
    /((?:["']?versionCode["']?)\s*:\s*)\d+/gu,
    `$1${harmonyCode}`,
  );
  await replaceText(
    root,
    'apps/harmony/AppScope/app.json5',
    /((?:["']?versionName["']?)\s*:\s*["'])[^"']+(["'])/gu,
    `$1${version}$2`,
  );
  await replaceText(
    root,
    'apps/mobile/android/app/build.gradle',
    /(def pureTavernVersionName = System\.getenv\('PURE_TAVERN_VERSION_NAME'\) \?: ')[^']+(')/gu,
    `$1${version}$2`,
  );
  await replaceText(
    root,
    'apps/mobile/ios/App/App.xcodeproj/project.pbxproj',
    /MARKETING_VERSION = [^;]+;/gu,
    `MARKETING_VERSION = ${version};`,
    2,
  );
  await replaceText(
    root,
    'apps/web/src/features/import-export/application/archive-service.ts',
    /(this\.#appVersion = options\.appVersion \?\? ')[^']+(';)/gu,
    `$1${version}$2`,
  );
  await replaceText(
    root,
    'apps/web/src/legacy-hook/bootstrap.ts',
    /(hookVersion: ')[^']+(',)/gu,
    `$1${version}$2`,
  );

  return {
    version,
    tag: `test-v${version}`,
    title: `${version} Test`,
  };
}

async function main() {
  const [version, flag] = process.argv.slice(2);
  assertReleaseVersion(version ?? '');
  if (flag === '--check') {
    console.log(`Test release version accepted: ${version}`);
    return;
  }
  if (flag !== undefined) {
    throw new Error(`Unknown argument: ${flag}`);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = await applyReleaseVersion(root, version);
  console.log(
    `Applied PureTavern ${result.version}; test tag ${result.tag}; release title ${result.title}.`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
