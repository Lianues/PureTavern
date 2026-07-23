import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacyRoot = path.join(packageRoot, 'public', 'legacy');
const manifestPath = path.join(packageRoot, 'legacy-files.sha256');
const reportPath = path.join(packageRoot, 'legacy-verification-report.json');
const provenanceFiles = new Set(['UPSTREAM_LICENSE', 'UPSTREAM_SOURCE.md']);

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

const manifestText = await readFile(manifestPath, 'utf8');
const expected = new Map();
for (const line of manifestText.split(/\r?\n/u)) {
  if (!line) continue;
  const match = /^([a-f\d]{64}) {2}(.+)$/u.exec(line);
  if (!match) throw new Error(`Invalid manifest line: ${line}`);
  expected.set(match[2], match[1]);
}

const missing = [];
const changed = [];
for (const [relativePath, expectedHash] of expected) {
  const absolutePath = path.join(legacyRoot, ...relativePath.split('/'));
  try {
    const actualHash = await sha256(absolutePath);
    if (actualHash !== expectedHash) {
      changed.push({ path: relativePath, expected: expectedHash, actual: actualHash });
    }
  } catch (error) {
    missing.push({ path: relativePath, error: String(error) });
  }
}

const actualFiles = (await listFiles(legacyRoot)).filter((file) => !provenanceFiles.has(file));
const extra = actualFiles.filter((file) => !expected.has(file)).sort();
const report = {
  verifiedAt: new Date().toISOString(),
  expectedFiles: expected.size,
  actualUpstreamFiles: actualFiles.length,
  missing,
  changed,
  extra,
  ok: missing.length === 0 && changed.length === 0 && extra.length === 0,
};

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
