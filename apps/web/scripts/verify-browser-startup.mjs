import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const appUrl = process.env.PURE_TAVERN_URL ?? 'http://127.0.0.1:5173/';
const browserCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

async function findBrowser() {
  for (const candidate of browserCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next browser candidate.
    }
  }
  throw new Error('Chrome/Edge was not found. Set CHROME_PATH to run the browser startup check.');
}

async function getAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a debug port.');
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForDebugTarget(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the browser DevTools target.');
}

class DevToolsClient {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new DevToolsClient(socket);
  }

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }

      for (const listener of this.#listeners.get(message.method) ?? []) {
        listener(message.params);
      }
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? [];
    listeners.push(listener);
    this.#listeners.set(method, listeners);
  }

  close() {
    this.#socket.close();
  }
}

const browserPath = await findBrowser();
const debugPort = await getAvailablePort();
const profileDirectory = await mkdtemp(path.join(tmpdir(), 'pure-tavern-browser-'));
const browser = spawn(
  browserPath,
  [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDirectory}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let client;
try {
  const target = await waitForDebugTarget(debugPort);
  client = await DevToolsClient.connect(target.webSocketDebuggerUrl);
  const requests = [];
  const responses = [];

  client.on('Network.requestWillBeSent', ({ request }) => requests.push(request.url));
  client.on('Network.responseReceived', ({ response }) =>
    responses.push({ url: response.url, status: response.status }),
  );
  await Promise.all([
    client.send('Network.enable'),
    client.send('Page.enable'),
    client.send('Runtime.enable'),
  ]);
  await client.send('Page.navigate', { url: appUrl });

  const deadline = Date.now() + 15_000;
  let snapshot;
  while (Date.now() < deadline) {
    const evaluation = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const host = document.querySelector('.legacy-host');
        const frame = document.querySelector('.legacy-host__frame');
        const frameDocument = frame?.contentDocument;
        return {
          databaseState: document.documentElement.dataset.databaseState ?? null,
          legacyLoadState: host?.dataset.loadState ?? null,
          legacyScriptState: host?.dataset.legacyScriptState ?? null,
          sandbox: frame?.getAttribute('sandbox') ?? null,
          usesSrcdoc: frame?.hasAttribute('srcdoc') ?? false,
          baseHref: frameDocument?.querySelector('base')?.getAttribute('href') ?? null,
          scriptElementCount: frameDocument?.scripts.length ?? null,
          styleSheetHrefs: frameDocument
            ? Array.from(frameDocument.styleSheets, (sheet) => sheet.href).filter(Boolean)
            : [],
          legacyMode: frameDocument?.documentElement.dataset.pureTavernLegacyMode ?? null,
          preloaderDisplay: frameDocument?.getElementById('preloader')?.style.display ?? null,
          legacyJQueryPresent: Boolean(frame?.contentWindow && Reflect.has(frame.contentWindow, 'jQuery')),
        };
      })()`,
      returnByValue: true,
    });
    snapshot = evaluation.result?.value;
    if (snapshot?.databaseState === 'ready' && snapshot?.legacyLoadState === 'ready') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Allow nested CSS imports, fonts, and images to finish so late 404 responses are included.
  await new Promise((resolve) => setTimeout(resolve, 750));

  const appOrigin = new URL(appUrl).origin;
  const unexpectedApiRequests = requests.filter((requestUrl) => {
    const url = new URL(requestUrl);
    return url.pathname === '/csrf-token' || url.pathname.startsWith('/api/');
  });
  const legacyScriptRequests = requests.filter((requestUrl) => {
    const url = new URL(requestUrl);
    return (
      url.origin === appOrigin &&
      url.pathname.startsWith('/legacy/') &&
      url.pathname.endsWith('.js')
    );
  });
  const failedLocalResponses = responses.filter(
    ({ url, status }) => new URL(url).origin === appOrigin && status >= 400,
  );

  const checks = {
    databaseReady: snapshot?.databaseState === 'ready',
    legacyReady: snapshot?.legacyLoadState === 'ready',
    legacyScriptsRemoved: snapshot?.legacyScriptState === 'removed',
    iframeSandboxed: snapshot?.sandbox === 'allow-same-origin',
    legacySrcdocLoaded: snapshot?.usesSrcdoc === true,
    legacyBaseRewritten: snapshot?.baseHref === '/legacy/',
    legacyDocumentHasNoScripts: snapshot?.scriptElementCount === 0,
    legacyCssLoaded:
      snapshot?.styleSheetHrefs?.some((href) => href.endsWith('/legacy/style.css')) === true,
    legacyModeApplied: snapshot?.legacyMode === 'static-preview',
    preloaderHiddenExternally: snapshot?.preloaderDisplay === 'none',
    legacyJQueryAbsent: snapshot?.legacyJQueryPresent === false,
    noLegacyScriptRequests: legacyScriptRequests.length === 0,
    noLegacyApiRequests: unexpectedApiRequests.length === 0,
    noFailedLocalResponses: failedLocalResponses.length === 0,
  };
  const report = {
    appUrl,
    browserPath,
    snapshot,
    requestCount: requests.length,
    unexpectedApiRequests,
    legacyScriptRequests,
    failedLocalResponses,
    checks,
    ok: Object.values(checks).every(Boolean),
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  client?.close();
  browser.kill();
  await new Promise((resolve) => setTimeout(resolve, 250));
  await rm(profileDirectory, { recursive: true, force: true });
}
