import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = mobileRoot.replace(/[\\/]apps[\\/]mobile$/u, '');
const iosRoot = path.join(mobileRoot, 'ios');

const [project, info, iconContents, scheme, workflow, gitignore, packageJson, icon, splash] =
  await Promise.all([
    readFile(path.join(iosRoot, 'App/App.xcodeproj/project.pbxproj'), 'utf8'),
    readFile(path.join(iosRoot, 'App/App/Info.plist'), 'utf8'),
    readFile(
      path.join(iosRoot, 'App/App/Assets.xcassets/AppIcon.appiconset/Contents.json'),
      'utf8',
    ),
    readFile(path.join(iosRoot, 'App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme'), 'utf8'),
    readFile(path.join(projectRoot, '.github/workflows/ios-ipa.yml'), 'utf8'),
    readFile(path.join(iosRoot, '.gitignore'), 'utf8'),
    readFile(path.join(mobileRoot, 'package.json'), 'utf8'),
    readFile(path.join(iosRoot, 'App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')),
    readFile(path.join(iosRoot, 'App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png')),
  ]);

function pngMetadata(buffer) {
  assert.equal(buffer.toString('ascii', 1, 4), 'PNG');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer[25],
  };
}

assert.equal(
  (project.match(/PRODUCT_BUNDLE_IDENTIFIER = com\.puretavern\.app;/gu) ?? []).length,
  2,
);
const appVersion = JSON.parse(packageJson).version;
const escapedVersion = appVersion.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
assert.equal(
  (project.match(new RegExp(`MARKETING_VERSION = ${escapedVersion};`, 'gu')) ?? []).length,
  2,
);
assert.match(info, /<string>PureTavern<\/string>/u);
assert.match(iconContents, /AppIcon-512@2x\.png/u);
assert.match(scheme, /BlueprintIdentifier = "504EC3031FED79650016851F"/u);
assert.match(workflow, /^\s*workflow_dispatch:\s*$/mu);
assert.doesNotMatch(workflow, /^\s*push:\s*$/mu);
assert.match(workflow, /CODE_SIGNING_ALLOWED=NO/u);
assert.match(workflow, /PureTavern-unsigned\.ipa/u);
assert.match(gitignore, /^output$/mu);
assert.deepEqual(pngMetadata(icon), { width: 1024, height: 1024, colorType: 2 });
assert.deepEqual(pngMetadata(splash), { width: 2732, height: 2732, colorType: 2 });

console.log('PureTavern Capacitor iOS shell contract verified.');
