import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultPublicRoot = path.join(mobileRoot, 'android/app/src/main/assets/public');
const defaultSourcePath = path.join(mobileRoot, 'android/local-server/web/local-backend-bridge.js');
const HOOK_PATTERN =
  /<script\b[^>]*\bdata-pure-tavern-hook=["']bootstrap["'][^>]*>\s*<\/script>/giu;
const BRIDGE_MARKER = 'data-pure-tavern-platform-bridge="android"';
const BRIDGE_TAG = `    <script src="/__pure_tavern/local-backend-bridge.js" ${BRIDGE_MARKER}></script>`;

export async function installAndroidLocalBackendBridge({
  publicRoot = defaultPublicRoot,
  sourcePath = defaultSourcePath,
} = {}) {
  const indexPath = path.join(publicRoot, 'index.html');
  const targetPath = path.join(publicRoot, '__pure_tavern/local-backend-bridge.js');
  const index = await readFile(indexPath, 'utf8');
  const markerCount = index.split(BRIDGE_MARKER).length - 1;
  if (markerCount > 1) {
    throw new Error('Android local backend bridge is injected more than once.');
  }

  let nextIndex = index;
  if (markerCount === 0) {
    const hooks = index.match(HOOK_PATTERN) ?? [];
    if (hooks.length !== 1) {
      throw new Error(`Expected exactly one PureTavern Legacy Hook, found ${hooks.length}.`);
    }
    nextIndex = index.replace(HOOK_PATTERN, `${BRIDGE_TAG}\n$&`);
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
  if (nextIndex !== index) await writeFile(indexPath, nextIndex, 'utf8');
  return { indexPath, targetPath, changed: nextIndex !== index };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const result = await installAndroidLocalBackendBridge();
  console.log(
    result.changed
      ? 'Installed PureTavern Android local backend bridge.'
      : 'PureTavern Android local backend bridge is already installed.',
  );
}
