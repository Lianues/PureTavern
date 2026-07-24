import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkLegacyContract } from './legacy-contracts.mjs';
import { generateHookedIndex } from './legacy-index-generator.mjs';
import { prepareLegacyRuntime } from './prepare-legacy-runtime.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacyRoot = path.join(packageRoot, 'legacy');
const targetPublicRoot = path.join(legacyRoot, 'upstream', 'public');
const targetDefaultRoot = path.join(legacyRoot, 'upstream', 'default');
const manifestPath = path.join(legacyRoot, 'legacy-files.sha256');
const metadataPath = path.join(legacyRoot, 'upstream.json');
const reportsRoot = path.join(legacyRoot, 'reports');

function parseArguments(args) {
  const result = { check: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--check') {
      result.check = true;
      continue;
    }
    if (argument === '--source' || argument === '--version') {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      result[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!result.source)
    throw new Error(
      'Usage: sync-legacy.mjs --source <repo-or-public-dir> [--version x.y.z] [--check]',
    );
  return result;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveSource(sourceArgument) {
  const candidate = path.resolve(sourceArgument);
  const nestedPublic = path.join(candidate, 'public');
  const publicRoot = (await exists(nestedPublic)) ? nestedPublic : candidate;
  if (!(await exists(path.join(publicRoot, 'index.html')))) {
    throw new Error(`Source does not contain public/index.html or index.html: ${candidate}`);
  }

  const repositoryRoot = publicRoot === nestedPublic ? candidate : path.dirname(publicRoot);
  const packagePath = path.join(repositoryRoot, 'package.json');
  const licensePath = path.join(repositoryRoot, 'LICENSE');
  const defaultContentRoot = path.join(repositoryRoot, 'default', 'content');
  const defaultSettingsPath = path.join(defaultContentRoot, 'settings.json');
  return {
    repositoryRoot,
    publicRoot,
    packagePath,
    licensePath,
    defaultContentRoot,
    defaultSettingsPath,
    defaultAvatarPath: path.join(defaultContentRoot, 'user-default.png'),
    defaultBackgroundsPath: path.join(defaultContentRoot, 'backgrounds'),
    indexPath: path.join(publicRoot, 'index.html'),
    libraryEntryPath: path.join(publicRoot, 'lib.js'),
  };
}

async function sha256(filePath) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

async function listFiles(root, prefix = '') {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolutePath, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

async function hashTree(root) {
  if (!(await exists(root))) return new Map();
  const files = await listFiles(root);
  const hashes = new Map();
  for (const relativePath of files) {
    if (relativePath === 'UPSTREAM_LICENSE' || relativePath === 'UPSTREAM_SOURCE.md') continue;
    hashes.set(relativePath, await sha256(path.join(root, ...relativePath.split('/'))));
  }
  return hashes;
}

function compareTrees(previous, next) {
  const added = [...next.keys()].filter((file) => !previous.has(file));
  const removed = [...previous.keys()].filter((file) => !next.has(file));
  const changed = [...next.keys()].filter(
    (file) => previous.has(file) && previous.get(file) !== next.get(file),
  );
  return { added, removed, changed };
}

function extractSignals(publicRoot, differences) {
  return {
    indexChanged: differences.changed.includes('index.html'),
    changedScripts: differences.changed.filter((file) => file.endsWith('.js')),
    addedScripts: differences.added.filter((file) => file.endsWith('.js')),
    addedExtensions: [
      ...new Set(
        differences.added
          .filter((file) => file.startsWith('scripts/extensions/'))
          .map((file) => file.split('/').slice(0, 3).join('/')),
      ),
    ],
    source: publicRoot,
  };
}

const options = parseArguments(process.argv.slice(2));
const source = await resolveSource(options.source);
const packageJson = (await exists(source.packagePath))
  ? JSON.parse(await readFile(source.packagePath, 'utf8'))
  : {};
const version = options.version ?? packageJson.version ?? 'unknown';
if (!(await exists(source.licensePath))) {
  throw new Error(`Upstream LICENSE was not found: ${source.licensePath}`);
}
if (!(await exists(source.defaultSettingsPath))) {
  throw new Error(`Upstream default settings were not found: ${source.defaultSettingsPath}`);
}

const requiredRuntimeAssets = [
  source.libraryEntryPath,
  source.defaultAvatarPath,
  source.defaultBackgroundsPath,
];
for (const requiredPath of requiredRuntimeAssets) {
  if (!(await exists(requiredPath))) {
    throw new Error(`Required Legacy runtime asset was not found: ${requiredPath}`);
  }
}

// Fail before replacing the pristine snapshot if an upstream HTML change breaks Hook injection.
generateHookedIndex(await readFile(source.indexPath, 'utf8'), 'sync-validation');

const previousHashes = await hashTree(targetPublicRoot);
const nextHashes = await hashTree(source.publicRoot);
const differences = compareTrees(previousHashes, nextHashes);
const report = {
  mode: options.check ? 'check' : 'sync',
  version,
  sourceRoot: source.repositoryRoot,
  generatedAt: new Date().toISOString(),
  previousFileCount: previousHashes.size,
  nextFileCount: nextHashes.size,
  ...differences,
  signals: {
    ...extractSignals(source.publicRoot, differences),
    hookAnchorCompatible: true,
    requiredRuntimeAssetsPresent: true,
  },
};

if (options.check) {
  const contractReport = await checkLegacyContract({ source: source.publicRoot, version });
  report.contracts = contractReport;
  console.log(JSON.stringify(report, null, 2));
  process.exit(contractReport.ok ? 0 : 1);
}

await rm(targetPublicRoot, { recursive: true, force: true });
await mkdir(path.dirname(targetPublicRoot), { recursive: true });
await cp(source.publicRoot, targetPublicRoot, { recursive: true, force: true });
await cp(source.licensePath, path.join(targetPublicRoot, 'UPSTREAM_LICENSE'), { force: true });
await rm(targetDefaultRoot, { recursive: true, force: true });
await mkdir(targetDefaultRoot, { recursive: true });
await cp(source.defaultContentRoot, path.join(targetDefaultRoot, 'content'), {
  recursive: true,
  force: true,
});
await writeFile(
  path.join(targetPublicRoot, 'UPSTREAM_SOURCE.md'),
  `# Upstream source\n\n- Project: SillyTavern\n- Version: ${version}\n- Repository: https://github.com/SillyTavern/SillyTavern\n- Synced from: \`${source.repositoryRoot}\`\n- License: see \`UPSTREAM_LICENSE\`\n\nDo not edit files in this directory. Use \`pnpm legacy:sync\` to replace the snapshot.\n`,
  'utf8',
);

const manifestLines = [...nextHashes.entries()].map(([file, hash]) => `${hash}  ${file}`);
await mkdir(legacyRoot, { recursive: true });
await writeFile(manifestPath, `${manifestLines.join('\n')}\n`, 'utf8');
await writeFile(
  metadataPath,
  `${JSON.stringify(
    {
      project: 'SillyTavern',
      version,
      upstreamRepository: 'https://github.com/SillyTavern/SillyTavern',
      sourceRoot: source.repositoryRoot,
      syncedAt: report.generatedAt,
      fileCount: nextHashes.size,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

await mkdir(reportsRoot, { recursive: true });
const reportName = `${report.generatedAt.replaceAll(':', '-').replaceAll('.', '-')}-${version}.json`;
await writeFile(path.join(reportsRoot, reportName), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(
  path.join(reportsRoot, 'latest.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);
await prepareLegacyRuntime();
console.log(JSON.stringify(report, null, 2));
