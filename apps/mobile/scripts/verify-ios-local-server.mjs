import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import path from 'node:path';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(mobileRoot, '../..');
const iosAppRoot = path.join(mobileRoot, 'ios/App/App');
const generationRoot = path.join(workspaceRoot, 'apps/web/src/features/generation');

const [project, info, viewController, plugin, bridge, webBridgePort, webClient] = await Promise.all(
  [
    readFile(path.join(mobileRoot, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8'),
    readFile(path.join(iosAppRoot, 'Info.plist'), 'utf8'),
    readFile(path.join(iosAppRoot, 'PureTavernBridgeViewController.swift'), 'utf8'),
    readFile(path.join(iosAppRoot, 'PureTavernLocalServerPlugin.swift'), 'utf8'),
    readFile(path.join(iosAppRoot, 'PureTavernLocalBackendBridge.js'), 'utf8'),
    readFile(path.join(generationRoot, 'ports/local-backend-bridge.ts'), 'utf8'),
    readFile(path.join(generationRoot, 'infrastructure/local-backend-client.ts'), 'utf8'),
  ],
);

assert.match(project, /PureTavernLocalServerPlugin\.swift in Sources/u);
assert.match(project, /PureTavernLocalBackendBridge\.js in Resources/u);
assert.equal((project.match(/PureTavernLocalServerPlugin\.swift in Sources/gu) ?? []).length, 2);
assert.equal((project.match(/PureTavernLocalBackendBridge\.js in Resources/gu) ?? []).length, 2);
assert.match(viewController, /bridge\?\.registerPluginInstance\(localServerPlugin\)/u);
assert.match(
  viewController,
  /addUserScript\(named: "PureTavernLocalBackendBridge", describedAs: "local backend bridge"\)/u,
);
assert.match(viewController, /localServerPlugin\?\.shutdown\(\)/u);

assert.match(plugin, /CAPPlugin, CAPBridgedPlugin, URLSessionDataDelegate/u);
assert.match(plugin, /URLSessionConfiguration\.ephemeral/u);
assert.match(plugin, /maximumActiveRequests = 4/u);
assert.match(plugin, /chunkSize = 32 \* 1024/u);
assert.match(plugin, /maximumRedirects = 10/u);
assert.match(plugin, /willPerformHTTPRedirection/u);
assert.match(plugin, /sensitiveRedirectHeaders/u);
assert.match(plugin, /"authorization"/u);
assert.match(plugin, /"cookie"/u);
assert.match(plugin, /"set-cookie"/u);
assert.match(plugin, /hasPrefix\("access-control-"\)/u);
assert.match(plugin, /base64EncodedString\(\)/u);
assert.match(plugin, /task\?\.cancel\(\)/u);
assert.match(plugin, /invalidateAndCancel\(\)/u);
assert.doesNotMatch(plugin, /Alamofire|AFNetworking|print\(|NSLog/u);
assert.doesNotMatch(info, /NSAllowsArbitraryLoads/u);

assert.match(bridge, /capacitor\.getPlatform\?\.call\(capacitor\) !== 'ios'/u);
assert.match(bridge, /PureTavernLocalServer/u);
assert.match(bridge, /protocol: 'pure-tavern-local-backend'/u);
assert.match(bridge, /plugin\.cancelRequest\(\{ requestId \}\)/u);
assert.match(bridge, /plugin\.addListener\(RESPONSE_EVENT, listener\)/u);
assert.match(webBridgePort, /__PURE_TAVERN_LOCAL_BACKEND__/u);
assert.doesNotMatch(webBridgePort + webClient, /PureTavernLocalServer|URLSession|Capacitor/u);

await verifyBridgeRuntime(bridge);
verifyBridgeStaysIOSOnly(bridge);

console.log('PureTavern iOS URLSession local backend and shell-only bridge contracts verified.');

async function verifyBridgeRuntime(source) {
  const calls = [];
  let eventListener = null;
  const context = createContext({
    Capacitor: {
      getPlatform: () => 'ios',
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
  runInContext(source, context, { filename: 'ios-local-backend-bridge.js' });
  const localBridge = context.__PURE_TAVERN_LOCAL_BACKEND__;
  assert.equal(localBridge.protocol, 'pure-tavern-local-backend');
  assert.equal(localBridge.protocolVersion, 1);

  await localBridge.startRequest({ requestId: 'request-1', method: 'POST' });
  await localBridge.cancelRequest('request-1');
  let received = null;
  await localBridge.listen((event) => {
    received = event;
  });
  eventListener({ requestId: 'request-1', type: 'complete' });

  assert.equal(calls[0][0], 'start');
  assert.equal(calls[0][1].requestId, 'request-1');
  assert.equal(calls[1][0], 'cancel');
  assert.equal(calls[1][1].requestId, 'request-1');
  assert.equal(calls[2][0], 'listen');
  assert.equal(calls[2][1], 'pureTavernLocalServerResponse');
  assert.equal(received.requestId, 'request-1');
  assert.equal(received.type, 'complete');
}

function verifyBridgeStaysIOSOnly(source) {
  const context = createContext({
    Capacitor: {
      getPlatform: () => 'android',
      Plugins: {
        PureTavernLocalServer: {
          startRequest() {},
          cancelRequest() {},
          addListener() {},
        },
      },
    },
  });
  runInContext(source, context, { filename: 'ios-local-backend-bridge.js' });
  assert.equal(context.__PURE_TAVERN_LOCAL_BACKEND__, undefined);
}
