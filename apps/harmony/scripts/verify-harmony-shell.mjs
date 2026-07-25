import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const harmonyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(harmonyRoot, '../..');

const [
  appScope,
  buildProfile,
  moduleProfile,
  ability,
  page,
  loader,
  syncScript,
  buildScript,
  stageScript,
  workflow,
  packageJson,
  icon,
] = await Promise.all([
  readFile(path.join(harmonyRoot, 'AppScope/app.json5'), 'utf8'),
  readFile(path.join(harmonyRoot, 'build-profile.json5'), 'utf8'),
  readFile(path.join(harmonyRoot, 'entry/src/main/module.json5'), 'utf8'),
  readFile(path.join(harmonyRoot, 'entry/src/main/ets/entryability/EntryAbility.ets'), 'utf8'),
  readFile(path.join(harmonyRoot, 'entry/src/main/ets/pages/Index.ets'), 'utf8'),
  readFile(path.join(harmonyRoot, 'entry/src/main/ets/web/LocalWebAssetLoader.ets'), 'utf8'),
  readFile(path.join(harmonyRoot, 'scripts/sync-web-assets.mjs'), 'utf8'),
  readFile(path.join(harmonyRoot, 'scripts/build-hap.mjs'), 'utf8'),
  readFile(path.join(harmonyRoot, 'scripts/stage-hap.mjs'), 'utf8'),
  readFile(path.join(workspaceRoot, '.github/workflows/harmony-hap.yml'), 'utf8'),
  readFile(path.join(harmonyRoot, 'package.json'), 'utf8'),
  readFile(path.join(harmonyRoot, 'entry/src/main/resources/base/media/app_icon.png')),
]);

assert.match(appScope, /bundleName\s*:\s*['"]com\.puretavern\.harmony['"]/u);
assert.match(appScope, /versionName\s*:\s*['"]0\.1\.0['"]/u);
assert.match(buildProfile, /compileSdkVersion\s*:\s*['"]6\.0\.2\(22\)['"]/u);
assert.match(buildProfile, /compatibleSdkVersion\s*:\s*['"]6\.0\.2\(22\)['"]/u);
assert.match(buildProfile, /signingConfigs\s*:\s*\[\]/u);
assert.match(moduleProfile, /['"]ohos\.permission\.INTERNET['"]/u);
assert.match(
  moduleProfile,
  /deviceTypes\s*:\s*\[['"]phone['"],\s*['"]tablet['"],\s*['"]2in1['"]\]/u,
);
assert.match(ability, /setWindowLayoutFullScreen\(true\)/u);
assert.match(ability, /setSpecificSystemBarEnabled\('status', false\)/u);
assert.match(ability, /setSpecificSystemBarEnabled\('navigationIndicator', false\)/u);
assert.match(page, /https:\/\/puretavern\.local\//u);
assert.match(page, /onInterceptRequest/u);
assert.match(page, /domStorageAccess\(true\)/u);
assert.match(page, /DocumentViewPicker/u);
assert.match(loader, /getRawFileContentSync/u);
assert.match(loader, /WEB_ASSET_PATHS\.has/u);
assert.match(loader, /application\/wasm/u);
assert.match(syncScript, /apps\/web\/dist/u);
assert.match(syncScript, /pure-tavern-assets-service-worker\.js/u);
assert.match(buildScript, /assembleHap/u);
assert.match(stageScript, /harmonyos-next-arm64-unsigned\.hap/u);
assert.match(workflow, /^\s*workflow_dispatch:\s*$/mu);
assert.doesNotMatch(workflow, /^\s*push:\s*$/mu);
assert.doesNotMatch(workflow, /inputs\.version|inputs:\s*\n\s*version:/u);
assert.match(workflow, /name: Read package version/u);
assert.match(workflow, /require\("\.\/package\.json"\)\.version/u);
assert.match(workflow, /runs-on: ubuntu-22\.04/u);
assert.match(workflow, /@hmtools\/hmos-cli-lite-linux@\$HMOS_CLI_VERSION/u);
assert.match(workflow, /HMOS_CLI_VERSION: 0\.0\.1/u);
assert.match(workflow, /github\.run_number/u);
assert.match(workflow, /release\/\*\.hap/u);
assert.match(JSON.parse(packageJson).scripts['build:hap'], /sync-web-assets\.mjs/u);
assert.equal(icon.subarray(1, 4).toString('ascii'), 'PNG');
assert.equal(icon.readUInt32BE(16), 512);
assert.equal(icon.readUInt32BE(20), 512);

console.log('PureTavern HarmonyOS NEXT shell and hosted HAP workflow contracts verified.');
