import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = mobileRoot.replace(/[\\/]apps[\\/]mobile$/u, '');
const iosRoot = path.join(mobileRoot, 'ios');
const requireFromWeb = createRequire(path.join(projectRoot, 'apps/web/package.json'));
const webMimeTypes = requireFromWeb('mime').types;

const [
  project,
  info,
  iconContents,
  scheme,
  workflow,
  gitignore,
  packageJson,
  capacitorConfigSource,
  icon,
  splash,
  storyboard,
  bridgeViewController,
  assetSchemeHandler,
  iosAssetBridge,
  iosTabsFix,
  extensionMimeTypesSource,
  webAssetServiceWorker,
] = await Promise.all([
  readFile(path.join(iosRoot, 'App/App.xcodeproj/project.pbxproj'), 'utf8'),
  readFile(path.join(iosRoot, 'App/App/Info.plist'), 'utf8'),
  readFile(path.join(iosRoot, 'App/App/Assets.xcassets/AppIcon.appiconset/Contents.json'), 'utf8'),
  readFile(path.join(iosRoot, 'App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme'), 'utf8'),
  readFile(path.join(projectRoot, '.github/workflows/ios-ipa.yml'), 'utf8'),
  readFile(path.join(iosRoot, '.gitignore'), 'utf8'),
  readFile(path.join(mobileRoot, 'package.json'), 'utf8'),
  readFile(path.join(mobileRoot, 'capacitor.config.ts'), 'utf8'),
  readFile(path.join(iosRoot, 'App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')),
  readFile(path.join(iosRoot, 'App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png')),
  readFile(path.join(iosRoot, 'App/App/Base.lproj/Main.storyboard'), 'utf8'),
  readFile(path.join(iosRoot, 'App/App/PureTavernBridgeViewController.swift'), 'utf8'),
  readFile(path.join(iosRoot, 'App/App/PureTavernAssetSchemeHandler.swift'), 'utf8'),
  readFile(path.join(iosRoot, 'App/App/PureTavernAssetBridge.js'), 'utf8'),
  readFile(path.join(iosRoot, 'App/App/PureTavernTabsFix.js'), 'utf8'),
  readFile(path.join(iosRoot, 'App/App/PureTavernExtensionMimeTypes.json'), 'utf8'),
  readFile(
    path.join(
      projectRoot,
      'apps/web/src/features/assets/infrastructure/pure-tavern-assets-service-worker.js',
    ),
    'utf8',
  ),
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
assert.match(info, /<key>UIStatusBarHidden<\/key>\s*<true\/>/u);
assert.match(info, /<key>UIViewControllerBasedStatusBarAppearance<\/key>\s*<true\/>/u);
assert.match(capacitorConfigSource, /backgroundColor:\s*['"]#171717['"]/u);
assert.match(capacitorConfigSource, /ios:\s*\{[\s\S]*?contentInset:\s*['"]never['"],?[\s\S]*?\}/u);
assert.doesNotMatch(capacitorConfigSource, /contentInset:\s*['"]always['"]/u);
assert.match(capacitorConfigSource, /SystemBars:\s*\{[\s\S]*?hidden:\s*true,?[\s\S]*?\}/u);
assert.match(iconContents, /AppIcon-512@2x\.png/u);
assert.match(scheme, /BlueprintIdentifier = "504EC3031FED79650016851F"/u);
assert.match(
  storyboard,
  /customClass="PureTavernBridgeViewController"\s+customModule="App"\s+customModuleProvider="target"/u,
);
for (const source of [
  'PureTavernBridgeViewController.swift',
  'PureTavernAssetSchemeHandler.swift',
]) {
  assert.match(project, new RegExp(`${source.replaceAll('.', '\\.')} in Sources`, 'u'));
}
assert.match(project, /PureTavernAssetBridge\.js in Resources/u);
assert.match(project, /PureTavernTabsFix\.js in Resources/u);
assert.match(project, /PureTavernExtensionMimeTypes\.json in Resources/u);
assert.match(
  bridgeViewController,
  /final class PureTavernWebViewConfiguration: WKWebViewConfiguration/u,
);
assert.match(bridgeViewController, /override func webViewConfiguration\(/u);
assert.match(bridgeViewController, /override func setURLSchemeHandler\(/u);
assert.match(bridgeViewController, /let fallbackHandler = urlSchemeHandler/u);
assert.match(
  bridgeViewController,
  /super\.setURLSchemeHandler\(handler, forURLScheme: urlScheme\)/u,
);
assert.match(bridgeViewController, /inheritCapacitorSettings/u);
assert.match(bridgeViewController, /websiteDataStore = source\.websiteDataStore/u);
assert.match(
  bridgeViewController,
  /defaultWebpagePreferences = source\.defaultWebpagePreferences/u,
);
assert.doesNotMatch(bridgeViewController, /setURLSchemeHandler\(nil/u);
const webViewFactory = bridgeViewController.match(
  /override func webView\(with frame:[\s\S]*?(?=\n\s*override func capacitorDidLoad)/u,
)?.[0];
assert.ok(webViewFactory, 'The PureTavern WKWebView factory override is missing.');
assert.doesNotMatch(webViewFactory, /setURLSchemeHandler/u);
assert.match(
  bridgeViewController,
  /WKUserScript\(source: source, injectionTime: \.atDocumentStart/u,
);
assert.match(bridgeViewController, /addUserScript\(named: "PureTavernAssetBridge"/u);
// jQuery UI 1.13.2 的 _isLocal() 把 anchor 和 location 当字符串比。Capacitor 加载的
// capacitor://localhost 没有路径，而 <base href="/"> 会把页内 anchor 解析成带 "/" 的形式，
// 于是页内 tab 被判成远程 tab，jQuery UI 去 AJAX 加载应用根路径，把整份 Legacy 文档注入成
// 第二份副本。修的是这个判定函数，不是文档 URL。
assert.match(bridgeViewController, /addUserScript\(named: "PureTavernTabsFix"/u);
assert.match(iosTabsFix, /_isLocal/u);
assert.match(iosTabsFix, /__pureTavernIsLocalPatched/u);
// jQuery UI 自己判定为 local 时必须沿用其结果，补丁只负责救那个不一致的情形。
assert.match(iosTabsFix, /original\.call\(this, anchor\) \|\| isSameDocument\(anchor\)/u);
// 曾被真机否决的两种做法：document-start 的 replaceState 会和 WebKit 的
// blank-until-painted 逻辑抢时序（永久灰屏）；改 appStartPath / serverURL 则会改掉整个应用
// 启动所依据的文档 URL（启动卡死）。禁止退回。
assert.doesNotMatch(bridgeViewController.replace(/\/\/.*$/gmu, ''), /replaceState/u);
assert.doesNotMatch(bridgeViewController.replace(/\/\/.*$/gmu, ''), /appStartPath|serverURL/u);
assert.doesNotMatch(iosTabsFix.replace(/\/\/.*$/gmu, ''), /replaceState|pushState/u);
assert.match(assetSchemeHandler, /WKURLSchemeHandler/u);
assert.match(assetSchemeHandler, /final class FallbackTaskProxy: NSObject, WKURLSchemeTask/u);
assert.match(assetSchemeHandler, /fallbackHandler\.webView\(webView, start: proxy\)/u);
assert.match(assetSchemeHandler, /callAsyncJavaScript/u);
assert.match(assetSchemeHandler, /method == "GET" \|\| method == "HEAD"/u);
assert.match(assetSchemeHandler, /private static let chunkBytes: Int64 = 512 \* 1024/u);
assert.match(assetSchemeHandler, /private static let bridgeTimeoutSeconds: TimeInterval = 15/u);
assert.match(assetSchemeHandler, /DispatchSource\.makeTimerSource\(queue: \.main\)/u);
assert.doesNotMatch(assetSchemeHandler, /DispatchQueue\.main\.asyncAfter/u);
assert.match(assetSchemeHandler, /task\.request\.httpMethod == "HEAD"/u);
assert.match(assetSchemeHandler, /case \.delegated\(let delegatedTask\)/u);
assert.match(assetSchemeHandler, /self\.releaseAsset\(token, in: webView\)/u);
assert.match(assetSchemeHandler, /let status = range == nil \? 200 : 206/u);
assert.match(assetSchemeHandler, /"mjs": "application\/javascript; charset=UTF-8"/u);
assert.match(assetSchemeHandler, /PureTavernExtensionMimeTypes/u);
assert.match(assetSchemeHandler, /"wasm": "application\/wasm"/u);
assert.match(assetSchemeHandler, /segment != "\.\."/u);
assert.match(assetSchemeHandler, /readStaticData\(fileURL, range: range\)/u);
for (const contract of [
  "const DATABASE_NAME = 'pure-tavern-modular-dev'",
  "const KEY_SEPARATOR = '\\u001f'",
  "[ASSETS_MODULE, 'path-aliases', legacyPath]",
  "[ASSETS_MODULE, 'index', assetId]",
  "[CHARACTERS_MODULE, 'avatars', avatarFile]",
]) {
  assert.ok(iosAssetBridge.includes(contract), `Missing iOS bridge storage contract: ${contract}`);
  assert.ok(webAssetServiceWorker.includes(contract), `Web worker contract changed: ${contract}`);
}
for (const namespace of [
  '/thumbnail',
  '/backgrounds/',
  '/User Avatars/',
  '/user/files/',
  '/user/images/',
  '/characters/',
  '/assets/',
  '/scripts/extensions/third-party/',
]) {
  assert.ok(iosAssetBridge.includes(namespace), `Missing iOS bridge namespace: ${namespace}`);
  assert.ok(
    webAssetServiceWorker.includes(namespace),
    `Web worker namespace changed: ${namespace}`,
  );
}
assert.match(iosAssetBridge, /async function readChunk\(token, offset, length\)/u);
assert.match(iosAssetBridge, /function scheduleExpiry\(token, entry\)/u);
assert.match(iosAssetBridge, /Expired iOS asset bridge token/u);
assert.match(iosAssetBridge, /openExistingDatabase/u);
assert.match(iosAssetBridge, /request\.transaction\?\.abort\(\)/u);
assert.match(iosAssetBridge, /globalThis\.__PURE_TAVERN_IOS_ASSET_BRIDGE__/u);
const extensionMimeTypes = JSON.parse(extensionMimeTypesSource);
assert.deepEqual(
  extensionMimeTypes,
  Object.fromEntries(
    Object.entries(webMimeTypes).sort(([left], [right]) => left.localeCompare(right, 'en')),
  ),
);
assert.match(workflow, /^\s*workflow_dispatch:\s*$/mu);
assert.doesNotMatch(workflow, /^\s*push:\s*$/mu);
assert.match(workflow, /CODE_SIGNING_ALLOWED=NO/u);
assert.match(workflow, /PureTavern-\$RELEASE_VERSION-ios-unsigned\.ipa/u);
assert.match(gitignore, /^output$/mu);
assert.deepEqual(pngMetadata(icon), { width: 1024, height: 1024, colorType: 2 });
assert.deepEqual(pngMetadata(splash), { width: 2732, height: 2732, colorType: 2 });

console.log('PureTavern Capacitor iOS shell contract verified.');
