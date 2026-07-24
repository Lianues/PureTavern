import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidRoot = path.join(mobileRoot, 'android');
const task = process.argv[2];

if (!task || !/^[A-Za-z][A-Za-z0-9:_-]*$/.test(task)) {
  throw new Error('A valid Gradle task is required.');
}

const env = { ...process.env };
if (!env.ANDROID_HOME && env.ANDROID_SDK_ROOT) {
  env.ANDROID_HOME = env.ANDROID_SDK_ROOT;
}
if (process.platform === 'win32' && !env.ANDROID_HOME) {
  const localSdk = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Android', 'Sdk') : '';
  if (localSdk && existsSync(localSdk)) {
    env.ANDROID_HOME = localSdk;
  }
}
env.ANDROID_SDK_ROOT ??= env.ANDROID_HOME;

const executable = process.platform === 'win32' ? (env.ComSpec ?? 'cmd.exe') : './gradlew';
const args = process.platform === 'win32' ? ['/d', '/s', '/c', `gradlew.bat ${task}`] : [task];
const child = spawn(executable, args, {
  cwd: androidRoot,
  env,
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`Gradle terminated by ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
