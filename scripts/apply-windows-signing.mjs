import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THUMBPRINT = /^[0-9A-Fa-f]{40}$/u;
const DEFAULT_TIMESTAMP_URL = 'http://timestamp.digicert.com';

export function windowsSigningConfig(thumbprint, timestampUrl = DEFAULT_TIMESTAMP_URL) {
  if (!THUMBPRINT.test(thumbprint)) {
    throw new Error(`Windows certificate thumbprint must be 40 hex characters: ${thumbprint}`);
  }
  return {
    certificateThumbprint: thumbprint.toUpperCase(),
    digestAlgorithm: 'sha256',
    timestampUrl,
  };
}

export async function applyWindowsSigning(root, thumbprint, timestampUrl) {
  const target = path.join(root, 'apps/desktop/src-tauri/tauri.conf.json');
  const config = JSON.parse(await readFile(target, 'utf8'));
  config.bundle ??= {};
  config.bundle.windows = {
    ...config.bundle.windows,
    ...windowsSigningConfig(thumbprint, timestampUrl),
  };
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return config.bundle.windows;
}

async function main() {
  const [thumbprint, timestampUrl] = process.argv.slice(2);
  if (!thumbprint) {
    throw new Error('Usage: node scripts/apply-windows-signing.mjs <thumbprint> [timestamp-url]');
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const applied = await applyWindowsSigning(
    root,
    thumbprint,
    timestampUrl || DEFAULT_TIMESTAMP_URL,
  );
  console.log(
    `Windows Authenticode signing enabled with thumbprint ${applied.certificateThumbprint}.`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) await main();
