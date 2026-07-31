import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import path from 'node:path';

import { installAndroidLocalBackendBridge } from './install-android-local-backend-bridge.mjs';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webGenerationRoot = path.resolve(mobileRoot, '../web/src/features/generation');
const localServerRoot = path.join(mobileRoot, 'android/local-server');
const bridgeSourcePath = path.join(localServerRoot, 'web/local-backend-bridge.js');

const [
  settings,
  appBuild,
  activity,
  libraryBuild,
  manifest,
  appManifest,
  capacitorConfig,
  plugin,
  engine,
  androidBridge,
  installer,
  webBridgePort,
  webClient,
  routing,
  ui,
  mobilePackage,
] = await Promise.all([
  readFile(path.join(mobileRoot, 'android/settings.gradle'), 'utf8'),
  readFile(path.join(mobileRoot, 'android/app/build.gradle'), 'utf8'),
  readFile(
    path.join(mobileRoot, 'android/app/src/main/java/com/puretavern/app/MainActivity.java'),
    'utf8',
  ),
  readFile(path.join(localServerRoot, 'build.gradle'), 'utf8'),
  readFile(path.join(localServerRoot, 'src/main/AndroidManifest.xml'), 'utf8'),
  readFile(path.join(mobileRoot, 'android/app/src/main/AndroidManifest.xml'), 'utf8'),
  readFile(path.join(mobileRoot, 'capacitor.config.ts'), 'utf8'),
  readFile(
    path.join(
      localServerRoot,
      'src/main/java/com/puretavern/localserver/PureTavernLocalServerPlugin.java',
    ),
    'utf8',
  ),
  readFile(
    path.join(localServerRoot, 'src/main/java/com/puretavern/localserver/LocalProxyEngine.java'),
    'utf8',
  ),
  readFile(bridgeSourcePath, 'utf8'),
  readFile(path.join(mobileRoot, 'scripts/install-android-local-backend-bridge.mjs'), 'utf8'),
  readFile(path.join(webGenerationRoot, 'ports/local-backend-bridge.ts'), 'utf8'),
  readFile(path.join(webGenerationRoot, 'infrastructure/local-backend-client.ts'), 'utf8'),
  readFile(path.join(webGenerationRoot, 'infrastructure/routing-fetch-client.ts'), 'utf8'),
  readFile(path.join(webGenerationRoot, 'runtime/generation-transport-ui.ts'), 'utf8'),
  readFile(path.join(mobileRoot, 'package.json'), 'utf8'),
]);

assert.match(settings, /include ':local-server'/u);
assert.match(appBuild, /implementation project\(':local-server'\)/u);
assert.match(activity, /registerPlugin\(PureTavernLocalServerPlugin\.class\)/u);
assert.match(libraryBuild, /com\.android\.library/u);
assert.match(libraryBuild, /implementation project\(':capacitor-android'\)/u);
assert.match(libraryBuild, /testImplementation "junit:junit:\$junitVersion"/u);
assert.doesNotMatch(libraryBuild, /okhttp|ktor|nanohttp|retrofit/u);
assert.match(manifest, /android:usesCleartextTraffic="true"/u);
assert.match(appManifest, /android:usesCleartextTraffic="true"/u);
assert.match(capacitorConfig, /android:\s*\{[\s\S]*?allowMixedContent:\s*true,?[\s\S]*?\}/u);
assert.match(capacitorConfig, /server:\s*\{[\s\S]*?cleartext:\s*true,?[\s\S]*?\}/u);

