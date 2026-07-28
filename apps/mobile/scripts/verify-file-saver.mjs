import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [activity, plugin, manifest, styles, runtime] = await Promise.all([
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
  readFile(path.join(mobileRoot, 'android/app/src/main/res/values/styles.xml'), 'utf8'),
  readFile(path.join(mobileRoot, '../web/src/features/import-export/runtime/index.js'), 'utf8'),
]);

assert.match(activity, /registerPlugin\(PureTavernFileSaverPlugin\.class\)/u);
assert.match(activity, /WindowInsetsControllerCompat/u);
assert.match(activity, /WindowInsetsCompat\.Type\.systemBars\(\)/u);
assert.match(activity, /BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE/u);
assert.match(activity, /void onWindowFocusChanged\(boolean hasFocus\)/u);
assert.match(activity, /void onResume\(\)/u);
assert.match(activity, /LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES/u);
assert.doesNotMatch(activity, /WindowInsetsCompat\.Type\.displayCutout\(\)/u);
assert.doesNotMatch(activity, /setOnApplyWindowInsetsListener|view\.setPadding\(/u);
assert.equal(
  (styles.match(/<item name="android:windowFullscreen">true<\/item>/gu) ?? []).length,
  2,
);
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

console.log('PureTavern Android file saver and immersive fullscreen contracts verified.');
