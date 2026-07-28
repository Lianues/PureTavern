import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeSource = await readFile(
  path.join(mobileRoot, 'ios/App/App/PureTavernAssetBridge.js'),
  'utf8',
);
const separator = '\u001f';
const records = new Map();
const blobs = new Map();

const extensionPath = '/scripts/extensions/third-party/example/dist/index.mjs';
const extensionId = 'extension-asset-id';
records.set(['assets', 'path-aliases', extensionPath].join(separator), {
  value: { assetId: extensionId },
});
records.set(['assets', 'index', extensionId].join(separator), {
  value: { collection: 'library', mimeType: 'application/octet-stream' },
});
blobs.set(['assets', 'library', extensionId].join(separator), {
  data: new Blob(['export const iosBridge = true;'], { type: 'application/octet-stream' }),
  metadata: { legacyPath: extensionPath },
});
blobs.set(['characters', 'avatars', 'alice.png'].join(separator), {
  data: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
  metadata: { contentType: 'image/png' },
});

const database = {
  objectStoreNames: {
    contains(name) {
      return name === 'records' || name === 'blobs';
    },
  },
  transaction(storeName) {
    const transaction = {
      error: null,
      onabort: null,
      objectStore() {
        return {
          get(key) {
            const request = { error: null, result: undefined, onsuccess: null, onerror: null };
            queueMicrotask(() => {
              request.result = (storeName === 'records' ? records : blobs).get(key);
              request.onsuccess?.();
            });
            return request;
          },
        };
      },
    };
    return transaction;
  },
  close() {},
};

const indexedDB = {
  async databases() {
    return [{ name: 'pure-tavern-modular-dev', version: 10 }];
  },
  open() {
    const request = {
      result: database,
      error: null,
      transaction: null,
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      onblocked: null,
    };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  },
};

let now = Date.now();
class FakeDate extends Date {
  static now() {
    return now;
  }
}

const context = {
  Blob,
  URL,
  Uint8Array,
  String,
  Date: FakeDate,
  Map,
  Object,
  Number,
  console,
  indexedDB,
  queueMicrotask,
  setTimeout,
  clearTimeout,
  btoa(value) {
    return Buffer.from(value, 'binary').toString('base64');
  },
};
context.globalThis = context;
runInNewContext(bridgeSource, context, { filename: 'PureTavernAssetBridge.js' });
const bridge = context.__PURE_TAVERN_IOS_ASSET_BRIDGE__;
assert.ok(bridge, 'The iOS asset bridge was not installed.');

const extension = await bridge.openAsset(`capacitor://localhost${extensionPath}`);
assert.equal(extension.kind, 'asset');
assert.equal(extension.size, 30);
assert.equal(extension.contentType, '');
assert.equal(extension.marker, 'assets/extensions');
const extensionChunk = await bridge.readChunk(extension.token, 0, extension.size);
assert.equal(
  Buffer.from(extensionChunk, 'base64').toString('utf8'),
  'export const iosBridge = true;',
);
assert.equal(bridge.releaseAsset(extension.token), true);
await assert.rejects(
  () => bridge.readChunk(extension.token, 0, 1),
  /Unknown iOS asset bridge token/u,
);

const concurrentAssets = await Promise.all(
  Array.from({ length: 300 }, () => bridge.openAsset(`capacitor://localhost${extensionPath}`)),
);
assert.equal(
  Buffer.from(
    await bridge.readChunk(concurrentAssets[0].token, 0, concurrentAssets[0].size),
    'base64',
  ).toString('utf8'),
  'export const iosBridge = true;',
);
for (const asset of concurrentAssets) bridge.releaseAsset(asset.token);

const expiringAsset = await bridge.openAsset(`capacitor://localhost${extensionPath}`);
now += 5 * 60 * 1000;
await assert.rejects(
  () => bridge.readChunk(expiringAsset.token, 0, 1),
  /Expired iOS asset bridge token/u,
);

const avatar = await bridge.openAsset('capacitor://localhost/thumbnail?type=avatar&file=alice.png');
assert.equal(avatar.kind, 'asset');
assert.equal(avatar.contentType, 'image/png');
assert.equal(avatar.marker, 'characters/avatar');
assert.deepEqual(
  [...Buffer.from(await bridge.readChunk(avatar.token, 0, avatar.size), 'base64')],
  [0x89, 0x50, 0x4e, 0x47],
);
bridge.releaseAsset(avatar.token);

const missingAvatar = await bridge.openAsset(
  'capacitor://localhost/thumbnail?type=avatar&file=missing.png',
);
assert.deepEqual(
  { kind: missingAvatar.kind, path: missingAvatar.path },
  { kind: 'fallback', path: '/img/ai4.png' },
);
const missingBackground = await bridge.openAsset(
  'capacitor://localhost/thumbnail?type=bg&file=folder%2Fmissing.png',
);
assert.deepEqual(
  { kind: missingBackground.kind, path: missingBackground.path },
  { kind: 'fallback', path: '/backgrounds/folder/missing.png' },
);
const traversal = await bridge.openAsset(
  'capacitor://localhost/scripts/extensions/third-party/example/%2E%2E/secret.js',
);
assert.notEqual(traversal.kind, 'asset');

console.log('PureTavern iOS IndexedDB asset bridge behavior verified.');