assert.match(plugin, /@CapacitorPlugin\(name = "PureTavernLocalServer"\)/u);
assert.match(plugin, /void startRequest\(PluginCall call\)/u);
assert.match(plugin, /void cancelRequest\(PluginCall call\)/u);
assert.match(plugin, /pureTavernLocalServerResponse/u);
assert.match(plugin, /Executors\.newFixedThreadPool\(WORKER_COUNT/u);
assert.match(plugin, /Base64\.NO_WRAP/u);
assert.match(plugin, /handleOnDestroy\(\)/u);

assert.match(engine, /HttpURLConnection/u);
assert.match(engine, /CHUNK_SIZE = 32 \* 1024/u);
assert.match(engine, /MAX_REDIRECTS = 10/u);
assert.match(engine, /setInstanceFollowRedirects\(false\)/u);
assert.match(engine, /CROSS_ORIGIN_SENSITIVE_HEADERS/u);
assert.match(engine, /"authorization"/u);
assert.match(engine, /"cookie"/u);
assert.match(engine, /"set-cookie"/u);
assert.match(engine, /startsWith\("access-control-"\)/u);
assert.doesNotMatch(plugin + engine, /android\.util\.Log|System\.out|printStackTrace/u);

assert.match(androidBridge, /globalThis\.Capacitor/u);
assert.match(androidBridge, /PureTavernLocalServer/u);
assert.match(androidBridge, /__PURE_TAVERN_LOCAL_BACKEND__/u);
assert.match(androidBridge, /protocol: 'pure-tavern-local-backend'/u);
assert.match(androidBridge, /plugin\.cancelRequest\(\{ requestId \}\)/u);
assert.match(androidBridge, /plugin\.addListener\(RESPONSE_EVENT, listener\)/u);
assert.match(installer, /data-pure-tavern-platform-bridge/u);
assert.match(installer, /local-backend-bridge\.js/u);
assert.match(mobilePackage, /install-android-local-backend-bridge\.mjs/u);

assert.match(webBridgePort, /__PURE_TAVERN_LOCAL_BACKEND__/u);
assert.match(webClient, /createFinalProviderRequest/u);
assert.match(webClient, /new ReadableStream<Uint8Array>/u);
assert.match(webClient, /#bridge\.cancelRequest\(requestId\)/u);
assert.doesNotMatch(webBridgePort + webClient, /Capacitor|Tauri|AndroidLocal|Desktop/u);
assert.match(routing, /case 'local':[\s\S]*#local\.send/u);
assert.match(ui, /isLocalBackendBridgeAvailable/u);
assert.doesNotMatch(ui, /Capacitor|__TAURI|__PURE_TAVERN_PLATFORM__/u);

await verifyAndroidBridgeRuntime(androidBridge);
await verifyInstallerFixture(androidBridge);

console.log(
  'PureTavern Android local backend, shell-only bridge injection, and platform-neutral Web contracts verified.',
);

async function verifyAndroidBridgeRuntime(source) {
  const calls = [];
  let eventListener = null;
  const context = createContext({
    Capacitor: {
      getPlatform: () => 'android',
      Plugins: {
        PureTavernLocalServer: {
          async startRequest(options) {
            calls.push(['start', options]);
            return { requestId: options.requestId };
          },
          async cancelRequest(options) {
            calls.push(['cancel', options]);
          },
          async addListener(event, listener) {
            calls.push(['listen', event]);
            eventListener = listener;
            return { async remove() {} };
          },
        },
      },
    },
  });
  runInContext(source, context, { filename: 'android-local-backend-bridge.js' });
  const bridge = context.__PURE_TAVERN_LOCAL_BACKEND__;
  assert.equal(bridge.protocol, 'pure-tavern-local-backend');
  assert.equal(bridge.protocolVersion, 1);
  await bridge.startRequest({ requestId: 'request-1', method: 'GET' });
  await bridge.cancelRequest('request-1');
  let received = null;
  await bridge.listen((event) => {
    received = event;
  });
  eventListener({ requestId: 'request-1', type: 'complete' });

  assert.equal(calls[0][0], 'start');
  assert.equal(calls[0][1].requestId, 'request-1');
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[1][0], 'cancel');
  assert.equal(calls[1][1].requestId, 'request-1');
  assert.equal(calls[2][0], 'listen');
  assert.equal(calls[2][1], 'pureTavernLocalServerResponse');
  assert.equal(received.requestId, 'request-1');
  assert.equal(received.type, 'complete');
}

async function verifyInstallerFixture(expectedBridge) {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'pure-tavern-android-bridge-'));
  const publicRoot = path.join(fixtureRoot, 'public');
  const fixtureSource = path.join(fixtureRoot, 'local-backend-bridge.js');
  try {
    await mkdir(path.join(publicRoot, '__pure_tavern'), { recursive: true });
    await writeFile(
      path.join(publicRoot, 'index.html'),
      '<html><head><script type="module" src="/__pure_tavern/legacy-hook.js" data-pure-tavern-hook="bootstrap"></script></head></html>',
      'utf8',
    );
    await writeFile(fixtureSource, expectedBridge, 'utf8');

    const first = await installAndroidLocalBackendBridge({ publicRoot, sourcePath: fixtureSource });
    const second = await installAndroidLocalBackendBridge({
      publicRoot,
      sourcePath: fixtureSource,
    });
    const installedIndex = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
    const installedBridge = await readFile(
      path.join(publicRoot, '__pure_tavern/local-backend-bridge.js'),
      'utf8',
    );

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(installedIndex.split('data-pure-tavern-platform-bridge="android"').length - 1, 1);
    assert.ok(
      installedIndex.indexOf('data-pure-tavern-platform-bridge="android"') <
        installedIndex.indexOf('data-pure-tavern-hook="bootstrap"'),
    );
    assert.equal(installedBridge, expectedBridge);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}
