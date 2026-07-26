import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [runner, packageJson] = await Promise.all([
  readFile(path.join(mobileRoot, 'scripts/run-gradle.mjs'), 'utf8'),
  readFile(path.join(mobileRoot, 'package.json'), 'utf8'),
]);

assert.match(runner, /process\.platform === 'win32'.*cmd\.exe/u);
assert.match(runner, /: '\/bin\/sh'/u);
assert.match(runner, /\['\.\/gradlew', task\]/u);
assert.doesNotMatch(runner, /: '\.\/gradlew'/u);
const scripts = JSON.parse(packageJson).scripts;
assert.match(scripts['build:android:debug'], /run-gradle\.mjs assembleDebug/u);
assert.match(scripts['build:android:release'], /run-gradle\.mjs assembleRelease/u);

const buildGradle = await readFile(path.join(mobileRoot, 'android/app/build.gradle'), 'utf8');
assert.match(buildGradle, /PURE_TAVERN_KEYSTORE_PATH/u);
assert.match(buildGradle, /signingConfig signingConfigs\.release/u);

console.log('PureTavern cross-platform Gradle runner contract verified.');
