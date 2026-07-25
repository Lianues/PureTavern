import { chmod, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TOOL_NAMES = Object.freeze({
  hvigor: new Set(['hmos-lite', 'hvigorw', 'hvigorw.js', 'hvigorw.bat']),
  ohpm: new Set(['ohpm', 'ohpm.js', 'ohpm.bat']),
});

const TRANSCODER_SOURCE_SUFFIX = '/hvigor/hvigor-ohos-plugin/src/tasks/process-resource.js';
const EAGER_TRANSCODER_SETUP =
  'if(i.setExtensionPath(this.sdkInfo.getLibimageTranscoderShared()),o){';
const OPTIONAL_TRANSCODER_SETUP =
  'if(o){i.setExtensionPath(this.sdkInfo.getLibimageTranscoderShared());';

async function walk(root, depth = 0) {
  if (depth > 8) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target, depth + 1)));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function isAppleMetadata(name) {
  return (
    name === '.DS_Store' || name === '.AppleDouble' || name === '__MACOSX' || name.startsWith('._')
  );
}

async function removeAppleMetadata(root, depth = 0) {
  if (depth > 24) return 0;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (isAppleMetadata(entry.name)) {
      await rm(target, { recursive: true, force: true });
      removed += 1;
    } else if (entry.isDirectory()) {
      removed += await removeAppleMetadata(target, depth + 1);
    }
  }
  return removed;
}

export async function sanitizeHarmonyTools(searchRoots) {
  let removed = 0;
  for (const root of searchRoots) removed += await removeAppleMetadata(path.resolve(root));
  return removed;
}

export async function patchOptionalImageTranscoder(searchRoots) {
  const files = (await Promise.all(searchRoots.map((root) => walk(path.resolve(root))))).flat();
  const candidates = files.filter((filePath) =>
    filePath.replaceAll('\\', '/').endsWith(TRANSCODER_SOURCE_SUFFIX),
  );
  if (candidates.length === 0) {
    throw new Error(`Could not locate HarmonyOS process-resource.js under: ${searchRoots}`);
  }

  let patched = 0;
  for (const candidate of candidates) {
    const source = await readFile(candidate, 'utf8');
    if (source.includes(OPTIONAL_TRANSCODER_SETUP)) continue;
    if (!source.includes(EAGER_TRANSCODER_SETUP)) {
      throw new Error(`Unsupported HarmonyOS image transcoder setup in: ${candidate}`);
    }
    await writeFile(
      candidate,
      source.replace(EAGER_TRANSCODER_SETUP, OPTIONAL_TRANSCODER_SETUP),
      'utf8',
    );
    patched += 1;
  }
  return { files: candidates, patched };
}

function scoreCandidate(filePath, tool) {
  const normalized = filePath.replaceAll('\\', '/').toLowerCase();
  const name = path.basename(filePath).toLowerCase();
  let score = 0;
  if (normalized.includes('/command-line-tools/bin/')) score += 100;
  if (normalized.includes('/bin/')) score += 30;
  if (tool === 'hvigor' && name === 'hmos-lite') score += 20;
  if (name.endsWith('.bat') && process.platform !== 'win32') score -= 1000;
  score -= normalized.length / 1000;
  return score;
}

export async function discoverHarmonyTools(searchRoots) {
  const files = (await Promise.all(searchRoots.map((root) => walk(path.resolve(root))))).flat();
  const result = {};
  for (const tool of ['hvigor', 'ohpm']) {
    const candidates = files
      .filter((filePath) => TOOL_NAMES[tool].has(path.basename(filePath).toLowerCase()))
      .sort((left, right) => scoreCandidate(right, tool) - scoreCandidate(left, tool));
    if (!candidates[0])
      throw new Error(`Could not discover HarmonyOS ${tool} under: ${searchRoots}`);
    result[tool] = candidates[0];
    if (process.platform !== 'win32') await chmod(candidates[0], 0o755).catch(() => undefined);
  }
  return result;
}

export async function runHarmonyExecutable(executable, args, options = {}) {
  const extension = path.extname(executable).toLowerCase();
  let command = executable;
  let commandArgs = args;
  if (extension === '.js') {
    command = process.execPath;
    commandArgs = [executable, ...args];
  } else if (extension === '.bat') {
    command = process.env.ComSpec ?? 'cmd.exe';
    commandArgs = ['/d', '/s', '/c', `"${executable}" ${args.join(' ')}`];
  }

  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      if (signal) reject(new Error(`HarmonyOS tool terminated by ${signal}.`));
      else resolve(exitCode ?? 1);
    });
  });
  if (code !== 0) throw new Error(`HarmonyOS tool exited with code ${code}: ${executable}`);
}

export async function assertFile(pathname) {
  const info = await stat(pathname).catch(() => null);
  if (!info?.isFile()) throw new Error(`Expected file does not exist: ${pathname}`);
  return pathname;
}
