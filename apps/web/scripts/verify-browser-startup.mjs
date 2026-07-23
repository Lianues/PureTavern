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
  const runtimeExceptions = [];
  const consoleErrors = [];

  client.on('Network.requestWillBeSent', ({ request }) => requests.push(request.url));
  client.on('Network.responseReceived', ({ response }) =>
    responses.push({ url: response.url, status: response.status }),
  );
  client.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    runtimeExceptions.push({
      text: exceptionDetails.text,
      description: exceptionDetails.exception?.description ?? null,
      url: exceptionDetails.url ?? null,
      lineNumber: exceptionDetails.lineNumber ?? null,
      columnNumber: exceptionDetails.columnNumber ?? null,
    });
  });
  client.on('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type !== 'error' && type !== 'assert') return;
    consoleErrors.push({
      type,
      text: args
        .map((argument) => argument.value ?? argument.unserializableValue ?? argument.description)
        .filter(Boolean)
        .join(' '),
    });
  });

  await Promise.all([
    client.send('Network.enable'),
    client.send('Page.enable'),
    client.send('Runtime.enable'),
  ]);
  await client.send('Page.navigate', { url: appUrl });

  const snapshotExpression = `(() => {
    const preloader = document.getElementById('preloader');
    const preloaderStyle = preloader ? getComputedStyle(preloader) : null;
    const diagnostics = globalThis.__PURE_TAVERN__?.diagnostics;
    const describe = (selector) => {
      const element = document.querySelector(selector);
      return element
        ? { exists: true, className: element.className, display: getComputedStyle(element).display }
        : { exists: false, className: null, display: null };
    };

    return {
      documentReadyState: document.readyState,
      title: document.title,
      hookInstalled: document.documentElement.dataset.pureTavernHook ?? null,
      databaseState: document.documentElement.dataset.databaseState ?? null,
      upstreamVersion: globalThis.__PURE_TAVERN__?.upstreamVersion ?? null,
      jqueryPresent: typeof globalThis.jQuery === 'function',
      preloader: preloader
        ? {
            exists: true,
            display: preloaderStyle.display,
            visibility: preloaderStyle.visibility,
            opacity: preloaderStyle.opacity,
          }
        : { exists: false, display: null, visibility: null, opacity: null },
      styleSheetHrefs: Array.from(document.styleSheets, (sheet) => sheet.href).filter(Boolean),
      scriptSources: Array.from(document.scripts, (script) => script.src).filter(Boolean),
      diagnostics: diagnostics
        ? {
            requests: diagnostics.requests.map(({ method, pathname, handled }) => ({
              method,
              pathname,
              handled,
            })),
            unhandledEndpoints: [...diagnostics.unhandledEndpoints],
          }
        : null,
      leftDrawer: describe('#left-nav-panel'),
      rightDrawer: describe('#right-nav-panel'),
      worldInfoDrawer: describe('#WorldInfo'),
      sendTextarea: describe('#send_textarea'),
    };
  })()`;

  const deadline = Date.now() + 20_000;
  let snapshot;
  while (Date.now() < deadline) {
    const evaluation = await client.send('Runtime.evaluate', {
      expression: snapshotExpression,
      returnByValue: true,
    });
    snapshot = evaluation.result?.value;
    if (
      snapshot?.hookInstalled === 'installed' &&
      snapshot?.databaseState === 'ready' &&
      snapshot?.jqueryPresent === true &&
      (snapshot?.preloader?.exists === false || snapshot?.preloader?.display === 'none')
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const interactionEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const testDrawer = async (iconSelector, panelSelector) => {
        const icon = document.querySelector(iconSelector);
        const panel = document.querySelector(panelSelector);
        if (!icon || !panel) return { exists: false, opened: false, closedAgain: false };

        if (panel.classList.contains('openDrawer')) {
          icon.click();
          await delay(400);
        }
        const initialClasses = panel.className;
        icon.click();
        await delay(400);
        const openClasses = panel.className;
        const opened = panel.classList.contains('openDrawer') && !panel.classList.contains('closedDrawer');
        icon.click();
        await delay(400);
        const closedClasses = panel.className;
        const closedAgain =
          panel.classList.contains('closedDrawer') && !panel.classList.contains('openDrawer');

        return {
          exists: true,
          initialClasses,
          openClasses,
          closedClasses,
          opened,
          closedAgain,
        };
      };

      return {
        left: await testDrawer('#leftNavDrawerIcon', '#left-nav-panel'),
        right: await testDrawer('#rightNavDrawerIcon', '#right-nav-panel'),
        worldInfo: await testDrawer('#WIDrawerIcon', '#WorldInfo'),
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const interactions = interactionEvaluation.result?.value;

  // Allow animations, nested CSS imports, fonts, and images to finish so late failures are included.
  await new Promise((resolve) => setTimeout(resolve, 750));

  const appOrigin = new URL(appUrl).origin;
  const compatibilityNetworkRequests = requests.filter((requestUrl) => {
    const url = new URL(requestUrl);
    return (
      url.origin === appOrigin &&
      (url.pathname === '/csrf-token' ||
        url.pathname === '/version' ||
        url.pathname.startsWith('/api/'))
    );
  });
  const localScriptRequests = requests.filter((requestUrl) => {
    const url = new URL(requestUrl);
    return url.origin === appOrigin && url.pathname.endsWith('.js');
  });
  const failedLocalResponses = responses.filter(
    ({ url, status }) => new URL(url).origin === appOrigin && status >= 400,
  );

  const checks = {
    hookInstalled: snapshot?.hookInstalled === 'installed',
    databaseReady: snapshot?.databaseState === 'ready',
    upstreamMetadataLoaded:
      typeof snapshot?.upstreamVersion === 'string' && snapshot.upstreamVersion !== 'loading',
    documentComplete: snapshot?.documentReadyState === 'complete',
    legacyJQueryLoaded: snapshot?.jqueryPresent === true,
    legacyCssLoaded:
      snapshot?.styleSheetHrefs?.some((href) => href.endsWith('/style.css')) === true,
    legacyLibraryLoaded: localScriptRequests.some((url) => new URL(url).pathname === '/lib.js'),
    legacyMainScriptLoaded: localScriptRequests.some(
      (url) => new URL(url).pathname === '/script.js',
    ),
    preloaderRemovedByLegacyStartup:
      snapshot?.preloader?.exists === false || snapshot?.preloader?.display === 'none',
    bootstrapRequestsHandled:
      (snapshot?.diagnostics?.requests?.length ?? 0) > 0 &&
      snapshot?.diagnostics?.requests?.every((request) => request.handled === true),
    noUnhandledCompatibilityEndpoints: snapshot?.diagnostics?.unhandledEndpoints?.length === 0,
    noCompatibilityRequestsHitNetwork: compatibilityNetworkRequests.length === 0,
    leftDrawerInteractive:
      interactions?.left?.opened === true && interactions?.left?.closedAgain === true,
    rightDrawerInteractive:
      interactions?.right?.opened === true && interactions?.right?.closedAgain === true,
    worldInfoDrawerInteractive:
      interactions?.worldInfo?.opened === true && interactions?.worldInfo?.closedAgain === true,
    noFailedLocalResponses: failedLocalResponses.length === 0,
    noRuntimeExceptions: runtimeExceptions.length === 0,
    noConsoleErrors: consoleErrors.length === 0,
  };
  const report = {
    appUrl,
    browserPath,
    snapshot,
    interactions,
    requestCount: requests.length,
    localScriptRequestCount: localScriptRequests.length,
    compatibilityNetworkRequests,
    failedLocalResponses,
    runtimeExceptions,
    consoleErrors,
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
