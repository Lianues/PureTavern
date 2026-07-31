import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webGenerationRoot = path.resolve(mobileRoot, '../web/src/features/generation');
const localServerRoot = path.join(mobileRoot, 'android/local-server');

const [settings, appBuild, activity, libraryBuild, manifest, plugin, engine, client, routing, ui] =
  await Promise.all([
    readFile(path.join(mobileRoot, 'android/settings.gradle'), 'utf8'),
    readFile(path.join(mobileRoot, 'android/app/build.gradle'), 'utf8'),
    readFile(
      path.join(mobileRoot, 'android/app/src/main/java/com/puretavern/app/MainActivity.java'),
      'utf8',
    ),
    readFile(path.join(localServerRoot, 'build.gradle'), 'utf8'),
    readFile(path.join(localServerRoot, 'src/main/AndroidManifest.xml'), 'utf8'),
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
    readFile(
      path.join(webGenerationRoot, 'infrastructure/android-local-backend-client.ts'),
      'utf8',
    ),
    readFile(path.join(webGenerationRoot, 'infrastructure/routing-fetch-client.ts'), 'utf8'),
    readFile(path.join(webGenerationRoot, 'runtime/generation-transport-ui.ts'), 'utf8'),
  ]);

assert.match(settings, /include ':local-server'/u);
assert.match(appBuild, /implementation project\(':local-server'\)/u);
assert.match(activity, /registerPlugin\(PureTavernLocalServerPlugin\.class\)/u);
assert.match(libraryBuild, /com\.android\.library/u);
assert.match(libraryBuild, /implementation project\(':capacitor-android'\)/u);
assert.match(libraryBuild, /testImplementation "junit:junit:\$junitVersion"/u);
assert.doesNotMatch(libraryBuild, /okhttp|ktor|nanohttp|retrofit/u);
assert.match(manifest, /android:usesCleartextTraffic="true"/u);

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

assert.match(client, /createFinalProviderRequest/u);
assert.match(client, /new ReadableStream<Uint8Array>/u);
assert.match(client, /cancelRequest\(\{ requestId \}\)/u);
assert.match(client, /headers\.set\(TRANSPORT_HEADER, 'local'\)/u);
assert.match(client, /isAndroidLocalBackendAvailable/u);
assert.match(routing, /case 'local':[\s\S]*#local\.send/u);
assert.match(ui, /nativeApp && isLocalBackendAvailable\(\)/u);
assert.match(ui, /if \(!isNativeApp\) return ''/u);

console.log(
  'PureTavern Android local backend module, native proxy, Web stream bridge, and platform UI contracts verified.',
);
