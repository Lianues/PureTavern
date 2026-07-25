import { chmod, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TOOL_NAMES = Object.freeze({
  hvigor: new Set(['hmos-lite', 'hvigorw', 'hvigorw.js', 'hvigorw.bat']),
  ohpm: new Set(['ohpm', 'ohpm.js', 'ohpm.bat']),
});

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
