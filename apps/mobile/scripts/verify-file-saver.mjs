import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [activity, plugin, manifest, runtime] = await Promise.all([
  readFile(
    path.join(mobileRoot, 'android/app/src/main/java/com/puretavern/app/MainActivity.java'),
    'utf8',
  ),
  readFile(
    path.join(
      mobileRoot,
      'android/app/src/main/java/com/puretavern/app/PureTavernFileSaverPlugin.java',
    ),
    'utf8',
  ),
  readFile(path.join(mobileRoot, 'android/app/src/main/AndroidManifest.xml'), 'utf8'),
  readFile(path.join(mobileRoot, '../web/src/features/import-export/runtime/index.js'), 'utf8'),
]);

assert.match(activity, /registerPlugin\(PureTavernFileSaverPlugin\.class\)/u);
assert.match(plugin, /@CapacitorPlugin\(name = "PureTavernFileSaver"\)/u);
assert.match(plugin, /Intent\.ACTION_CREATE_DOCUMENT/u);
assert.match(plugin, /void beginSave\(/u);
assert.match(plugin, /void writeChunk\(/u);
assert.match(plugin, /void finishSave\(/u);
assert.match(plugin, /MAX_CHUNK_BYTES/u);
assert.doesNotMatch(
  manifest,
  /READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/u,
);
assert.match(runtime, /PureTavernFileSaver/u);
assert.match(runtime, /NATIVE_SAVE_CHUNK_SIZE/u);
assert.match(runtime, /Web 页面无法确认文件是否写入/u);

console.log('PureTavern Android system file saver contract verified.');
