import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import path from 'node:path';

const harmonyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(harmonyRoot, '../..');
const generationRoot = path.join(workspaceRoot, 'apps/web/src/features/generation');

const [proxy, page, bootstrap, syncScript, harmonyPackage, webBridgePort, webClient] =
  await Promise.all([
    readFile(path.join(harmonyRoot, 'entry/src/main/ets/local/LocalBackendProxy.ets'), 'utf8'),
    readFile(path.join(harmonyRoot, 'entry/src/main/ets/pages/Index.ets'), 'utf8'),
    readFile(path.join(harmonyRoot, 'runtime/harmony-bootstrap.js'), 'utf8'),
    readFile(path.join(harmonyRoot, 'scripts/sync-web-assets.mjs'), 'utf8'),
    readFile(path.join(harmonyRoot, 'oh-package.json5'), 'utf8'),
    readFile(path.join(generationRoot, 'ports/local-backend-bridge.ts'), 'utf8'),
    readFile(path.join(generationRoot, 'infrastructure/local-backend-client.ts'), 'utf8'),
  ]);

assert.match(proxy, /import \{ http \} from '@kit\.NetworkKit'/u);
assert.match(proxy, /import \{ util \} from '@kit\.ArkTS'/u);
assert.match(proxy, /requestInStream\(input\.url, options\)/u);
assert.match(proxy, /on\('headersReceive'/u);
assert.match(proxy, /on\('dataReceive'/u);
assert.match(proxy, /on\('dataEnd'/u);
assert.match(proxy, /Base64Helper/u);
assert.match(proxy, /CHUNK_SIZE: number = 32 \* 1024/u);
assert.match(proxy, /MAX_ACTIVE_REQUESTS: number = 4/u);
assert.match(proxy, /maxRedirects: 10/u);
assert.match(proxy, /value\.startsWith\('https:\/\/'\)[\s\S]*value\.startsWith\('http:\/\/'\)/u);
assert.match(proxy, /getLastJavascriptProxyCallingFrameUrl\(\)/u);
assert.match(proxy, /session\.request\.destroy\(\)/u);
assert.match(proxy, /dispose\(\): void/u);
assert.doesNotMatch(proxy, /axios|fetch\(|third[- ]party|console\./u);

assert.match(page, /new LocalBackendProxy\(this\.webController\)/u);
assert.match(page, /\.javaScriptProxy\(\{/u);
assert.match(page, /name: 'PureTavernHarmonyLocalServer'/u);
assert.match(page, /methodList: \['startRequest', 'cancelRequest', 'takeEvents'\]/u);
assert.match(page, /this\.localBackend\.dispose\(\)/u);
assert.match(page, /\.mixedMode\(MixedMode\.All\)/u);

assert.match(bootstrap, /__PURE_TAVERN_PLATFORM__ = 'harmony'/u);
assert.match(bootstrap, /PureTavernHarmonyLocalServer/u);
assert.match(bootstrap, /protocol: 'pure-tavern-local-backend'/u);
assert.match(bootstrap, /protocolVersion: 1/u);
assert.match(bootstrap, /native\.takeEvents\(\)/u);
assert.match(bootstrap, /hasActiveRequests \? 8 : 250/u);
assert.match(bootstrap, /'set-cookie'/u);
assert.match(bootstrap, /lowerName\.startsWith\('access-control-'\)/u);
assert.match(syncScript, /harmony-bootstrap\.js/u);
assert.match(syncScript, /replace\('<head>', `<head>/u);
assert.match(harmonyPackage, /dependencies:\s*\{\}/u);
assert.match(webBridgePort, /__PURE_TAVERN_LOCAL_BACKEND__/u);
assert.doesNotMatch(
  webBridgePort + webClient,
  /PureTavernHarmonyLocalServer|@kit\.NetworkKit|HarmonyLocal/u,
);

await verifyBridgeRuntime(bootstrap);
verifyBootstrapWithoutNativeProxy(bootstrap);

console.log(
  'PureTavern Harmony NetworkKit local backend, event pump, and shell-only bridge contracts verified.',
);

async function verifyBridgeRuntime(source) {
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  let nextEnvelope = JSON.stringify({
    events: [
      {
        requestId: 'request-1',
        type: 'headers',
        status: 200,
        statusText: '',
        headers: {
          'Content-Type': 'text/event-stream',
          'Set-Cookie': 'secret=1',
          'Access-Control-Allow-Origin': '*',
          Connection: 'x-private',
          'X-Private': 'drop-me',
          'X-Upstream': 'kept',
        },
      },
    ],
    active: false,
  });
  const context = createContext({
    PureTavernHarmonyLocalServer: {
      startRequest(payload) {
        calls.push(['start', JSON.parse(payload)]);
        return 'request-1';
      },
      cancelRequest(requestId) {
        calls.push(['cancel', requestId]);
      },
      takeEvents() {
        calls.push(['take']);
        const result = nextEnvelope;
        nextEnvelope = JSON.stringify({ events: [], active: false });
        return result;
      },
    },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  runInContext(source, context, { filename: 'harmony-bootstrap.js' });
  const bridge = context.__PURE_TAVERN_LOCAL_BACKEND__;
  assert.equal(context.__PURE_TAVERN_PLATFORM__, 'harmony');
  assert.equal(bridge.protocol, 'pure-tavern-local-backend');
  assert.equal(bridge.protocolVersion, 1);

  let received = null;
  const handle = await bridge.listen((event) => {
    received = event;
  });
  await bridge.startRequest({
    requestId: 'request-1',
    url: 'http://provider.example/v1/messages',
    method: 'POST',
    headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
    body: '{"stream":true}',
  });

  assert.equal(calls[0][0], 'start');
  assert.equal(calls[0][1].requestId, 'request-1');
  assert.equal(calls[0][1].headers[0].name, 'Authorization');
  assert.equal(calls[0][1].hasBody, true);
  const pending = [...timers.values()].find(({ delay }) => delay === 0);
  assert.ok(pending, 'The Harmony bridge did not schedule an immediate event drain.');
  timers.clear();
  pending.callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(received.requestId, 'request-1');
  assert.equal(received.type, 'headers');
  assert.equal(received.headers['Content-Type'], 'text/event-stream');
  assert.equal(received.headers['X-Upstream'], 'kept');
  assert.equal(received.headers['Set-Cookie'], undefined);
  assert.equal(received.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(received.headers['X-Private'], undefined);

  await bridge.cancelRequest('request-1');
  assert.deepEqual(calls.at(-1), ['cancel', 'request-1']);
  await handle.remove();
}

function verifyBootstrapWithoutNativeProxy(source) {
  const context = createContext({});
  runInContext(source, context, { filename: 'harmony-bootstrap.js' });
  assert.equal(context.__PURE_TAVERN_PLATFORM__, 'harmony');
  assert.equal(context.__PURE_TAVERN_LOCAL_BACKEND__, undefined);
}
