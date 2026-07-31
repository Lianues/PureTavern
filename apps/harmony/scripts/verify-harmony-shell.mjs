import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { harmonyVersionCode } from '../../../scripts/set-release-version.mjs';

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
  deployScript,
  discoveryScript,
  sdkScript,
  stageScript,
  platformBootstrap,
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
  readFile(path.join(harmonyRoot, 'scripts/deploy-local.mjs'), 'utf8'),
  readFile(path.join(harmonyRoot, 'scripts/discover-toolchain.mjs'), 'utf8'),
  readFile(path.join(harmonyRoot, 'scripts/verify-sdk.mjs'), 'utf8'),
  readFile(path.join(harmonyRoot, 'scripts/stage-hap.mjs'), 'utf8'),
  readFile(path.join(harmonyRoot, 'runtime/harmony-bootstrap.js'), 'utf8'),
  readFile(path.join(workspaceRoot, '.github/workflows/harmony-hap.yml'), 'utf8'),
  readFile(path.join(harmonyRoot, 'package.json'), 'utf8'),
  readFile(path.join(harmonyRoot, 'entry/src/main/resources/base/media/app_icon.png')),
]);

const harmonyPackage = JSON.parse(packageJson);
// Huawei rejects bundle names containing the reserved word "harmony".
assert.match(appScope, /bundleName\s*:\s*['"]com\.puretavern\.app['"]/u);
assert.ok(appScope.includes(`versionName: '${harmonyPackage.version}'`));
assert.ok(appScope.includes(`versionCode: ${harmonyVersionCode(harmonyPackage.version)}`));
assert.match(
  buildProfile,
  /name\s*:\s*['"]default['"][\s\S]*?compileSdkVersion\s*:\s*['"]6\.1\.1\(24\)['"][\s\S]*?compatibleSdkVersion\s*:\s*['"]6\.1\.0\(23\)['"][\s\S]*?targetSdkVersion\s*:\s*['"]6\.1\.1\(24\)['"]/u,
);
assert.match(
  buildProfile,
  /name\s*:\s*['"]ci['"][\s\S]*?compileSdkVersion\s*:\s*['"]6\.1\.0\(23\)['"][\s\S]*?compatibleSdkVersion\s*:\s*['"]6\.1\.0\(23\)['"][\s\S]*?targetSdkVersion\s*:\s*['"]6\.1\.0\(23\)['"]/u,
);
assert.match(buildProfile, /applyToProducts\s*:\s*\[['"]default['"],\s*['"]ci['"]\]/u);
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
assert.match(page, /registerServiceWorkerSchemeHandler\(\)/u);
assert.match(page, /domStorageAccess\(true\)/u);
assert.match(page, /setWebDebuggingAccess\(false\)/u);
assert.match(page, /initializeWebEngine\(\);[\s\S]*registerServiceWorkerSchemeHandler\(\)/u);
assert.doesNotMatch(page, /onConsole/u);
assert.match(page, /DocumentViewPicker/u);
assert.match(loader, /getRawFileContentSync/u);
assert.match(loader, /WEB_ASSET_PATHS\.has/u);
assert.match(loader, /new webview\.WebSchemeHandler\(\)/u);
assert.match(loader, /setServiceWorkerWebSchemeHandler\(['"]https['"]/u);
assert.doesNotMatch(loader, /hilog\.info/u);
assert.match(loader, /handler\.didReceiveResponse\(response\)/u);
assert.doesNotMatch(loader, /response\.setUrl/u);
assert.match(loader, /handler\.didReceiveResponseBody/u);
assert.match(loader, /handler\.didFinish\(\)/u);
assert.match(loader, /APP_ORIGIN: string = 'https:\/\/puretavern\.local'/u);
assert.match(loader, /const boundary = suffix\.charAt\(0\)/u);
assert.match(loader, /boundary !== '#'/u);
assert.match(loader, /queryIndex/u);
assert.match(loader, /fragmentIndex/u);
assert.doesNotMatch(loader, /\bURL\b/u);
assert.match(loader, /application\/wasm/u);
assert.match(syncScript, /apps\/web\/dist/u);
assert.match(syncScript, /pure-tavern-assets-service-worker\.js/u);
assert.match(syncScript, /data-pure-tavern-platform=\\?"harmony\\?"/u);
assert.match(platformBootstrap, /__PURE_TAVERN_PLATFORM__\s*=\s*['"]harmony['"]/u);
assert.doesNotMatch(platformBootstrap, /DISABLE_ASSET_SERVICE_WORKER/u);
assert.match(buildScript, /assembleHap/u);
assert.match(buildScript, /verifyHarmonySdk/u);
assert.match(buildScript, /HARMONY_PRODUCT/u);
assert.match(deployScript, /HARMONY_HDC/u);
assert.match(deployScript, /HARMONY_TARGET/u);
assert.match(deployScript, /'install', '-r'/u);
assert.match(deployScript, /'aa', 'start'/u);
assert.match(discoveryScript, /sanitizeHarmonyTools/u);
assert.match(discoveryScript, /AppleDouble metadata entries/u);
assert.match(discoveryScript, /patchOptionalImageTranscoder/u);
assert.match(discoveryScript, /eager HarmonyOS image transcoder/u);
assert.match(sdkScript, /HarmonyOS SDK target mismatch/u);
assert.match(sdkScript, /targetSdkVersion/u);
assert.match(sdkScript, /sdk-pkg\.json/u);
assert.match(stageScript, /harmonyos-next-arm64-unsigned\.hap/u);
assert.match(workflow, /^\s*workflow_dispatch:\s*$/mu);
assert.doesNotMatch(workflow, /^\s*push:\s*$/mu);
assert.doesNotMatch(workflow, /inputs\.version|inputs:\s*\n\s*version:/u);
assert.match(workflow, /name: Test Harmony shell contracts/u);
assert.match(workflow, /pnpm --dir apps\/harmony test/u);
assert.match(workflow, /name: Read package version/u);
assert.match(workflow, /require\("\.\/package\.json"\)\.version/u);
assert.match(workflow, /runs-on: ubuntu-22\.04/u);
assert.match(workflow, /@hmtools\/hmos-cli-lite-linux@\$HMOS_CLI_VERSION/u);
assert.match(workflow, /HARMONY_PRODUCT: ci/u);
assert.match(workflow, /HMOS_CLI_VERSION: 0\.0\.1/u);
assert.match(workflow, /name: Verify bundled HarmonyOS SDK/u);
assert.match(workflow, /scripts\/verify-sdk\.mjs/u);
assert.match(workflow, /github\.run_number/u);
assert.match(workflow, /release\/\*\.hap/u);
assert.match(JSON.parse(packageJson).scripts['build:hap'], /sync-web-assets\.mjs/u);
assert.match(JSON.parse(packageJson).scripts['deploy:local'], /deploy-local\.mjs/u);
assert.equal(icon.subarray(1, 4).toString('ascii'), 'PNG');
assert.equal(icon.readUInt32BE(16), 512);
assert.equal(icon.readUInt32BE(20), 512);

console.log('PureTavern HarmonyOS NEXT shell and hosted HAP workflow contracts verified.');
