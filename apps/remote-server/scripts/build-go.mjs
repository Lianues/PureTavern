import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const remoteServerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goRoot = path.join(remoteServerRoot, 'go');
const outputDirectory = path.join(goRoot, 'bin');
const packageJson = JSON.parse(await readFile(path.join(remoteServerRoot, 'package.json'), 'utf8'));
const version = String(packageJson.version);
const commitResult = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
  cwd: remoteServerRoot,
  encoding: 'utf8',
  windowsHide: true,
});
const commit = commitResult.status === 0 ? commitResult.stdout.trim() : 'local';
const extension = process.platform === 'win32' ? '.exe' : '';
const output = path.join(outputDirectory, `pure-tavern-remote-server${extension}`);

await mkdir(outputDirectory, { recursive: true });
const result = spawnSync(
  'go',
  [
    'build',
    '-trimpath',
    '-ldflags',
    `-s -w -X main.version=${version} -X main.commit=${commit || 'local'}`,
    '-o',
    output,
    '.',
  ],
  {
    cwd: goRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`Built ${path.relative(remoteServerRoot, output)} (${version}, ${commit || 'local'}).`);
