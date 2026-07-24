import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { zipSync } from 'fflate';

import {
  CRITICAL_DOM_IDS,
  EXPECTED_RUNTIME_GLOBALS,
  EXTENSION_DOM_IDS,
} from './legacy-contracts.mjs';

const appUrl = process.env.PURE_TAVERN_URL ?? 'http://127.0.0.1:5173/';
const criticalDomAnchorIds = [...new Set([...CRITICAL_DOM_IDS, ...EXTENSION_DOM_IDS])];
const runtimeCriticalDomAnchorIds = criticalDomAnchorIds.filter((id) => id !== 'preloader');
const expectedRuntimeGlobals = EXPECTED_RUNTIME_GLOBALS;
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
  const server = createNetServer();
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

async function startMockChatCompletionProvider() {
  let extensionVersion = '1.0.0';
  let externalCharacterCard = null;
  const server = createHttpServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-api-key, anthropic-version, HTTP-Referer, X-Title, Accept-Language',
    );
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }

    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = (() => {
      try {
        return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch {
        return {};
      }
    })();
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = requestUrl.pathname;
    const sendJson = (value) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(value));
    };

    if (pathname === '/browser-extension-control') {
      extensionVersion = requestUrl.searchParams.get('version') || extensionVersion;
      sendJson({ version: extensionVersion });
      return;
    }
    if (pathname === '/browser-character-card-control' && request.method === 'POST') {
      externalCharacterCard = Buffer.concat(chunks);
      sendJson({ size: externalCharacterCard.byteLength });
      return;
    }
    if (pathname === '/attachments/browser/channel/14.png') {
      if (!externalCharacterCard) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('Content-Type', 'image/png');
      response.setHeader('Content-Length', String(externalCharacterCard.byteLength));
      response.end(externalCharacterCard);
      return;
    }
    if (pathname === '/browser-extension.zip') {
      const archive = createMockLegacyExtensionArchive(extensionVersion);
      response.setHeader('Content-Type', 'application/zip');
      response.setHeader('Content-Length', String(archive.byteLength));
      response.end(archive);
      return;
    }
    if (pathname.endsWith('/models')) {
      if (pathname.startsWith('/google/')) {
        sendJson({ models: [{ name: 'models/browser-google-model' }] });
      } else if (pathname.startsWith('/cohere/')) {
        sendJson({ models: [{ name: 'browser-cohere-model' }] });
      } else {
        sendJson({ data: [{ id: 'browser-provider-model' }] });
      }
      return;
    }
    if (pathname.endsWith('/chat/completions')) {
      if (body.stream === true) {
        response.setHeader('Content-Type', 'text/event-stream');
        response.write('data: {"choices":[{"index":0,"delta":{"content":"Browser "}}]}\n\n');
        response.write('data: {"choices":[{"index":0,"delta":{"content":"stream"}}]}\n\n');
        response.end('data: [DONE]\n\n');
      } else {
        sendJson({
          id: 'browser-completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Browser non-stream' } }],
        });
      }
      return;
    }
    if (pathname.endsWith('/anthropic/messages')) {
      sendJson({ content: [{ type: 'text', text: 'Browser Anthropic' }] });
      return;
    }
    if (pathname.includes('/google/') && pathname.includes(':generateContent')) {
      sendJson({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Browser Google' }] } }],
      });
      return;
    }
    if (pathname.endsWith('/cohere/v2/chat')) {
      sendJson({
        message: { role: 'assistant', content: [{ type: 'text', text: 'Browser Cohere' }] },
      });
      return;
    }
    sendJson({ error: { message: `Unhandled mock provider path: ${pathname}` } });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start mock provider.');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function createMockLegacyExtensionArchive(version) {
  const manifest = JSON.stringify({
    display_name: 'Browser CORS Extension',
    loading_order: 1,
    requires: [],
    optional: [],
    dependencies: [],
    js: 'dist/index.js',
    css: 'dist/index.css',
    author: 'Pure Tavern Browser Gate',
    version,
    minimum_client_version: '1.12.13',
    hooks: {
      install: 'onInstall',
      update: 'onUpdate',
      delete: 'onDelete',
      enable: 'onEnable',
      disable: 'onDisable',
    },
    future_manifest_field: { kept: true },
  });
  const script = `
const state = globalThis.__PURE_TAVERN_THIRD_PARTY__ ??= { loads: 0, hooks: [], version: null };
state.loads += 1;
state.version = ${JSON.stringify(version)};
export function onInstall() { state.hooks.push('install'); }
export function onUpdate() { state.hooks.push('update'); }
export function onDelete() { state.hooks.push('delete'); }
export function onEnable() { state.hooks.push('enable'); }
export function onDisable() { state.hooks.push('disable'); }
`;
  return Buffer.from(
    zipSync({
      'browser-extension/manifest.json': new TextEncoder().encode(manifest),
      'browser-extension/dist/index.js': new TextEncoder().encode(script),
      'browser-extension/dist/index.css': new TextEncoder().encode(
        '.browser-cors-extension-marker { --pure-tavern-extension: ready; }',
      ),
      'browser-extension/.gitignore': new TextEncoder().encode('dist-cache/'),
      'browser-extension/.github/workflows/build.yml': new TextEncoder().encode('name: build'),
      'browser-extension/.vscode/settings.json': new TextEncoder().encode('{}'),
    }),
  );
}

async function removeBrowserProfile(directory) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EBUSY' && error?.code !== 'EPERM') throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
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
const mockProvider = await startMockChatCompletionProvider();
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
  let pageLoadEvents = 0;

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
  client.on('Page.loadEventFired', () => {
    pageLoadEvents += 1;
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
    const criticalDomAnchorIds = ${JSON.stringify(runtimeCriticalDomAnchorIds)};
    const expectedRuntimeGlobals = ${JSON.stringify(expectedRuntimeGlobals)};
    const preloader = document.getElementById('preloader');
    const preloaderStyle = preloader ? getComputedStyle(preloader) : null;
    const diagnostics = globalThis.__PURE_TAVERN__?.diagnostics;
    const describe = (selector) => {
      const element = document.querySelector(selector);
      return element
        ? { exists: true, className: element.className, display: getComputedStyle(element).display }
        : { exists: false, className: null, display: null };
    };
    const describeById = (id) => {
      const element = document.getElementById(id);
      return element
        ? {
            exists: true,
            tagName: element.tagName.toLowerCase(),
            className: element.className,
            display: getComputedStyle(element).display,
          }
        : { exists: false, tagName: null, className: null, display: null };
    };
    const criticalDomAnchors = Object.fromEntries(
      criticalDomAnchorIds.map((id) => [id, describeById(id)]),
    );
    const runtimeGlobals = Object.fromEntries(
      expectedRuntimeGlobals.map((name) => [name, typeof globalThis[name] !== 'undefined']),
    );

    return {
      documentReadyState: document.readyState,
      title: document.title,
      hookInstalled: document.documentElement.dataset.pureTavernHook ?? null,
      databaseState: document.documentElement.dataset.databaseState ?? null,
      upstreamVersion: globalThis.__PURE_TAVERN__?.upstreamVersion ?? null,
      settingsStorage: globalThis.__PURE_TAVERN__?.features?.settings?.storage
        ? { ...globalThis.__PURE_TAVERN__.features.settings.storage }
        : null,
      fastUiMode: document.getElementById('fast_ui_mode')?.checked ?? null,
      jqueryPresent: typeof globalThis.jQuery === 'function',
      legacyLodashGlobal:
        typeof globalThis._ === 'function' && globalThis._ === globalThis.SillyTavern?.libs?.lodash,
      criticalDomAnchors,
      missingCriticalDomAnchors: Object.entries(criticalDomAnchors)
        .filter(([, anchor]) => !anchor.exists)
        .map(([id]) => id),
      runtimeGlobals: {
        ...runtimeGlobals,
        SillyTavernGetContext: typeof globalThis.SillyTavern?.getContext === 'function',
      },
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

  async function waitForApplicationSnapshot(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let currentSnapshot;
    while (Date.now() < deadline) {
      const evaluation = await client.send('Runtime.evaluate', {
        expression: snapshotExpression,
        returnByValue: true,
      });
      currentSnapshot = evaluation.result?.value;
      if (
        currentSnapshot?.hookInstalled === 'installed' &&
        currentSnapshot?.databaseState === 'ready' &&
        currentSnapshot?.jqueryPresent === true &&
        (currentSnapshot?.preloader?.exists === false ||
          currentSnapshot?.preloader?.display === 'none')
      ) {
        return currentSnapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return currentSnapshot;
  }

  let snapshot = await waitForApplicationSnapshot();

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

  const moduleContractEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const requiredExports = {
        '/lib.js': ['default', 'initLibraryShims'],
        '/script.js': ['eventSource', 'event_types', 'getRequestHeaders'],
        '/scripts/events.js': ['eventSource', 'event_types'],
        '/scripts/extensions.js': ['extension_settings', 'extensionNames', 'getContext', 'initExtensions'],
        '/scripts/st-context.js': ['getContext'],
        '/scripts/popup.js': ['POPUP_TYPE', 'Popup'],
      };
      const imports = {};
      const modules = {};

      for (const [modulePath, exports] of Object.entries(requiredExports)) {
        try {
          const module = await import(modulePath);
          modules[modulePath] = module;
          const availableExports = Object.keys(module).sort();
          const missingExports = exports.filter((name) => typeof module[name] === 'undefined');
          imports[modulePath] = {
            ok: missingExports.length === 0,
            exportCount: availableExports.length,
            missingExports,
          };
        } catch (error) {
          imports[modulePath] = {
            ok: false,
            exportCount: 0,
            missingExports: exports,
            error: String(error?.stack ?? error),
          };
        }
      }

      let eventSystem = { delivered: false, scriptEventSourceMatches: false, error: null };
      try {
        const eventsModule = modules['/scripts/events.js'];
        const scriptModule = modules['/script.js'];
        let deliveries = 0;
        const probeEvent = 'pure_tavern_contract_probe';
        const listener = (payload) => {
          if (payload === 'ok') deliveries += 1;
        };
        eventsModule.eventSource.on(probeEvent, listener);
        await eventsModule.eventSource.emit(probeEvent, 'ok');
        eventsModule.eventSource.removeListener(probeEvent, listener);
        eventSystem = {
          delivered: deliveries === 1,
          scriptEventSourceMatches: scriptModule.eventSource === eventsModule.eventSource,
          error: null,
        };
      } catch (error) {
        eventSystem = {
          delivered: false,
          scriptEventSourceMatches: false,
          error: String(error?.stack ?? error),
        };
      }

      const extensionsModule = modules['/scripts/extensions.js'];
      const extensionContext = extensionsModule
        ? {
            getContextFunction: typeof extensionsModule.getContext === 'function',
            extensionSettingsObject:
              extensionsModule.extension_settings &&
              typeof extensionsModule.extension_settings === 'object',
            disabledExtensionsArray: Array.isArray(
              extensionsModule.extension_settings?.disabledExtensions,
            ),
            extensionNamesArray: Array.isArray(extensionsModule.extensionNames),
          }
        : {
            getContextFunction: false,
            extensionSettingsObject: false,
            disabledExtensionsArray: false,
            extensionNamesArray: false,
          };
      extensionContext.ok =
        extensionContext.getContextFunction &&
        extensionContext.extensionSettingsObject &&
        extensionContext.disabledExtensionsArray &&
        extensionContext.extensionNamesArray;

      return {
        imports,
        allImportsOk: Object.values(imports).every((entry) => entry.ok),
        eventSystem,
        extensionContext,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const moduleContracts = moduleContractEvaluation.result?.value;

  const settingsPersistenceEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const checkbox = document.getElementById('fast_ui_mode');
      if (!(checkbox instanceof HTMLInputElement)) {
        return { available: false, error: '#fast_ui_mode is not an input element.' };
      }

      const readStoredSettings = () => new Promise((resolve, reject) => {
        const openRequest = indexedDB.open('pure-tavern-modular-dev');
        openRequest.onerror = () => reject(openRequest.error);
        openRequest.onsuccess = () => {
          const database = openRequest.result;
          const transaction = database.transaction('records', 'readonly');
          const key = ['settings', 'documents', 'current'].join('\\u001f');
          const getRequest = transaction.objectStore('records').get(key);
          getRequest.onerror = () => reject(getRequest.error);
          getRequest.onsuccess = () => {
            database.close();
            resolve(getRequest.result ?? null);
          };
        };
      });

      const initialValue = checkbox.checked;
      const targetValue = !initialValue;
      checkbox.click();
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      const record = await readStoredSettings();
      const storage = globalThis.__PURE_TAVERN__?.features?.settings?.storage;
      const saveRequestHandled = globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
        ({ method, pathname, handled }) =>
          method === 'POST' && pathname === '/api/settings/save' && handled,
      );

      return {
        available: true,
        initialValue,
        targetValue,
        valueAfterClick: checkbox.checked,
        savedValue: record?.value?.power_user?.fast_ui_mode ?? null,
        saveRequestHandled: Boolean(saveRequestHandled),
        storage: storage ? { ...storage } : null,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const settingsPersistence = settingsPersistenceEvaluation.result?.value;

  await client.send('Page.navigate', { url: appUrl });
  snapshot = await waitForApplicationSnapshot();
  if (settingsPersistence) {
    settingsPersistence.reloadedValue = snapshot?.fastUiMode ?? null;
  }

  const snapshotCreateEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const waitFor = async (read, timeoutMs = 5_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = read();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return null;
      };
      const routeHandled = (pathname) =>
        globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
          (request) => request.pathname === pathname && request.handled,
        ) ?? false;

      document.getElementById('account_button')?.click();
      const snapshotsButton = await waitFor(() =>
        document.querySelector('.popup[open] .userSettingsSnapshotsButton'),
      );
      snapshotsButton?.click();
      const makeButton = await waitFor(() =>
        [...document.querySelectorAll('.popup[open] .makeSnapshotButton')].at(-1),
      );
      makeButton?.click();
      const row = await waitFor(() => document.querySelector('.snapshotList .snapshot'));
      row?.querySelector('.inline-drawer-toggle')?.click();
      const content = await waitFor(() => {
        const textarea = row?.querySelector('.snapshotContent');
        return textarea?.value ? textarea : null;
      });
      let previewValue = null;
      try {
        previewValue = JSON.parse(content?.value ?? '{}')?.power_user?.fast_ui_mode ?? null;
      } catch {
        previewValue = null;
      }

      return {
        available: Boolean(snapshotsButton && makeButton && row),
        name: row?.querySelector('.snapshotName')?.textContent ?? null,
        previewValue,
        snapshotCount: document.querySelectorAll('.snapshotList .snapshot').length,
        routesHandled: {
          list: routeHandled('/api/settings/get-snapshots'),
          make: routeHandled('/api/settings/make-snapshot'),
          load: routeHandled('/api/settings/load-snapshot'),
        },
        storage: globalThis.__PURE_TAVERN__?.features?.settings?.snapshots
          ? { ...globalThis.__PURE_TAVERN__.features.settings.snapshots }
          : null,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const settingsSnapshotWorkflow = snapshotCreateEvaluation.result?.value;

  const changeAfterSnapshotEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const checkbox = document.getElementById('fast_ui_mode');
      if (!(checkbox instanceof HTMLInputElement)) return null;
      checkbox.click();
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      return checkbox.checked;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (settingsSnapshotWorkflow) {
    settingsSnapshotWorkflow.valueAfterSnapshot = changeAfterSnapshotEvaluation.result?.value;
  }

  const loadEventsBeforeRestore = pageLoadEvents;
  const restoreEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const waitFor = async (read, timeoutMs = 5_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = read();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return null;
      };
      const restoreButton = document.querySelector('.snapshotList .snapshotRestoreButton');
      restoreButton?.click();
      const confirmButton = await waitFor(() => {
        const dialogs = [...document.querySelectorAll('.popup[open]')];
        const button = dialogs.at(-1)?.querySelector('.popup-button-ok');
        return button?.textContent?.trim() === 'Restore' ? button : null;
      });
      confirmButton?.click();
      return Boolean(restoreButton && confirmButton);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (settingsSnapshotWorkflow) {
    settingsSnapshotWorkflow.restoreRequested = restoreEvaluation.result?.value === true;
  }

  const restoreDeadline = Date.now() + 10_000;
  while (pageLoadEvents <= loadEventsBeforeRestore && Date.now() < restoreDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  snapshot = await waitForApplicationSnapshot();
  if (settingsSnapshotWorkflow) {
    settingsSnapshotWorkflow.restoredValue = snapshot?.fastUiMode ?? null;
  }

  const extensionWorkflowEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const extensionModule = await import('/scripts/extensions.js');
      const scriptModule = await import('/script.js');
      const headers = scriptModule.getRequestHeaders();
      const legacyClientVersion = scriptModule.CLIENT_VERSION.split(':')[1] ?? null;
      const mockBase = ${JSON.stringify(mockProvider.baseUrl)};
      const extensionUrl = mockBase + '/browser-extension.zip';
      const post = (pathname, body) => fetch(pathname, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const routeHandled = (pathname) =>
        globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
          (request) => request.pathname === pathname && request.handled,
        ) ?? false;
      const waitFor = async (read, timeout = 15_000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const value = read();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return null;
      };
      await waitFor(() => extensionModule.extensionNames.length >= 15);

      const discoverResponse = await fetch('/api/extensions/discover', { headers });
      const discovered = discoverResponse.ok ? await discoverResponse.json() : [];
      const originalRuntimeCount = extensionModule.extensionNames.length;
      const builtInVersionResponse = await post('/api/extensions/version', {
        extensionName: 'regex',
        global: false,
      });
      const builtInVersion = builtInVersionResponse.ok ? await builtInVersionResponse.json() : null;
      const manifest = extensionModule.getExtensionManifest('regex');
      const dataManagementManifest = extensionModule.getExtensionManifest(
        'pure-tavern-data-management',
      );
      const dataManagementScriptLoaded = [...document.scripts].some((script) =>
        script.src.endsWith('/scripts/extensions/pure-tavern-data-management/index.js'),
      );
      const dataManagementStyleLoaded = [...document.styleSheets].some((sheet) =>
        sheet.href?.endsWith('/scripts/extensions/pure-tavern-data-management/style.css'),
      );
      const regexScriptLoaded = [...document.scripts].some((script) =>
        script.src.endsWith('/scripts/extensions/regex/index.js'),
      );
      const regexStyleLoaded = [...document.styleSheets].some((sheet) =>
        sheet.href?.endsWith('/scripts/extensions/regex/style.css'),
      );

      await extensionModule.disableExtension('regex', false);
      const disabledResponse = await post('/api/settings/get', {});
      const disabledSettings = disabledResponse.ok
        ? JSON.parse((await disabledResponse.json()).settings)
        : null;
      const disabledPersisted =
        disabledSettings?.extension_settings?.disabledExtensions?.includes('regex') === true;
      await extensionModule.enableExtension('regex', false);
      const enabledResponse = await post('/api/settings/get', {});
      const enabledSettings = enabledResponse.ok
        ? JSON.parse((await enabledResponse.json()).settings)
        : null;
      const enabledPersisted =
        enabledSettings?.extension_settings?.disabledExtensions?.includes('regex') === false;

      const installPromise = extensionModule.installExtension(extensionUrl, false, '');
      const warningDialog = await waitFor(() =>
        [...document.querySelectorAll('.popup[open]')].find((dialog) =>
          dialog.querySelector('.popup-button-ok'),
        ) ?? null,
      );
      const warningShown = Boolean(
        warningDialog &&
          /third-party|第三方/i.test(warningDialog.textContent ?? '') &&
          warningDialog.querySelector('.popup-button-cancel'),
      );
      warningDialog?.querySelector('.popup-button-ok')?.click();
      const installOk = await installPromise;
      await waitFor(() =>
        extensionModule.extensionNames.includes('third-party/browser-extension') &&
        globalThis.__PURE_TAVERN_THIRD_PARTY__?.loads > 0,
      );

      const thirdPartyName = 'third-party/browser-extension';
      const thirdPartyManifest = extensionModule.getExtensionManifest(thirdPartyName);
      const manifestResponse = await fetch(
        '/scripts/extensions/third-party/browser-extension/manifest.json',
        { cache: 'no-store' },
      );
      const scriptResponse = await fetch(
        '/scripts/extensions/third-party/browser-extension/dist/index.js',
        { cache: 'no-store' },
      );
      const styleResponse = await fetch(
        '/scripts/extensions/third-party/browser-extension/dist/index.css',
        { cache: 'no-store' },
      );
      const dotFileResponse = await fetch(
        '/scripts/extensions/third-party/browser-extension/.gitignore',
        { cache: 'no-store' },
      );
      const thirdPartyScriptLoaded = [...document.scripts].some((script) =>
        script.src.endsWith('/scripts/extensions/third-party/browser-extension/dist/index.js'),
      );
      const thirdPartyStyleLoaded = [...document.styleSheets].some((sheet) =>
        sheet.href?.endsWith('/scripts/extensions/third-party/browser-extension/dist/index.css'),
      );
      const installHookCalled =
        globalThis.__PURE_TAVERN_THIRD_PARTY__?.hooks?.includes('install') === true;

      await extensionModule.disableExtension(thirdPartyName, false);
      const thirdPartyDisabled =
        globalThis.__PURE_TAVERN_THIRD_PARTY__?.hooks?.includes('disable') === true;
      await extensionModule.enableExtension(thirdPartyName, false);
      const thirdPartyEnabled =
        globalThis.__PURE_TAVERN_THIRD_PARTY__?.hooks?.includes('enable') === true;

      const versionResponse = await post('/api/extensions/version', {
        extensionName: '/browser-extension',
        global: false,
      });
      const version = versionResponse.ok ? await versionResponse.json() : null;
      const branchesResponse = await post('/api/extensions/branches', {
        extensionName: '/browser-extension',
        global: false,
      });
      const branches = branchesResponse.ok ? await branchesResponse.json() : [];

      await fetch(mockBase + '/browser-extension-control?version=2.0.0');
      const changedVersionResponse = await post('/api/extensions/version', {
        extensionName: '/browser-extension',
        global: false,
      });
      const changedVersion = changedVersionResponse.ok ? await changedVersionResponse.json() : null;
      const updateResponse = await post('/api/extensions/update', {
        extensionName: '/browser-extension',
        global: false,
      });
      const update = updateResponse.ok ? await updateResponse.json() : null;
      const updatedManifestResponse = await fetch(
        '/scripts/extensions/third-party/browser-extension/manifest.json',
        { cache: 'no-store' },
      );
      const updatedManifest = updatedManifestResponse.ok
        ? await updatedManifestResponse.json()
        : null;
      const switchResponse = await post('/api/extensions/switch', {
        extensionName: '/browser-extension',
        branch: 'archive',
        global: false,
      });
      const moveResponse = await post('/api/extensions/move', {
        extensionName: '/browser-extension',
        source: 'local',
        destination: 'global',
      });
      const movedDiscoverResponse = await fetch('/api/extensions/discover', { headers });
      const movedDiscover = movedDiscoverResponse.ok ? await movedDiscoverResponse.json() : [];
      const movedToGlobal = movedDiscover.some(
        (extension) => extension.name === thirdPartyName && extension.type === 'global',
      );

      const thirdPartyModule = await import(
        '/scripts/extensions/third-party/browser-extension/dist/index.js'
      );
      await thirdPartyModule.onDelete();
      const deleteResponse = await post('/api/extensions/delete', {
        extensionName: '/browser-extension',
        global: true,
      });
      const afterDeleteResponse = await fetch('/api/extensions/discover', { headers });
      const afterDelete = afterDeleteResponse.ok ? await afterDeleteResponse.json() : [];
      const deleteHookCalled =
        globalThis.__PURE_TAVERN_THIRD_PARTY__?.hooks?.includes('delete') === true;
      const deleteOk =
        deleteResponse.ok &&
        !afterDelete.some((extension) => extension.name === thirdPartyName);

      const feature = globalThis.__PURE_TAVERN__?.features?.extensions;
      return {
        available: true,
        discoveredCount: discovered.length,
        discoveredNames: discovered.map((extension) => extension.name),
        originalRuntimeCount,
        manifestLoaded: manifest?.display_name === 'Regex',
        dataManagementManifestLoaded:
          dataManagementManifest?.display_name === 'Pure Tavern Data Management',
        dataManagementScriptLoaded,
        dataManagementStyleLoaded,
        dataManagementRuntimeInstalled:
          globalThis.__PURE_TAVERN_DATA_MANAGEMENT__?.installed === true,
        regexScriptLoaded,
        regexStyleLoaded,
        versionOk:
          builtInVersionResponse.ok &&
          builtInVersion?.isUpToDate === true &&
          builtInVersion?.currentBranchName === '',
        disabledPersisted,
        enabledPersisted,
        warningShown,
        installOk,
        runtimeCountAfterInstall: extensionModule.extensionNames.length,
        thirdPartyManifestLoaded:
          thirdPartyManifest?.display_name === 'Browser CORS Extension' &&
          thirdPartyManifest?.minimum_client_version === '1.12.13' &&
          thirdPartyManifest?.future_manifest_field?.kept === true,
        minimumClientVersionAccepted: legacyClientVersion === '1.18.0',
        manifestAssetServed:
          manifestResponse.ok &&
          manifestResponse.headers.get('X-Pure-Tavern-Asset') === 'assets/extensions',
        scriptAssetServed:
          scriptResponse.ok &&
          scriptResponse.headers.get('X-Pure-Tavern-Asset') === 'assets/extensions',
        styleAssetServed:
          styleResponse.ok &&
          styleResponse.headers.get('X-Pure-Tavern-Asset') === 'assets/extensions' &&
          styleResponse.headers.get('Content-Type') === 'text/css',
        dotFileAssetServed:
          dotFileResponse.ok &&
          dotFileResponse.headers.get('X-Pure-Tavern-Asset') === 'assets/extensions',
        thirdPartyScriptLoaded,
        thirdPartyStyleLoaded,
        installHookCalled,
        thirdPartyDisabled,
        thirdPartyEnabled,
        versionInitiallyCurrent: version?.isUpToDate === true,
        branchCount: branches.length,
        updateDetected: changedVersion?.isUpToDate === false,
        updateOk: updateResponse.ok && update?.isUpToDate === false,
        updatedManifestVersion: updatedManifest?.version ?? null,
        switchOk: switchResponse.status === 204,
        moveOk: moveResponse.status === 204 && movedToGlobal,
        deleteHookCalled,
        deleteOk,
        routesHandled: {
          discover: routeHandled('/api/extensions/discover'),
          install: routeHandled('/api/extensions/install'),
          version: routeHandled('/api/extensions/version'),
          update: routeHandled('/api/extensions/update'),
          branches: routeHandled('/api/extensions/branches'),
          switch: routeHandled('/api/extensions/switch'),
          move: routeHandled('/api/extensions/move'),
          delete: routeHandled('/api/extensions/delete'),
          comfyBootstrap: routeHandled('/api/sd/comfy/workflows'),
        },
        registry: feature?.registry ? { ...feature.registry } : null,
        trustedBuiltIns: feature?.trustedBuiltIns ? { ...feature.trustedBuiltIns } : null,
        localPackageAssetsInjected: feature?.localPackageAssetsInjected === true,
        executionModel: feature?.executionModel ?? null,
        originalRiskWarningOwnedByLegacyUi:
          feature?.originalRiskWarningOwnedByLegacyUi === true,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const extensionWorkflow = extensionWorkflowEvaluation.result?.value;

  const tokenizerWorkflowEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const tokenizerModule = await import('/scripts/tokenizers.js');
      const scriptModule = await import('/script.js');
      const text = 'Unified tokenx count 你好 👋 for every model.';
      const headers = scriptModule.getRequestHeaders();
      const routeHandled = (pathname) =>
        globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
          (request) => request.pathname === pathname && request.handled,
        ) ?? false;
      const aliases = ['gpt2', 'llama', 'mistral', 'claude', 'deepseek'];
      const encoded = [];
      for (const alias of aliases) {
        const response = await fetch('/api/tokenizers/' + alias + '/encode', {
          method: 'POST',
          headers,
          body: JSON.stringify({ text }),
        });
        encoded.push(response.ok ? await response.json() : null);
      }
      const counts = encoded.map((result) => result?.count);
      const allAliasCountsSame =
        counts.every((count) => typeof count === 'number' && count === counts[0]) &&
        encoded.every(
          (result) =>
            result?.approximate === true &&
            result?.tokenizer === 'tokenx' &&
            result?.backend === 'worker-tokenx',
        );

      const llamaIds = tokenizerModule.getTextTokens(tokenizerModule.tokenizers.LLAMA, text);
      const decoded = tokenizerModule.decodeTextTokens(
        tokenizerModule.tokenizers.LLAMA,
        llamaIds,
      );
      const gpt2Ids = tokenizerModule.getTextTokens(tokenizerModule.tokenizers.GPT2, text);
      const openAiCount = await tokenizerModule.countTokensOpenAIAsync(
        [{ role: 'user', content: text }],
        true,
      );
      const directOpenAiResponse = await fetch('/api/tokenizers/openai/count?model=ignored', {
        method: 'POST',
        headers,
        body: JSON.stringify([{ role: 'user', content: text }]),
      });
      const directOpenAi = directOpenAiResponse.ok ? await directOpenAiResponse.json() : null;
      const remoteResponse = await fetch('/api/tokenizers/remote/kobold/count', {
        method: 'POST',
        headers,
        body: JSON.stringify({ text, url: 'http://not-contacted.invalid' }),
      });
      const remote = remoteResponse.ok ? await remoteResponse.json() : null;
      const feature = globalThis.__PURE_TAVERN__?.features?.tokenizers;

      return {
        available: true,
        aliases,
        counts,
        allAliasCountsSame,
        workerResponses: encoded.map((result) => result?.backend),
        originalLlamaCount: llamaIds.length,
        originalGpt2Count: gpt2Ids.length,
        originalCountsSame: llamaIds.length === gpt2Ids.length && llamaIds.length === counts[0],
        pseudoDecodeRoundTrip:
          decoded?.text === text &&
          Array.isArray(decoded?.chunks) &&
          decoded.chunks.join('') === text,
        openAiCount,
        directOpenAiCount: directOpenAi?.token_count ?? null,
        openAiApproximate:
          directOpenAi?.approximate === true && directOpenAi?.tokenizer === 'tokenx',
        remoteLocalCount:
          remote?.count === counts[0] &&
          remote?.approximate === true &&
          remote?.tokenizer === 'tokenx',
        routesHandled: {
          llamaEncode: routeHandled('/api/tokenizers/llama/encode'),
          llamaDecode: routeHandled('/api/tokenizers/llama/decode'),
          gpt2Encode: routeHandled('/api/tokenizers/gpt2/encode'),
          openAiCount: routeHandled('/api/tokenizers/openai/count'),
          remoteKobold: routeHandled('/api/tokenizers/remote/kobold/count'),
        },
        engine: feature?.engine ? { ...feature.engine } : null,
        workerRequested: feature?.workerRequested ?? null,
        semantics: feature?.semantics ?? null,
        modelSpecific: feature?.modelSpecific ?? null,
        pseudoTokenIds: feature?.pseudoTokenIds ?? null,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const tokenizerWorkflow = tokenizerWorkflowEvaluation.result?.value;

  const secretWorkflowEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const secretsModule = await import('/scripts/secrets.js');
      const key = secretsModule.SECRET_KEYS.OPENAI;
      const headers = { 'Content-Type': 'application/json' };
      const routeHandled = (pathname) =>
        globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
          (request) => request.pathname === pathname && request.handled,
        ) ?? false;

      await secretsModule.readSecretState();
      const exposureAllowed = await secretsModule.canViewSecrets();
      const firstId = await secretsModule.writeSecret(
        key,
        'browser-secret-first-123',
        'Browser First',
      );
      const secondId = await secretsModule.writeSecret(
        key,
        'browser-secret-second-456',
        'Browser Second',
      );
      await secretsModule.rotateSecret(key, firstId);
      await secretsModule.renameSecret(key, firstId, 'Browser Primary');
      const foundFirst = await secretsModule.findSecret(key, firstId);
      const viewResponse = await fetch('/api/secrets/view', { method: 'POST', headers });
      const viewed = viewResponse.ok ? await viewResponse.json() : null;
      const state = secretsModule.secret_state[key] ?? [];
      const feature = globalThis.__PURE_TAVERN__?.features?.secrets;

      return {
        available: true,
        key,
        firstId,
        secondId,
        exposureAllowed,
        firstMasked: state.find((secret) => secret.id === firstId)?.value ?? null,
        secondMasked: state.find((secret) => secret.id === secondId)?.value ?? null,
        firstActive: state.find((secret) => secret.id === firstId)?.active === true,
        firstRenamed: state.find((secret) => secret.id === firstId)?.label === 'Browser Primary',
        foundFirst,
        viewedActive: viewed?.[key] ?? null,
        routesHandled: {
          settings: routeHandled('/api/secrets/settings'),
          write: routeHandled('/api/secrets/write'),
          read: routeHandled('/api/secrets/read'),
          view: routeHandled('/api/secrets/view'),
          find: routeHandled('/api/secrets/find'),
          rotate: routeHandled('/api/secrets/rotate'),
          rename: routeHandled('/api/secrets/rename'),
        },
        storage: feature?.storage ? { ...feature.storage } : null,
        security: feature?.security ? { ...feature.security } : null,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const secretWorkflow = secretWorkflowEvaluation.result?.value ?? {};

  const generationWorkflowEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const scriptModule = await import('/script.js');
      const secretsModule = await import('/scripts/secrets.js');
      const openAiModule = await import('/scripts/openai.js');
      const sseModule = await import('/scripts/sse-stream.js');
      const headers = scriptModule.getRequestHeaders();
      const mockBase = ${JSON.stringify(mockProvider.baseUrl)};
      const post = (pathname, body) => fetch(pathname, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const routeHandled = (pathname) =>
        globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
          (request) => request.pathname === pathname && request.handled,
        ) ?? false;

      await secretsModule.writeSecret('api_key_custom', 'browser-custom-provider-key', 'Browser Custom');
      await secretsModule.writeSecret('api_key_claude', 'browser-claude-provider-key', 'Browser Claude');
      await secretsModule.writeSecret('api_key_makersuite', 'browser-google-provider-key', 'Browser Google');
      await secretsModule.writeSecret('api_key_cohere', 'browser-cohere-provider-key', 'Browser Cohere');

      const customBase = {
        chat_completion_source: 'custom',
        custom_url: mockBase + '/v1',
        model: 'browser-provider-model',
        messages: [{ role: 'user', content: 'Browser provider prompt' }],
      };
      const statusResponse = await post('/api/backends/chat-completions/status', customBase);
      const status = statusResponse.ok ? await statusResponse.json() : null;
      const nonStreamResponse = await post('/api/backends/chat-completions/generate', {
        ...customBase,
        stream: false,
      });
      const nonStream = nonStreamResponse.ok ? await nonStreamResponse.json() : null;

      const streamResponse = await post('/api/backends/chat-completions/generate', {
        ...customBase,
        stream: true,
      });
      const eventStream = sseModule.getEventSourceStream();
      streamResponse.body.pipeThrough(eventStream);
      const reader = eventStream.readable.getReader();
      const streamState = { reasoning: '', images: [], signature: '', toolSignatures: {} };
      let streamText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done || value.data === '[DONE]') break;
        streamText += openAiModule.getStreamingReply(JSON.parse(value.data), streamState, {
          chatCompletionSource: 'openai',
        });
      }

      const messages = [
        { role: 'system', content: 'Browser system' },
        { role: 'user', content: 'Browser native prompt' },
      ];
      const anthropicResponse = await post('/api/backends/chat-completions/generate', {
        chat_completion_source: 'claude',
        reverse_proxy: mockBase + '/anthropic',
        model: 'browser-claude-model',
        messages,
        max_tokens: 64,
      });
      const anthropic = anthropicResponse.ok ? await anthropicResponse.json() : null;
      const googleResponse = await post('/api/backends/chat-completions/generate', {
        chat_completion_source: 'makersuite',
        reverse_proxy: mockBase + '/google',
        model: 'browser-google-model',
        messages,
        max_tokens: 64,
      });
      const google = googleResponse.ok ? await googleResponse.json() : null;
      const cohereResponse = await post('/api/backends/chat-completions/generate', {
        chat_completion_source: 'cohere',
        reverse_proxy: mockBase + '/cohere',
        model: 'browser-cohere-model',
        messages,
        max_tokens: 64,
      });
      const cohere = cohereResponse.ok ? await cohereResponse.json() : null;
      const biasResponse = await post('/api/backends/chat-completions/bias?model=ignored', [
        { text: '[101, 202]', value: -3 },
        { text: 'requires exact tokenizer', value: 2 },
      ]);
      const bias = biasResponse.ok ? await biasResponse.json() : null;
      const feature = globalThis.__PURE_TAVERN__?.features?.generation;

      return {
        available: true,
        modelIds: status?.data?.map((model) => model.id) ?? [],
        nonStreamText: nonStream?.choices?.[0]?.message?.content ?? null,
        streamText,
        anthropicText: anthropic?.content?.[0]?.text ?? null,
        googleText: google?.candidates?.[0]?.content?.parts?.[0]?.text ?? null,
        cohereText: cohere?.message?.content?.[0]?.text ?? null,
        bias,
        sourceCount: feature?.providerSources?.length ?? 0,
        service: feature?.service ? { ...feature.service } : null,
        transport: feature?.transport ? { ...feature.transport } : null,
        scope: feature?.scope ?? null,
        directBrowserRequests: feature?.directBrowserRequests ?? null,
        optionalBackend: feature?.optionalBackend ?? null,
        originalPrepareFunction: typeof openAiModule.prepareOpenAIMessages === 'function',
        duplicatePromptFeatureAbsent:
          globalThis.__PURE_TAVERN__?.features?.['prompt-pipeline'] === undefined,
        routesHandled: {
          status: routeHandled('/api/backends/chat-completions/status'),
          generate: routeHandled('/api/backends/chat-completions/generate'),
          bias: routeHandled('/api/backends/chat-completions/bias'),
        },
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const generationWorkflow = generationWorkflowEvaluation.result?.value;

  const presetWorkflowEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const scriptModule = await import('/script.js');
      const presetModule = await import('/scripts/preset-manager.js');
      const headers = scriptModule.getRequestHeaders();
      const postJson = (pathname, body) => fetch(pathname, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        cache: 'no-cache',
      });
      const getBootstrap = async () => {
        const response = await postJson('/api/settings/get', {});
        return response.ok ? response.json() : null;
      };
      const routeHandled = (pathname) =>
        globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
          (request) => request.pathname === pathname && request.handled,
        ) ?? false;

      const initial = await getBootstrap();
      const selectorCounts = Object.fromEntries(
        [
          'settings_preset',
          'settings_preset_novel',
          'settings_preset_openai',
          'settings_preset_textgenerationwebui',
          'context_presets',
          'instruct_presets',
          'sysprompt_select',
          'reasoning_select',
          'themes',
          'movingUIPresets',
        ].map((id) => [id, document.getElementById(id)?.querySelectorAll('option').length ?? 0]),
      );

      const contextManager = presetModule.getPresetManager('context');
      const sourceContext = initial?.context?.[0] ?? { name: 'Browser Source Context' };
      await contextManager.savePreset(
        'Browser Context',
        { ...structuredClone(sourceContext), name: 'Browser Context', future_field: { kept: true } },
      );
      const afterCustom = await getBootstrap();
      const customContext = afterCustom?.context?.find((preset) => preset.name === 'Browser Context');
      const defaultContextName = initial?.context?.[0]?.name;
      const restoredDefault = defaultContextName
        ? await contextManager.getDefaultPreset(defaultContextName)
        : null;
      const customDeleteOk = await contextManager.deletePreset('Browser Context');
      const afterDelete = await getBootstrap();

      const themeSave = await postJson('/api/themes/save', {
        name: 'Browser Theme',
        blur_strength: 7,
        future_field: { kept: true },
      });
      const quickReplySave = await postJson('/api/quick-replies/save', {
        name: 'Browser Quick Reply',
        qrList: [],
        future_field: { kept: true },
      });
      const movingUiSave = await postJson('/api/moving-ui/save', {
        name: 'Browser Moving UI',
        movingUIState: { browser: { top: 1, left: 2 } },
        future_field: { kept: true },
      });
      const afterSpecialized = await getBootstrap();
      const themeDelete = await postJson('/api/themes/delete', { name: 'Browser Theme' });
      const quickReplyDelete = await postJson('/api/quick-replies/delete', {
        name: 'Browser Quick Reply',
      });

      return {
        available: Boolean(initial && contextManager),
        defaultCounts: {
          kobold: initial?.koboldai_settings?.length ?? 0,
          novel: initial?.novelai_settings?.length ?? 0,
          openai: initial?.openai_settings?.length ?? 0,
          textgen: initial?.textgenerationwebui_presets?.length ?? 0,
          instruct: initial?.instruct?.length ?? 0,
          context: initial?.context?.length ?? 0,
          sysprompt: initial?.sysprompt?.length ?? 0,
          reasoning: initial?.reasoning?.length ?? 0,
          themes: initial?.themes?.length ?? 0,
          movingUi: initial?.movingUIPresets?.length ?? 0,
          quickReplies: initial?.quickReplyPresets?.length ?? 0,
        },
        selectorCounts,
        customSavedWithOpaqueField: customContext?.future_field?.kept === true,
        customDeleteOk: customDeleteOk === true,
        customDeleted:
          !afterDelete?.context?.some((preset) => preset.name === 'Browser Context'),
        defaultRestoreOk: Boolean(restoredDefault?.isDefault === true && restoredDefault?.preset),
        specialized: {
          themeSaved:
            themeSave.ok &&
            afterSpecialized?.themes?.some(
              (preset) => preset.name === 'Browser Theme' && preset.future_field?.kept,
            ),
          quickReplySaved:
            quickReplySave.ok &&
            afterSpecialized?.quickReplyPresets?.some(
              (preset) => preset.name === 'Browser Quick Reply' && preset.future_field?.kept,
            ),
          movingUiSaved:
            movingUiSave.ok &&
            afterSpecialized?.movingUIPresets?.some(
              (preset) => preset.name === 'Browser Moving UI' && preset.future_field?.kept,
            ),
          themeDeleteOk: themeDelete.ok,
          quickReplyDeleteOk: quickReplyDelete.ok,
        },
        routesHandled: {
          save: routeHandled('/api/presets/save'),
          delete: routeHandled('/api/presets/delete'),
          restore: routeHandled('/api/presets/restore'),
          themeSave: routeHandled('/api/themes/save'),
          themeDelete: routeHandled('/api/themes/delete'),
          quickReplySave: routeHandled('/api/quick-replies/save'),
          quickReplyDelete: routeHandled('/api/quick-replies/delete'),
          movingUiSave: routeHandled('/api/moving-ui/save'),
        },
        storage: globalThis.__PURE_TAVERN__?.features?.presets?.storage
          ? { ...globalThis.__PURE_TAVERN__.features.presets.storage }
          : null,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const presetWorkflow = presetWorkflowEvaluation.result?.value;

  const worldBookWorkflowEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const worldModule = await import('/scripts/world-info.js');
      const scriptModule = await import('/script.js');
      const headers = scriptModule.getRequestHeaders();
      const postJson = (pathname, body) => fetch(pathname, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        cache: 'no-cache',
      });
      const routeHandled = (pathname) =>
        globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
          (request) => request.pathname === pathname && request.handled,
        ) ?? false;
      const makeEntry = (uid, overrides) => ({
        ...structuredClone(worldModule.newWorldInfoEntryTemplate),
        uid,
        displayIndex: uid,
        ...overrides,
      });
      const matcherName = 'Browser Matcher';
      const matcherDocument = {
        name: matcherName,
        extensions: { browser: true },
        future_top_level: { kept: true },
        entries: {
          0: makeEntry(0, {
            key: ['alpha-probe'],
            content: 'BROWSER_KEY_MATCH',
            constant: false,
            disable: false,
            position: worldModule.world_info_position.before,
            future_entry_field: { kept: true },
          }),
          1: makeEntry(1, {
            key: [],
            content: 'BROWSER_CONSTANT_MATCH',
            constant: true,
            disable: false,
            position: worldModule.world_info_position.after,
          }),
          2: makeEntry(2, {
            key: [],
            content: 'BROWSER_DISABLED_MATCH',
            constant: true,
            disable: true,
            position: worldModule.world_info_position.before,
          }),
        },
      };

      await worldModule.saveWorldInfo(matcherName, matcherDocument, true);
      const listResponse = await postJson('/api/worldinfo/list', {});
      const listedWorlds = listResponse.ok ? await listResponse.json() : [];
      await worldModule.updateWorldInfoList();
      await worldModule.showWorldEditor(matcherName);
      await new Promise((resolve) => setTimeout(resolve, 150));
      worldModule.worldInfoCache.clear();
      worldModule.updateWorldInfoSettings(worldModule.getWorldInfoSettings(), [matcherName]);
      const activated = await worldModule.checkWorldInfo(['alpha-probe'], 4_096, true);
      const activatedText =
        String(activated.worldInfoBefore ?? '') + String(activated.worldInfoAfter ?? '');
      const getResponse = await postJson('/api/worldinfo/get', { name: matcherName });
      const loaded = getResponse.ok ? await getResponse.json() : null;

      const importedName = 'Browser Imported World';
      const importFile = new File(
        [JSON.stringify({ entries: { 0: makeEntry(0, { key: ['imported'], content: 'IMPORTED' }) } })],
        importedName + '.json',
        { type: 'application/json' },
      );
      await worldModule.importWorldInfo(importFile);
      const afterImportResponse = await postJson('/api/settings/get', {});
      const afterImport = afterImportResponse.ok ? await afterImportResponse.json() : null;
      const editorHasMatcher = [...document.querySelectorAll('#world_editor_select option')]
        .some((option) => option.textContent === matcherName);
      const editorEntryCount = document.querySelectorAll('#WorldInfo .world_entry').length;

      const deleteMatcher = await worldModule.deleteWorldInfo(matcherName);
      const deleteImported = await worldModule.deleteWorldInfo(importedName);
      const afterDeleteResponse = await postJson('/api/settings/get', {});
      const afterDelete = afterDeleteResponse.ok ? await afterDeleteResponse.json() : null;

      return {
        available: true,
        saveAndGetOk:
          listResponse.ok &&
          listedWorlds.some((book) => book.file_id === matcherName) &&
          getResponse.ok &&
          loaded?.future_top_level?.kept === true &&
          loaded?.entries?.['0']?.future_entry_field?.kept === true,
        matcher: {
          keyActivated: activatedText.includes('BROWSER_KEY_MATCH'),
          constantActivated: activatedText.includes('BROWSER_CONSTANT_MATCH'),
          disabledExcluded: !activatedText.includes('BROWSER_DISABLED_MATCH'),
        },
        ui: { editorHasMatcher, editorEntryCount },
        importVisible: afterImport?.world_names?.includes(importedName) === true,
        deleteOk: deleteMatcher !== false && deleteImported !== false,
        deletedFromBootstrap:
          !afterDelete?.world_names?.includes(matcherName) &&
          !afterDelete?.world_names?.includes(importedName),
        routesHandled: {
          list: routeHandled('/api/worldinfo/list'),
          get: routeHandled('/api/worldinfo/get'),
          edit: routeHandled('/api/worldinfo/edit'),
          import: routeHandled('/api/worldinfo/import'),
          delete: routeHandled('/api/worldinfo/delete'),
        },
        storage: globalThis.__PURE_TAVERN__?.features?.['world-books']?.storage
          ? { ...globalThis.__PURE_TAVERN__.features['world-books'].storage }
          : null,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const worldBookWorkflow = worldBookWorkflowEvaluation.result?.value;

  const assetsWorkflowEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const scriptModule = await import('/script.js');
      const backgroundsModule = await import('/scripts/backgrounds.js');
      const chatsModule = await import('/scripts/chats.js');
      const headers = scriptModule.getRequestHeaders();
      const formHeaders = scriptModule.getRequestHeaders({ omitContentType: true });
      const postJson = (pathname, body) => fetch(pathname, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        cache: 'no-cache',
      });
      const routeHandled = (pathname) =>
        globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
          (request) => request.pathname === pathname && request.handled,
        ) ?? false;
      const pngBytes = Uint8Array.from(
        atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='),
        (character) => character.charCodeAt(0),
      );
      const pngFile = (name) => new File([pngBytes], name, { type: 'image/png' });

      const defaultBackgroundsResponse = await postJson('/api/backgrounds/all', {});
      const defaultBackgrounds = defaultBackgroundsResponse.ok
        ? await defaultBackgroundsResponse.json()
        : null;
      const backgroundForm = new FormData();
      backgroundForm.append('avatar', pngFile('browser-background.png'));
      const backgroundUpload = await fetch('/api/backgrounds/upload', {
        method: 'POST',
        headers: formHeaders,
        body: backgroundForm,
      });
      const backgroundName = backgroundUpload.ok ? await backgroundUpload.text() : '';
      await backgroundsModule.getBackgrounds();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const backgroundDomVisible = Boolean(
        document.querySelector('.bg_example[bgfile="browser-background.png"]'),
      );
      const backgroundDirect = await fetch('/backgrounds/browser-background.png', {
        cache: 'reload',
      });
      const backgroundThumbnail = await fetch(
        '/thumbnail?type=bg&file=browser-background.png&t=' + Date.now(),
        { cache: 'reload' },
      );
      const folderCreate = await postJson('/api/image-metadata/folders/create', {
        name: 'Browser Folder',
      });
      const folder = folderCreate.ok ? await folderCreate.json() : null;
      const folderAssign = folder?.id
        ? await postJson('/api/image-metadata/folders/assign', {
            id: folder.id,
            paths: ['/backgrounds/browser-background.png'],
          })
        : null;
      const foldersResponse = await postJson('/api/backgrounds/folders', {});
      const folders = foldersResponse.ok ? await foldersResponse.json() : null;
      const backgroundRename = await postJson('/api/backgrounds/rename', {
        old_bg: 'browser-background.png',
        new_bg: 'browser-background-renamed.png',
      });
      const renamedBackground = await fetch('/backgrounds/browser-background-renamed.png', {
        cache: 'reload',
      });

      const attachmentUrl = await chatsModule.uploadFileAttachment(
        'browser-attachment.txt',
        btoa('Browser attachment text'),
      );
      const attachmentText = attachmentUrl
        ? await chatsModule.getFileAttachment(attachmentUrl)
        : null;
      const attachmentVerify = await postJson('/api/files/verify', {
        urls: attachmentUrl ? [attachmentUrl] : [],
      });
      const attachmentVerification = attachmentVerify.ok
        ? await attachmentVerify.json()
        : null;
      const attachmentDirect = attachmentUrl
        ? await fetch(attachmentUrl, { cache: 'reload' })
        : null;

      const userImageUpload = await postJson('/api/images/upload', {
        image: btoa(String.fromCharCode(...pngBytes)),
        format: 'png',
        filename: 'browser-image.png',
        ch_name: 'Browser Images',
      });
      const userImageData = userImageUpload.ok ? await userImageUpload.json() : null;
      const userImageList = await postJson('/api/images/list', {
        folder: 'Browser Images',
        sortField: 'date',
        sortOrder: 'asc',
        type: 1,
      });
      const userImageNames = userImageList.ok ? await userImageList.json() : [];
      const userImageDirect = userImageData?.path
        ? await fetch(userImageData.path, { cache: 'reload' })
        : null;

      const avatarForm = new FormData();
      avatarForm.append('avatar', pngFile('browser-user-avatar.png'));
      const avatarUpload = await fetch('/api/avatars/upload', {
        method: 'POST',
        headers: formHeaders,
        body: avatarForm,
      });
      const avatarData = avatarUpload.ok ? await avatarUpload.json() : null;
      const avatarList = await postJson('/api/avatars/get', {});
      const avatarNames = avatarList.ok ? await avatarList.json() : [];
      const avatarDirect = avatarData?.path
        ? await fetch('/User%20Avatars/' + encodeURIComponent(avatarData.path), { cache: 'reload' })
        : null;
      const avatarThumbnail = avatarData?.path
        ? await fetch('/thumbnail?type=persona&file=' + encodeURIComponent(avatarData.path), {
            cache: 'reload',
          })
        : null;

      const spriteForm = new FormData();
      spriteForm.append('name', 'Browser Sprite Owner');
      spriteForm.append('label', 'joy');
      spriteForm.append('avatar', pngFile('joy.png'));
      const spriteUpload = await fetch('/api/sprites/upload', {
        method: 'POST',
        headers: formHeaders,
        body: spriteForm,
      });
      const spriteListResponse = await fetch(
        '/api/sprites/get?name=' + encodeURIComponent('Browser Sprite Owner'),
        { headers },
      );
      const sprites = spriteListResponse.ok ? await spriteListResponse.json() : [];
      const spriteDirect = sprites[0]?.path
        ? await fetch(sprites[0].path, { cache: 'reload' })
        : null;

      const libraryDownload = await postJson('/api/assets/download', {
        url: location.origin + '/sounds/silence.mp3',
        category: 'blip',
        filename: 'browser-silence.mp3',
      });
      const libraryData = libraryDownload.ok ? await libraryDownload.json() : null;
      const libraryList = await postJson('/api/assets/get', {});
      const installedLibrary = libraryList.ok ? await libraryList.json() : null;
      const libraryDirect = libraryData?.path
        ? await fetch('/' + libraryData.path.replace(/^\\//, ''), { cache: 'reload' })
        : null;

      const backgroundDelete = await postJson('/api/backgrounds/delete', {
        bg: 'browser-background-renamed.png',
      });
      const folderDelete = folder?.id
        ? await postJson('/api/image-metadata/folders/delete', { id: folder.id })
        : null;
      const userImageDelete = userImageData?.path
        ? await postJson('/api/images/delete', { path: userImageData.path })
        : null;
      const avatarDelete = avatarData?.path
        ? await postJson('/api/avatars/delete', { avatar: avatarData.path })
        : null;
      const spriteDelete = await postJson('/api/sprites/delete', {
        name: 'Browser Sprite Owner',
        label: 'joy',
        spriteName: 'joy',
      });
      const libraryDelete = await postJson('/api/assets/delete', {
        category: 'blip',
        filename: 'browser-silence.mp3',
      });

      return {
        available: true,
        defaultBackgroundCount: defaultBackgrounds?.images?.length ?? 0,
        defaultBackgroundSeed: globalThis.__PURE_TAVERN__?.features?.assets?.defaultBackgrounds
          ? { ...globalThis.__PURE_TAVERN__.features.assets.defaultBackgrounds }
          : null,
        serviceWorker: globalThis.__PURE_TAVERN__?.features?.assets?.serviceWorker
          ? { ...globalThis.__PURE_TAVERN__.features.assets.serviceWorker }
          : null,
        storage: {
          blobs: globalThis.__PURE_TAVERN__?.features?.assets?.blobs
            ? { ...globalThis.__PURE_TAVERN__.features.assets.blobs }
            : null,
          index: globalThis.__PURE_TAVERN__?.features?.assets?.index
            ? { ...globalThis.__PURE_TAVERN__.features.assets.index }
            : null,
        },
        background: {
          uploadOk: backgroundUpload.ok && backgroundName === 'browser-background.png',
          domVisible: backgroundDomVisible,
          directSource: backgroundDirect.headers.get('X-Pure-Tavern-Asset'),
          thumbnailSource: backgroundThumbnail.headers.get('X-Pure-Tavern-Asset'),
          folderOk:
            folderCreate.ok &&
            folderAssign?.ok === true &&
            folders?.imageFolderMap?.['browser-background.png']?.includes(folder.id),
          renameOk:
            backgroundRename.ok &&
            renamedBackground.headers.get('X-Pure-Tavern-Asset') === 'assets/backgrounds',
          deleteOk: backgroundDelete.ok && folderDelete?.ok === true,
        },
        attachment: {
          url: attachmentUrl,
          text: attachmentText,
          verified: attachmentVerification?.[attachmentUrl] === true,
          directSource: attachmentDirect?.headers.get('X-Pure-Tavern-Asset') ?? null,
        },
        userImage: {
          uploadOk: userImageUpload.ok,
          listed: userImageList.ok && userImageNames.includes('browser-image.png'),
          directSource: userImageDirect?.headers.get('X-Pure-Tavern-Asset') ?? null,
          deleteOk: userImageDelete?.ok === true,
        },
        avatar: {
          uploadOk: avatarUpload.ok,
          listed: avatarNames.includes(avatarData?.path),
          directSource: avatarDirect?.headers.get('X-Pure-Tavern-Asset') ?? null,
          thumbnailSource: avatarThumbnail?.headers.get('X-Pure-Tavern-Asset') ?? null,
          deleteOk: avatarDelete?.ok === true,
        },
        sprite: {
          uploadOk: spriteUpload.ok,
          listed: sprites.some((sprite) => sprite.label === 'joy'),
          directSource: spriteDirect?.headers.get('X-Pure-Tavern-Asset') ?? null,
          deleteOk: spriteDelete.ok,
        },
        library: {
          downloadOk: libraryDownload.ok,
          listed: installedLibrary?.blip?.includes(libraryData?.path),
          directSource: libraryDirect?.headers.get('X-Pure-Tavern-Asset') ?? null,
          deleteOk: libraryDelete.ok,
        },
        routesHandled: {
          filesUpload: routeHandled('/api/files/upload'),
          filesVerify: routeHandled('/api/files/verify'),
          imagesUpload: routeHandled('/api/images/upload'),
          imagesList: routeHandled('/api/images/list'),
          backgroundsAll: routeHandled('/api/backgrounds/all'),
          backgroundsUpload: routeHandled('/api/backgrounds/upload'),
          backgroundsFolders: routeHandled('/api/backgrounds/folders'),
          metadataFolders: routeHandled('/api/image-metadata/folders/create'),
          avatarsUpload: routeHandled('/api/avatars/upload'),
          spritesUpload: routeHandled('/api/sprites/upload'),
          assetsDownload: routeHandled('/api/assets/download'),
        },
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const assetsWorkflow = assetsWorkflowEvaluation.result?.value;

  const characterCreateEditEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const scriptModule = await import('/script.js');
      const jsonHeaders = scriptModule.getRequestHeaders();
      const formHeaders = scriptModule.getRequestHeaders({ omitContentType: true });
      const routeHandled = (pathname) =>
        globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
          (request) => request.pathname === pathname && request.handled,
        ) ?? false;

      const form = new FormData();
      form.append('ch_name', 'Browser Alice');
      form.append('description', 'Created in the browser verification flow.');
      form.append('first_mes', 'Hello from Browser Alice.');
      form.append('creator_notes', 'Pure frontend test card.');
      form.append('talkativeness', '0.5');
      form.append('fav', 'false');
      const embeddedBookName = 'Browser Embedded Lore';
      const embeddedCharacterData = {
        data: {
          character_book: {
            name: embeddedBookName,
            extensions: { browser: true },
            entries: [
              {
                id: 0,
                keys: ['embedded-probe'],
                secondary_keys: [],
                comment: 'Browser embedded lore',
                content: 'BROWSER_EMBEDDED_LORE',
                constant: false,
                selective: false,
                insertion_order: 100,
                enabled: true,
                position: 'before_char',
                extensions: { future_embedded_field: { kept: true } },
              },
            ],
          },
        },
      };
      form.append('json_data', JSON.stringify(embeddedCharacterData));
      const createResponse = await fetch('/api/characters/create', {
        method: 'POST',
        headers: formHeaders,
        body: form,
        cache: 'no-cache',
      });
      const createdAvatar = createResponse.ok ? await createResponse.text() : '';

      const listAfterCreateResponse = await fetch('/api/characters/all', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({}),
      });
      const listAfterCreate = listAfterCreateResponse.ok ? await listAfterCreateResponse.json() : [];
      await scriptModule.getCharacters();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const listCard = [...document.querySelectorAll('#rm_print_characters_block .character_select')]
        .find((element) => element.querySelector('img')?.getAttribute('alt') === 'Browser Alice');
      const listCardImage = listCard?.querySelector('img') ?? null;
      const thumbnailResponse = createdAvatar
        ? await fetch('/thumbnail?type=avatar&file=' + encodeURIComponent(createdAvatar) + '&t=' + Date.now(), { cache: 'reload' })
        : null;
      const directAvatarResponse = createdAvatar
        ? await fetch('/characters/' + encodeURIComponent(createdAvatar), { cache: 'reload' })
        : null;

      const editForm = new FormData();
      editForm.append('avatar_url', createdAvatar);
      editForm.append('ch_name', 'Browser Alice');
      editForm.append('description', 'Edited in the browser verification flow.');
      editForm.append('first_mes', 'Edited first message.');
      editForm.append('chat', 'Browser Alice - verification');
      editForm.append('create_date', '2026-01-01T00:00:00.000Z');
      editForm.append('talkativeness', '0.65');
      editForm.append('fav', 'false');
      editForm.append('json_data', JSON.stringify(embeddedCharacterData));
      const editResponse = await fetch('/api/characters/edit', {
        method: 'POST',
        headers: formHeaders,
        body: editForm,
        cache: 'no-cache',
      });

      const getAfterEditResponse = await fetch('/api/characters/get', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ avatar_url: createdAvatar }),
      });
      const getAfterEdit = getAfterEditResponse.ok ? await getAfterEditResponse.json() : null;

      await scriptModule.getCharacters();
      const embeddedCharacterId = scriptModule.characters.findIndex(
        (character) => character.avatar === createdAvatar,
      );
      const worldModule = await import('/scripts/world-info.js');
      const { accountStorage } = await import('/scripts/util/AccountStorage.js');
      accountStorage.setItem('AlertWI_' + createdAvatar, 'true');
      const embeddedDetected = worldModule.checkEmbeddedWorld(embeddedCharacterId);
      await worldModule.importEmbeddedWorldInfo(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const embeddedGetResponse = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ name: embeddedBookName }),
      });
      const embeddedWorld = embeddedGetResponse.ok ? await embeddedGetResponse.json() : null;
      const embeddedSettingsResponse = await fetch('/api/settings/get', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({}),
      });
      const embeddedSettings = embeddedSettingsResponse.ok
        ? await embeddedSettingsResponse.json()
        : null;
      const embeddedDeleteOk = (await worldModule.deleteWorldInfo(embeddedBookName)) !== false;

      return {
        createdAvatar,
        createOk: createResponse.ok,
        listAfterCreateHasCard: listAfterCreate.some((character) => character.avatar === createdAvatar),
        legacyListDomHasCard: Boolean(listCard),
        legacyListImageUsesThumbnail: listCardImage?.getAttribute('src')?.startsWith('/thumbnail?type=avatar&file=') ?? false,
        thumbnailOk: thumbnailResponse?.ok ?? false,
        thumbnailAssetSource: thumbnailResponse?.headers.get('X-Pure-Tavern-Asset') ?? null,
        directAvatarOk: directAvatarResponse?.ok ?? false,
        directAvatarAssetSource: directAvatarResponse?.headers.get('X-Pure-Tavern-Asset') ?? null,
        editOk: editResponse.ok,
        editedDescription: getAfterEdit?.description ?? null,
        editedChat: getAfterEdit?.chat ?? null,
        embeddedWorld: {
          detected: embeddedDetected,
          imported:
            embeddedGetResponse.ok &&
            embeddedSettings?.world_names?.includes(embeddedBookName) === true,
          content: embeddedWorld?.entries?.['0']?.content ?? null,
          opaqueFieldKept:
            embeddedWorld?.entries?.['0']?.extensions?.future_embedded_field?.kept === true,
          deleteOk: embeddedDeleteOk,
        },
        routesHandled: {
          create: routeHandled('/api/characters/create'),
          all: routeHandled('/api/characters/all'),
          get: routeHandled('/api/characters/get'),
          edit: routeHandled('/api/characters/edit'),
        },
        serviceWorkerController: Boolean(navigator.serviceWorker?.controller),
        storage: globalThis.__PURE_TAVERN__?.features?.characters?.storage
          ? { ...globalThis.__PURE_TAVERN__.features.characters.storage }
          : null,
        assets: globalThis.__PURE_TAVERN__?.features?.characters?.assets
          ? { ...globalThis.__PURE_TAVERN__.features.characters.assets }
          : null,
        service: globalThis.__PURE_TAVERN__?.features?.characters?.service
          ? { ...globalThis.__PURE_TAVERN__.features.characters.service }
          : null,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const characterCreateEdit = characterCreateEditEvaluation.result?.value;

  const personaCreateEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const scriptModule = await import('/script.js');
      const personaModule = await import('/scripts/personas.js');
      const headers = scriptModule.getRequestHeaders();
      const formHeaders = scriptModule.getRequestHeaders({ omitContentType: true });
      const createdAvatar = ${JSON.stringify(characterCreateEdit?.createdAvatar ?? '')};
      const pngBytes = Uint8Array.from(
        atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='),
        (character) => character.charCodeAt(0),
      );
      const avatarForm = new FormData();
      avatarForm.append(
        'avatar',
        new File([pngBytes], 'browser-persona.png', { type: 'image/png' }),
      );
      const uploadResponse = await fetch('/api/avatars/upload', {
        method: 'POST',
        headers: formHeaders,
        body: avatarForm,
      });
      const upload = uploadResponse.ok ? await uploadResponse.json() : null;
      const personaAlias = upload?.path ?? '';

      await personaModule.initPersona(
        personaAlias,
        'Browser Persona',
        'Browser Persona description',
        'Browser Persona title',
        { silent: true, depth: 3, role: 0 },
      );
      await personaModule.setUserAvatar(personaAlias, {
        toastPersonaNameChange: false,
        navigateToCurrent: true,
      });
      if (!personaModule.isPersonaLocked('default')) {
        await personaModule.setPersonaLockState(true, 'default');
      }
      await scriptModule.getCharacters();
      const characterId = scriptModule.characters.findIndex(
        (character) => character.avatar === createdAvatar,
      );
      if (characterId >= 0) await scriptModule.selectCharacterById(characterId);
      if (!personaModule.isPersonaLocked('character')) {
        await personaModule.setPersonaLockState(true, 'character');
      }
      const defaultLockedAfterCall = personaModule.isPersonaLocked('default');
      const characterLockedAfterCall = personaModule.isPersonaLocked('character');
      await scriptModule.saveSettings();
      await personaModule.getUserAvatars(true, personaAlias);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const settingsResponse = await fetch('/api/settings/get', {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      const settingsPayload = settingsResponse.ok ? await settingsResponse.json() : null;
      const persisted = settingsPayload ? JSON.parse(settingsPayload.settings) : null;
      const descriptor = persisted?.power_user?.persona_descriptions?.[personaAlias];
      const thumbnailResponse = personaAlias
        ? await fetch(
            '/thumbnail?type=persona&file=' + encodeURIComponent(personaAlias) + '&t=' + Date.now(),
            { cache: 'reload' },
          )
        : null;
      const card = [...document.querySelectorAll('#user_avatar_block .avatar-container')].find(
        (element) => element.getAttribute('data-avatar-id') === personaAlias,
      );

      return {
        available: true,
        personaAlias,
        uploadOk: uploadResponse.ok && Boolean(personaAlias),
        selected: personaModule.user_avatar === personaAlias,
        defaultLockedAfterCall,
        characterLockedAfterCall,
        defaultPersona: persisted?.power_user?.default_persona === personaAlias,
        persistedName: persisted?.power_user?.personas?.[personaAlias] ?? null,
        persistedDescription: descriptor?.description ?? null,
        persistedDepth: descriptor?.depth ?? null,
        currentConnection: personaModule.getCurrentConnectionObj(),
        connectedAfterCall: personaModule
          .getConnectedPersonas(createdAvatar)
          .map((persona) => persona.avatar),
        persistedConnections: descriptor?.connections ?? [],
        characterBound:
          descriptor?.connections?.some(
            (connection) => connection.type === 'character' && connection.id === createdAvatar,
          ) === true,
        legacyCardVisible: Boolean(card),
        thumbnailSource: thumbnailResponse?.headers.get('X-Pure-Tavern-Asset') ?? null,
        storage: globalThis.__PURE_TAVERN__?.features?.personas?.storage
          ? { ...globalThis.__PURE_TAVERN__.features.personas.storage }
          : null,
        service: globalThis.__PURE_TAVERN__?.features?.personas?.service
          ? { ...globalThis.__PURE_TAVERN__.features.personas.service }
          : null,
        assets: globalThis.__PURE_TAVERN__?.features?.personas?.assets
          ? { ...globalThis.__PURE_TAVERN__.features.personas.assets }
          : null,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const personaCreate = personaCreateEvaluation.result?.value;

  await client.send('Page.navigate', { url: appUrl });
  snapshot = await waitForApplicationSnapshot();

  const personaReloadEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const personaModule = await import('/scripts/personas.js');
      const scriptModule = await import('/script.js');
      const expectedAlias = ${JSON.stringify(personaCreate?.personaAlias ?? '')};
      const avatars = await personaModule.getUserAvatars(false);
      const response = await fetch('/api/settings/get', {
        method: 'POST',
        headers: scriptModule.getRequestHeaders(),
        body: JSON.stringify({}),
      });
      const payload = response.ok ? await response.json() : null;
      const settings = payload ? JSON.parse(payload.settings) : null;
      return {
        avatarListed: avatars.includes(expectedAlias),
        selectedAfterReload: personaModule.user_avatar === expectedAlias,
        defaultAfterReload: settings?.power_user?.default_persona === expectedAlias,
        descriptorAfterReload:
          settings?.power_user?.persona_descriptions?.[expectedAlias]?.description ?? null,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const personaReload = personaReloadEvaluation.result?.value;
  const personaWorkflow = { ...(personaCreate ?? {}), ...(personaReload ?? {}) };

  const chatCreateEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const scriptModule = await import('/script.js');
      const jsonHeaders = scriptModule.getRequestHeaders();
      const createdAvatar = ${JSON.stringify(characterCreateEdit?.createdAvatar ?? '')};
      const attachmentUrl = ${JSON.stringify(assetsWorkflow?.attachment?.url ?? '')};
      const routeHandled = (pathname) =>
        globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
          (request) => request.pathname === pathname && request.handled,
        ) ?? false;
      const postJson = (pathname, body) => fetch(pathname, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
        cache: 'no-cache',
      });

      await scriptModule.getCharacters();
      const characterId = scriptModule.characters.findIndex((character) => character.avatar === createdAvatar);
      if (characterId < 0) return { available: false, error: 'Created character was not found.' };
      await scriptModule.selectCharacterById(characterId);
      await delay(250);
      const mainChatName = scriptModule.characters[scriptModule.this_chid]?.chat;
      const greetingSaved = scriptModule.chat.some((message) => message.mes === 'Edited first message.');

      await scriptModule.sendMessageAsUser('Browser local user message');
      await scriptModule.saveChat({
        withMetadata: {
          browser_marker: 'persisted',
          attachments: attachmentUrl
            ? [{ url: attachmentUrl, name: 'browser-attachment.txt', size: 23 }]
            : [],
        },
      });
      const localMessageSaved = scriptModule.chat.some(
        (message) => message.is_user && message.mes === 'Browser local user message',
      );

      await scriptModule.openCharacterChat('Browser second');
      await delay(100);
      const secondChatSaved = scriptModule.chat.some((message) => message.mes === 'Edited first message.');
      await scriptModule.displayPastChats();
      await delay(250);
      const manageChatFilesCount = document.querySelectorAll(
        '#select_chat_div .select_chat_block_wrapper',
      ).length;

      const searchResponse = await postJson('/api/chats/search', {
        query: 'Browser local user message',
        avatar_url: createdAvatar,
        group_id: null,
      });
      const searchResults = searchResponse.ok ? await searchResponse.json() : [];
      const renameResponse = await postJson('/api/chats/rename', {
        is_group: false,
        avatar_url: createdAvatar,
        original_file: 'Browser second.jsonl',
        renamed_file: 'Browser second renamed.jsonl',
      });
      const renameData = renameResponse.ok ? await renameResponse.json() : null;

      const exportJsonlResponse = await postJson('/api/chats/export', {
        is_group: false,
        avatar_url: createdAvatar,
        file: mainChatName + '.jsonl',
        exportfilename: 'browser-main.jsonl',
        format: 'jsonl',
      });
      const exportJsonlData = exportJsonlResponse.ok ? await exportJsonlResponse.json() : null;
      const exportTxtResponse = await postJson('/api/chats/export', {
        is_group: false,
        avatar_url: createdAvatar,
        file: mainChatName + '.jsonl',
        exportfilename: 'browser-main.txt',
        format: 'txt',
      });
      const exportTxtData = exportTxtResponse.ok ? await exportTxtResponse.json() : null;

      const importForm = new FormData();
      importForm.append('file_type', 'jsonl');
      importForm.append('avatar_url', createdAvatar);
      importForm.append('character_name', 'Browser Alice');
      importForm.append('user_name', 'User');
      importForm.append(
        'file',
        new File([exportJsonlData?.result ?? ''], 'browser-main.jsonl', {
          type: 'application/jsonl',
        }),
      );
      const importedFileNames = exportJsonlData?.result
        ? await scriptModule.importCharacterChat(importForm, { refresh: true })
        : [];
      const importedFileName = importedFileNames[0] ?? '';
      const importedListResponse = await postJson('/api/characters/chats', {
        avatar_url: createdAvatar,
        simple: true,
      });
      const importedList = importedListResponse.ok ? await importedListResponse.json() : [];
      const importedVisible = importedList.some((chat) => chat.file_name === importedFileName);
      if (importedFileName) {
        await scriptModule.openCharacterChat(importedFileName.replace(/\\.jsonl$/i, ''));
      }
      const importedLoadOk = scriptModule.chat.some(
        (message) => message.is_user && message.mes === 'Browser local user message',
      );

      const deleteResponse = await postJson('/api/chats/delete', {
        avatar_url: createdAvatar,
        chatfile: 'Browser second renamed.jsonl',
      });
      await scriptModule.openCharacterChat(mainChatName);
      const switchedToRemaining =
        scriptModule.characters[scriptModule.this_chid]?.chat === mainChatName &&
        scriptModule.chat.some((message) => message.mes === 'Browser local user message');
      const recentResponse = await postJson('/api/chats/recent', {
        max: 10,
        pinned: [{ avatar: createdAvatar, file_name: mainChatName + '.jsonl' }],
      });
      const recent = recentResponse.ok ? await recentResponse.json() : [];

      const statsModule = await import('/scripts/stats.js');
      await statsModule.getStats();
      const statsCountBefore = Number(statsModule.charStats?.[createdAvatar]?.user_msg_count ?? 0);
      await statsModule.statMesProcess(
        {
          is_user: true,
          mes: 'Browser incremental stats marker',
          send_date: '2026-07-24T00:00:00.000Z',
        },
        'user',
        scriptModule.characters,
        scriptModule.this_chid,
        '',
      );
      await delay(150);
      await statsModule.getStats();
      const statsCountAfter = Number(statsModule.charStats?.[createdAvatar]?.user_msg_count ?? 0);

      return {
        available: true,
        mainChatName,
        greetingSaved,
        localMessageSaved,
        secondChatSaved,
        manageChatFilesCount,
        searchOk: searchResponse.ok && searchResults.some((chat) => chat.file_name === mainChatName),
        renameOk: renameResponse.ok && renameData?.sanitizedFileName === 'Browser second renamed',
        exportJsonlOk:
          exportJsonlResponse.ok &&
          typeof exportJsonlData?.result === 'string' &&
          exportJsonlData.result.includes('Browser local user message'),
        exportTxtOk:
          exportTxtResponse.ok &&
          typeof exportTxtData?.result === 'string' &&
          exportTxtData.result.includes('Browser local user message'),
        importedFileName,
        importedVisible,
        importedLoadOk,
        deleteOk: deleteResponse.ok,
        switchedToRemaining,
        recentOk:
          recentResponse.ok &&
          recent[0]?.avatar === createdAvatar &&
          recent[0]?.file_name === mainChatName + '.jsonl',
        metadataBeforeReload: scriptModule.chat_metadata?.browser_marker ?? null,
        statsSeed: {
          avatar: createdAvatar,
          countBefore: statsCountBefore,
          countAfter: statsCountAfter,
          incrementalUpdateOk: statsCountAfter === statsCountBefore + 1,
        },
        routesHandled: {
          get: routeHandled('/api/chats/get'),
          save: routeHandled('/api/chats/save'),
          list: routeHandled('/api/characters/chats'),
          search: routeHandled('/api/chats/search'),
          rename: routeHandled('/api/chats/rename'),
          export: routeHandled('/api/chats/export'),
          import: routeHandled('/api/chats/import'),
          delete: routeHandled('/api/chats/delete'),
          recent: routeHandled('/api/chats/recent'),
        },
        storage: globalThis.__PURE_TAVERN__?.features?.chats?.storage
          ? { ...globalThis.__PURE_TAVERN__.features.chats.storage }
          : null,
        messages: globalThis.__PURE_TAVERN__?.features?.chats?.messages
          ? { ...globalThis.__PURE_TAVERN__.features.chats.messages }
          : null,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const chatCreate = chatCreateEvaluation.result?.value;

  await client.send('Page.navigate', { url: appUrl });
  snapshot = await waitForApplicationSnapshot();

  const chatPostReloadEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const scriptModule = await import('/script.js');
      const createdAvatar = ${JSON.stringify(characterCreateEdit?.createdAvatar ?? '')};
      const expectedMainChatName = ${JSON.stringify(chatCreate?.mainChatName ?? '')};
      const jsonHeaders = scriptModule.getRequestHeaders();
      const formHeaders = scriptModule.getRequestHeaders({ omitContentType: true });
      const postJson = (pathname, body) => fetch(pathname, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
        cache: 'no-cache',
      });

      await scriptModule.getCharacters();
      const characterId = scriptModule.characters.findIndex((character) => character.avatar === createdAvatar);
      if (characterId < 0) return { available: false, error: 'Character missing after reload.' };
      await scriptModule.selectCharacterById(characterId);
      const messageRestored = scriptModule.chat.some(
        (message) => message.is_user && message.mes === 'Browser local user message',
      );
      const metadataRestored = scriptModule.chat_metadata?.browser_marker === 'persisted';
      const attachmentUrl = scriptModule.chat_metadata?.attachments?.[0]?.url ?? '';
      const chatsModule = await import('/scripts/chats.js');
      const attachmentRestored = attachmentUrl === ${JSON.stringify(assetsWorkflow?.attachment?.url ?? '')};
      const attachmentText = attachmentUrl ? await chatsModule.getFileAttachment(attachmentUrl) : null;
      const attachmentDeleteOk = attachmentUrl
        ? await chatsModule.deleteFileFromServer(attachmentUrl, false)
        : false;

      const renameCharacterOk = await scriptModule.renameCharacter('Browser Alice Chat Renamed', {
        silent: true,
        renameChats: false,
      });
      const renamedCharacter = scriptModule.characters.find(
        (character) => character.name === 'Browser Alice Chat Renamed',
      );
      const renamedAvatar = renamedCharacter?.avatar ?? '';
      const renamedGetResponse = renamedAvatar
        ? await postJson('/api/chats/get', {
            ch_name: 'Browser Alice Chat Renamed',
            file_name: expectedMainChatName,
            avatar_url: renamedAvatar,
          })
        : null;
      const renamedDocument = renamedGetResponse?.ok ? await renamedGetResponse.json() : [];
      const renamePreservedChat = renamedDocument.some(
        (message) => message.is_user && message.mes === 'Browser local user message',
      );

      const keepForm = new FormData();
      keepForm.append('ch_name', 'Browser Keep Chats');
      keepForm.append('first_mes', 'Keep greeting');
      keepForm.append('json_data', '{}');
      const keepCreateResponse = await fetch('/api/characters/create', {
        method: 'POST',
        headers: formHeaders,
        body: keepForm,
      });
      const keepAvatar = keepCreateResponse.ok ? await keepCreateResponse.text() : '';
      if (keepAvatar) {
        await postJson('/api/chats/save', {
          ch_name: 'Browser Keep Chats',
          file_name: 'kept-chat',
          avatar_url: keepAvatar,
          chat: [
            { chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
            { name: 'Browser Keep Chats', is_user: false, mes: 'kept', extra: {} },
          ],
        });
      }
      const keepDeleteResponse = keepAvatar
        ? await postJson('/api/characters/delete', { avatar_url: keepAvatar, delete_chats: false })
        : null;
      const keptChatsResponse = keepAvatar
        ? await postJson('/api/characters/chats', { avatar_url: keepAvatar, simple: true })
        : null;
      const keptChats = keptChatsResponse?.ok ? await keptChatsResponse.json() : [];
      if (keepAvatar) {
        await postJson('/api/chats/delete', { avatar_url: keepAvatar, chatfile: 'kept-chat.jsonl' });
      }

      return {
        available: true,
        messageRestored,
        metadataRestored,
        attachmentRestored,
        attachmentText,
        attachmentDeleteOk,
        renameCharacterOk,
        renamedAvatar,
        renamePreservedChat,
        keepChatsFalseOk:
          keepCreateResponse.ok &&
          keepDeleteResponse?.ok === true &&
          keptChats.some((chat) => chat.file_name === 'kept-chat.jsonl'),
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const chatPostReload = chatPostReloadEvaluation.result?.value;
  const chatWorkflow = { ...(chatCreate ?? {}), ...(chatPostReload ?? {}) };

  const statsWorkflowEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const scriptModule = await import('/script.js');
      const statsModule = await import('/scripts/stats.js');
      const headers = scriptModule.getRequestHeaders();
      const oldAvatar = ${JSON.stringify(chatCreate?.statsSeed?.avatar ?? '')};
      const currentAvatar = ${JSON.stringify(chatPostReload?.renamedAvatar ?? '')};
      const expectedPersistedCount = ${JSON.stringify(chatCreate?.statsSeed?.countAfter ?? null)};
      const routeHandled = (pathname) =>
        globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
          (request) => request.pathname === pathname && request.handled,
        ) ?? false;

      await statsModule.getStats();
      const persistedCount = Number(statsModule.charStats?.[oldAvatar]?.user_msg_count ?? -1);
      const updateResponse = await fetch('/api/stats/update', {
        method: 'POST',
        headers,
        body: JSON.stringify(statsModule.charStats),
      });
      const recreateResponse = await fetch('/api/stats/recreate', {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
        cache: 'no-cache',
      });
      await statsModule.getStats();
      const rebuilt = statsModule.charStats?.[currentAvatar] ?? null;

      await scriptModule.getCharacters();
      const characterId = scriptModule.characters.findIndex(
        (character) => character.avatar === currentAvatar,
      );
      let characterPopupBlocks = 0;
      let userPopupBlocks = 0;
      if (characterId >= 0) {
        await statsModule.characterStatsHandler(scriptModule.characters, characterId);
        await delay(150);
        const characterPopup = [...document.querySelectorAll('dialog.popup[open]')].at(-1);
        characterPopupBlocks = characterPopup?.querySelectorAll('.rm_stat_block').length ?? 0;
        characterPopup?.querySelector('.popup-button-close')?.click();
        await delay(100);
        await statsModule.userStatsHandler();
        await delay(150);
        const userPopup = [...document.querySelectorAll('dialog.popup[open]')].at(-1);
        userPopupBlocks = userPopup?.querySelectorAll('.rm_stat_block').length ?? 0;
        for (const closeButton of document.querySelectorAll(
          'dialog.popup[open] .popup-button-close',
        )) {
          closeButton.click();
        }
      }

      const feature = globalThis.__PURE_TAVERN__?.features?.stats;
      return {
        available: true,
        persistedAcrossReload:
          expectedPersistedCount !== null && persistedCount === Number(expectedPersistedCount),
        updateOk: updateResponse.ok,
        recreateOk: recreateResponse.ok,
        currentAvatar,
        rebuilt: rebuilt
          ? {
              userMessages: rebuilt.user_msg_count,
              characterMessages: rebuilt.non_user_msg_count,
              userWords: rebuilt.user_word_count,
              characterWords: rebuilt.non_user_word_count,
              chatSize: rebuilt.chat_size,
              firstChat: rebuilt.date_first_chat,
              lastChat: rebuilt.date_last_chat,
            }
          : null,
        characterPopupBlocks,
        userPopupBlocks,
        storage: feature?.storage ? { ...feature.storage } : null,
        chatSource: feature?.chatSource ? { ...feature.chatSource } : null,
        consistency: feature?.consistency ? { ...feature.consistency } : null,
        routesHandled: {
          get: routeHandled('/api/stats/get'),
          update: routeHandled('/api/stats/update'),
          recreate: routeHandled('/api/stats/recreate'),
        },
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const statsWorkflow = statsWorkflowEvaluation.result?.value;

  const dataManagementPreEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const waitFor = async (read, timeout = 10_000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const value = read();
          if (value) return value;
          await delay(50);
        }
        return null;
      };
      const headers = { 'Content-Type': 'application/json' };
      const post = (pathname, body = {}) => fetch(pathname, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        cache: 'no-cache',
      });
      const routeHandled = (pathname) =>
        globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
          (request) => request.pathname === pathname && request.handled,
        ) ?? false;

      const dataManagementRuntime = await waitFor(
        () => globalThis.__PURE_TAVERN_DATA_MANAGEMENT__,
      );
      dataManagementRuntime?.open();
      await waitFor(() => document.querySelectorAll('#ptdm-modules input[data-module]').length >= 10);
      const panel = document.querySelector('#pure-tavern-data-management-dialog');
      const panelOpen = panel?.open === true;
      const panelModuleRows = document.querySelectorAll('#ptdm-modules input[data-module]').length;

      const inspectResponse = await post('/api/backups/archive/inspect');
      const inspection = inspectResponse.ok ? await inspectResponse.json() : null;
      const exportResponse = await post('/api/backups/archive/export');
      const exportBlob = exportResponse.ok ? await exportResponse.blob() : null;
      const previewForm = new FormData();
      if (exportBlob) {
        previewForm.set('file', new File([exportBlob], 'browser-full-backup.zip', {
          type: 'application/zip',
        }));
        previewForm.set('strategy', 'merge');
        previewForm.set('includeSecrets', 'false');
      }
      const previewResponse = exportBlob
        ? await fetch('/api/backups/archive/import/preview', {
            method: 'POST',
            body: previewForm,
          })
        : null;
      const preview = previewResponse?.ok ? await previewResponse.json() : null;
      const importForm = new FormData();
      if (exportBlob) {
        importForm.set('file', new File([exportBlob], 'browser-full-backup.zip', {
          type: 'application/zip',
        }));
        importForm.set('strategy', 'skip');
        importForm.set('includeSecrets', 'false');
        importForm.set('createRecoveryPoint', 'false');
      }
      const importResponse = exportBlob
        ? await fetch('/api/backups/archive/import', { method: 'POST', body: importForm })
        : null;
      const importReport = importResponse?.ok ? await importResponse.json() : null;

      const secretsExportResponse = await post('/api/backups/archive/export', {
        includeSecrets: true,
      });
      const secretsExportBlob = secretsExportResponse.ok
        ? await secretsExportResponse.blob()
        : null;
      const secretsPreviewForm = new FormData();
      if (secretsExportBlob) {
        secretsPreviewForm.set(
          'file',
          new File([secretsExportBlob], 'browser-secrets-backup.zip', {
            type: 'application/zip',
          }),
        );
        secretsPreviewForm.set('strategy', 'merge');
        secretsPreviewForm.set('includeSecrets', 'true');
      }
      const secretsPreviewResponse = secretsExportBlob
        ? await fetch('/api/backups/archive/import/preview', {
            method: 'POST',
            body: secretsPreviewForm,
          })
        : null;
      const secretsPreview = secretsPreviewResponse?.ok
        ? await secretsPreviewResponse.json()
        : null;

      const createResponse = await post('/api/backups/archive/local/create', {
        label: 'Browser full recovery point',
      });
      const createdBackup = createResponse.ok ? await createResponse.json() : null;
      const listResponse = await post('/api/backups/archive/local/list');
      const backups = listResponse.ok ? await listResponse.json() : [];
      const downloadResponse = createdBackup?.id
        ? await post('/api/backups/archive/local/download', { id: createdBackup.id })
        : null;
      const downloadedBlob = downloadResponse?.ok ? await downloadResponse.blob() : null;
      panel?.close();

      const feature = globalThis.__PURE_TAVERN__?.features?.['import-export'];
      return {
        available: true,
        panelOpen,
        panelModuleRows,
        inspectionModuleCount: inspection?.modules?.length ?? 0,
        inspectionHasSensitiveSecrets:
          inspection?.modules?.some(
            (module) => module.moduleId === 'secrets' && module.sensitive === true,
          ) === true,
        participantCount: feature?.participants?.count ?? 0,
        participantModuleIds: feature?.participants?.moduleIds ?? [],
        storage: feature?.storage ? { ...feature.storage } : null,
        transport: feature?.backupTransport ? { ...feature.backupTransport } : null,
        optionalBackend: feature?.optionalBackend ? { ...feature.optionalBackend } : null,
        exportOk: exportResponse.ok,
        exportBytes: exportBlob?.size ?? 0,
        defaultSecretsExcluded:
          preview?.manifest?.includeSecrets === false &&
          !preview?.manifest?.modules?.some((module) => module.moduleId === 'secrets'),
        hashCount: preview?.manifest?.files?.filter(
          (file) => /^[a-f0-9]{64}$/i.test(file.sha256),
        ).length ?? 0,
        fileCount: preview?.manifest?.files?.length ?? 0,
        previewModuleCount: preview?.modules?.length ?? 0,
        dryImportOk:
          importResponse?.ok === true &&
          importReport?.strategy === 'skip' &&
          importReport?.modules?.every((module) => module.errors.length === 0),
        explicitSecretsIncluded:
          secretsPreview?.manifest?.includeSecrets === true &&
          secretsPreview?.manifest?.modules?.some((module) => module.moduleId === 'secrets'),
        backupId: createdBackup?.id ?? null,
        backupListed: backups.some((backup) => backup.id === createdBackup?.id),
        backupDownloaded:
          downloadedBlob?.size === createdBackup?.size && downloadedBlob?.size > 0,
        routesHandled: {
          inspect: routeHandled('/api/backups/archive/inspect'),
          export: routeHandled('/api/backups/archive/export'),
          preview: routeHandled('/api/backups/archive/import/preview'),
          import: routeHandled('/api/backups/archive/import'),
          create: routeHandled('/api/backups/archive/local/create'),
          list: routeHandled('/api/backups/archive/local/list'),
          download: routeHandled('/api/backups/archive/local/download'),
        },
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const dataManagementPre = dataManagementPreEvaluation.result?.value;

  const characterPostReloadEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const createdAvatar = ${JSON.stringify(chatPostReload?.renamedAvatar ?? characterCreateEdit?.createdAvatar ?? '')};
      const mockProviderBaseUrl = ${JSON.stringify(mockProvider.baseUrl)};
      const scriptModule = await import('/script.js');
      const jsonHeaders = scriptModule.getRequestHeaders();
      const formHeaders = scriptModule.getRequestHeaders({ omitContentType: true });
      const routeHandled = (pathname) =>
        globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
          (request) => request.pathname === pathname && request.handled,
        ) ?? false;
      const postJson = (pathname, body) => fetch(pathname, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
        cache: 'no-cache',
      });

      const getAfterReloadResponse = createdAvatar
        ? await postJson('/api/characters/get', { avatar_url: createdAvatar })
        : null;
      const getAfterReload = getAfterReloadResponse?.ok ? await getAfterReloadResponse.json() : null;

      const duplicateResponse = createdAvatar
        ? await postJson('/api/characters/duplicate', { avatar_url: createdAvatar })
        : null;
      const duplicateData = duplicateResponse?.ok ? await duplicateResponse.json() : null;
      const duplicateAvatar = duplicateData?.path ?? '';

      const renameResponse = duplicateAvatar
        ? await postJson('/api/characters/rename', {
            avatar_url: duplicateAvatar,
            new_name: 'Browser Alice Renamed',
          })
        : null;
      const renameData = renameResponse?.ok ? await renameResponse.json() : null;
      const renamedAvatar = renameData?.avatar ?? '';

      const exportJsonResponse = createdAvatar
        ? await postJson('/api/characters/export', { avatar_url: createdAvatar, format: 'json' })
        : null;
      const exportJsonText = exportJsonResponse?.ok ? await exportJsonResponse.text() : '';
      let exportJsonName = null;
      let exportJsonHasNoChat = false;
      try {
        const exported = JSON.parse(exportJsonText || '{}');
        exportJsonName = exported?.data?.name ?? exported?.name ?? null;
        exportJsonHasNoChat = !Object.prototype.hasOwnProperty.call(exported, 'chat');
      } catch {
        exportJsonName = null;
      }

      const exportPngResponse = createdAvatar
        ? await postJson('/api/characters/export', { avatar_url: createdAvatar, format: 'png' })
        : null;
      const exportPngBlob = exportPngResponse?.ok ? await exportPngResponse.blob() : null;
      const exportPngHeader = exportPngBlob
        ? Array.from(new Uint8Array(await exportPngBlob.slice(0, 8).arrayBuffer()))
        : [];

      let externalCardUploadOk = false;
      let externalUrlImportError = null;
      let externalUrlImportedAvatars = [];
      if (exportPngBlob) {
        const uploadResponse = await fetch(mockProviderBaseUrl + '/browser-character-card-control', {
          method: 'POST',
          body: exportPngBlob,
        });
        externalCardUploadOk = uploadResponse.ok;
        if (externalCardUploadOk) {
          const beforeResponse = await postJson('/api/characters/all', {});
          const before = beforeResponse.ok ? await beforeResponse.json() : [];
          const beforeAvatars = new Set(before.map((character) => character.avatar));
          try {
            const utilsModule = await import('/scripts/utils.js');
            await utilsModule.importFromExternalUrl(
              mockProviderBaseUrl + '/attachments/browser/channel/14.png?ex=browser&hm=character-card',
            );
          } catch (error) {
            externalUrlImportError = error instanceof Error ? error.message : String(error);
          }
          const afterResponse = await postJson('/api/characters/all', {});
          const after = afterResponse.ok ? await afterResponse.json() : [];
          externalUrlImportedAvatars = after
            .map((character) => character.avatar)
            .filter((avatar) => avatar && !beforeAvatars.has(avatar));
        }
      }

      const importJsonForm = new FormData();
      importJsonForm.append('avatar', new File([exportJsonText], 'browser-alice.json', { type: 'application/json' }));
      importJsonForm.append('file_type', 'json');
      const importJsonResponse = exportJsonText
        ? await fetch('/api/characters/import', {
            method: 'POST',
            headers: formHeaders,
            body: importJsonForm,
            cache: 'no-cache',
          })
        : null;
      const importJsonData = importJsonResponse?.ok ? await importJsonResponse.json() : null;

      const importPngForm = new FormData();
      if (exportPngBlob) {
        importPngForm.append('avatar', new File([exportPngBlob], 'browser-alice.png', { type: 'image/png' }));
        importPngForm.append('file_type', 'png');
      }
      const importPngResponse = exportPngBlob
        ? await fetch('/api/characters/import', {
            method: 'POST',
            headers: formHeaders,
            body: importPngForm,
            cache: 'no-cache',
          })
        : null;
      const importPngData = importPngResponse?.ok ? await importPngResponse.json() : null;

      const avatarsToDelete = [
        createdAvatar,
        renamedAvatar,
        importJsonData?.file_name ? importJsonData.file_name + '.png' : '',
        importPngData?.file_name ? importPngData.file_name + '.png' : '',
        ...externalUrlImportedAvatars,
      ].filter(Boolean);
      const deleteResults = [];
      for (const avatar of avatarsToDelete) {
        const response = await postJson('/api/characters/delete', { avatar_url: avatar, delete_chats: true });
        deleteResults.push({ avatar, ok: response.ok });
      }
      const chatsAfterDeleteResponse = createdAvatar
        ? await postJson('/api/characters/chats', { avatar_url: createdAvatar, simple: true })
        : null;
      const chatsAfterDelete = chatsAfterDeleteResponse?.ok
        ? await chatsAfterDeleteResponse.json()
        : null;
      const listAfterDeleteResponse = await postJson('/api/characters/all', {});
      const listAfterDelete = listAfterDeleteResponse.ok ? await listAfterDeleteResponse.json() : [];

      return {
        getAfterReloadOk: getAfterReloadResponse?.ok ?? false,
        reloadedDescription: getAfterReload?.description ?? null,
        reloadedChat: getAfterReload?.chat ?? null,
        duplicateOk: duplicateResponse?.ok ?? false,
        duplicateAvatar,
        renameOk: renameResponse?.ok ?? false,
        renamedAvatar,
        exportJsonOk: exportJsonResponse?.ok ?? false,
        exportJsonName,
        exportJsonHasNoChat,
        exportPngOk: exportPngResponse?.ok ?? false,
        exportPngIsPng: JSON.stringify(exportPngHeader) === '[137,80,78,71,13,10,26,10]',
        importJsonOk: importJsonResponse?.ok ?? false,
        importJsonFileName: importJsonData?.file_name ?? null,
        importPngOk: importPngResponse?.ok ?? false,
        importPngFileName: importPngData?.file_name ?? null,
        externalCardUploadOk,
        externalUrlImportOk:
          externalCardUploadOk && !externalUrlImportError && externalUrlImportedAvatars.length > 0,
        externalUrlImportError,
        externalUrlImportedAvatars,
        deleteResults,
        deleteChatsTrueOk: Array.isArray(chatsAfterDelete) && chatsAfterDelete.length === 0,
        listAfterDeleteEmpty: listAfterDelete.length === 0,
        routesHandled: {
          duplicate: routeHandled('/api/characters/duplicate'),
          rename: routeHandled('/api/characters/rename'),
          export: routeHandled('/api/characters/export'),
          import: routeHandled('/api/characters/import'),
          externalUrlImport: routeHandled('/api/content/importURL'),
          delete: routeHandled('/api/characters/delete'),
        },
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const characterPostReload = characterPostReloadEvaluation.result?.value;
  const characterWorkflow = {
    ...(characterCreateEdit ?? {}),
    ...(characterPostReload ?? {}),
    routesHandled: {
      ...(characterCreateEdit?.routesHandled ?? {}),
      ...(characterPostReload?.routesHandled ?? {}),
    },
  };

  const personaDeleteEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const personaModule = await import('/scripts/personas.js');
      const scriptModule = await import('/script.js');
      const personaAlias = ${JSON.stringify(personaWorkflow?.personaAlias ?? '')};
      if (!personaAlias) return { deleteRequested: false, error: 'Persona alias is missing.' };
      await personaModule.setUserAvatar(personaAlias, { toastPersonaNameChange: false });
      const deleteButton = document.getElementById('persona_delete_button');
      deleteButton?.click();
      const deadline = Date.now() + 5_000;
      let confirmButton = null;
      while (!confirmButton && Date.now() < deadline) {
        const dialogs = [...document.querySelectorAll('.popup[open]')];
        confirmButton = dialogs.at(-1)?.querySelector('.popup-button-ok') ?? null;
        if (!confirmButton) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      confirmButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const avatars = await personaModule.getUserAvatars(false);
      const response = await fetch('/api/settings/get', {
        method: 'POST',
        headers: scriptModule.getRequestHeaders(),
        body: JSON.stringify({}),
      });
      const payload = response.ok ? await response.json() : null;
      const settings = payload ? JSON.parse(payload.settings) : null;
      return {
        deleteRequested: Boolean(deleteButton && confirmButton),
        avatarRemoved: !avatars.includes(personaAlias),
        metadataRemoved: !settings?.power_user?.personas?.[personaAlias],
        defaultCleared: settings?.power_user?.default_persona !== personaAlias,
        fallbackSelected: personaModule.user_avatar !== personaAlias,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const personaDelete = personaDeleteEvaluation.result?.value;
  Object.assign(personaWorkflow, personaDelete ?? {});

  const secretReloadEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const secretsModule = await import('/scripts/secrets.js');
      const key = ${JSON.stringify('api_key_openai')};
      const firstId = ${JSON.stringify(secretWorkflow?.firstId ?? '')};
      const secondId = ${JSON.stringify(secretWorkflow?.secondId ?? '')};
      await secretsModule.readSecretState();
      const stateAfterReload = secretsModule.secret_state[key] ?? [];
      const persisted =
        stateAfterReload.find((secret) => secret.id === firstId)?.label === 'Browser Primary' &&
        stateAfterReload.find((secret) => secret.id === firstId)?.active === true &&
        stateAfterReload.find((secret) => secret.id === secondId)?.active === false;

      await secretsModule.deleteSecret(key, firstId);
      const fallbackValue = await secretsModule.findSecret(key);
      const fallbackActivated =
        secretsModule.secret_state[key]?.find((secret) => secret.id === secondId)?.active === true;
      await secretsModule.deleteSecret(key, secondId);
      const deletedAll = secretsModule.secret_state[key] === null;
      const missingResponse = await fetch('/api/secrets/find', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });

      return {
        persisted,
        fallbackValue,
        fallbackActivated,
        deletedAll,
        missingStatus: missingResponse.status,
        deleteHandled:
          globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
            (request) => request.pathname === '/api/secrets/delete' && request.handled,
          ) ?? false,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  Object.assign(secretWorkflow, secretReloadEvaluation.result?.value ?? {});

  const dataManagementRestoreEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const backupId = ${JSON.stringify(dataManagementPre?.backupId ?? '')};
      const expectedAvatar = ${JSON.stringify(chatPostReload?.renamedAvatar ?? '')};
      const headers = { 'Content-Type': 'application/json' };
      const post = (pathname, body = {}) => fetch(pathname, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        cache: 'no-cache',
      });
      const beforeResponse = await post('/api/characters/all');
      const beforeCharacters = beforeResponse.ok ? await beforeResponse.json() : [];
      const restoreResponse = backupId
        ? await post('/api/backups/archive/local/restore', {
            id: backupId,
            strategy: 'replace-all',
            includeSecrets: false,
            createRecoveryPoint: true,
          })
        : null;
      const report = restoreResponse?.ok ? await restoreResponse.json() : null;
      return {
        beforeRestoreEmpty: beforeCharacters.length === 0,
        restoreOk:
          restoreResponse?.ok === true &&
          report?.modules?.every((module) => module.errors.length === 0),
        recoveryBackupCreated: typeof report?.recoveryBackupId === 'string',
        restoredModuleCount: report?.modules?.length ?? 0,
        expectedAvatar,
        restoreRouteHandled:
          globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
            (request) =>
              request.pathname === '/api/backups/archive/local/restore' && request.handled,
          ) ?? false,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const dataManagementRestore = dataManagementRestoreEvaluation.result?.value;

  await client.send('Page.navigate', { url: appUrl });
  snapshot = await waitForApplicationSnapshot();

  const dataManagementVerifyEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const backupId = ${JSON.stringify(dataManagementPre?.backupId ?? '')};
      const expectedAvatar = ${JSON.stringify(chatPostReload?.renamedAvatar ?? '')};
      const expectedChatName = ${JSON.stringify(chatWorkflow?.mainChatName ?? '')};
      const personaAlias = ${JSON.stringify(personaWorkflow?.personaAlias ?? '')};
      const headers = { 'Content-Type': 'application/json' };
      const post = (pathname, body = {}) => fetch(pathname, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        cache: 'no-cache',
      });
      const charactersResponse = await post('/api/characters/all');
      const characters = charactersResponse.ok ? await charactersResponse.json() : [];
      const chatsResponse = await post('/api/characters/chats', {
        avatar_url: expectedAvatar,
        simple: true,
      });
      const chats = chatsResponse.ok ? await chatsResponse.json() : [];
      const chatResponse = await post('/api/chats/get', {
        ch_name: 'Browser Alice Chat Renamed',
        file_name: expectedChatName,
        avatar_url: expectedAvatar,
      });
      const chat = chatResponse.ok ? await chatResponse.json() : [];
      const statsResponse = await post('/api/stats/get');
      const stats = statsResponse.ok ? await statsResponse.json() : null;
      const secretsResponse = await post('/api/secrets/read');
      const secrets = secretsResponse.ok ? await secretsResponse.json() : null;
      const personaModule = await import('/scripts/personas.js');
      const avatars = await personaModule.getUserAvatars(false);
      const inspectResponse = await post('/api/backups/archive/inspect');
      const inspection = inspectResponse.ok ? await inspectResponse.json() : null;
      const backupsResponse = await post('/api/backups/archive/local/list');
      const backups = backupsResponse.ok ? await backupsResponse.json() : [];
      const deleteResponse = backupId
        ? await post('/api/backups/archive/local/delete', { id: backupId })
        : null;
      const afterDeleteResponse = await post('/api/backups/archive/local/list');
      const afterDelete = afterDeleteResponse.ok ? await afterDeleteResponse.json() : [];
      return {
        characterRestored: characters.some((character) => character.avatar === expectedAvatar),
        chatListed: chats.some((item) => item.file_name === expectedChatName + '.jsonl'),
        chatRestored: chat.some(
          (message) => message.is_user && message.mes === 'Browser local user message',
        ),
        personaRestored: avatars.includes(personaAlias),
        statsRestored:
          stats?.[expectedAvatar]?.user_msg_count > 0 &&
          stats?.[expectedAvatar]?.non_user_msg_count > 0,
        secretsStayedExcluded: secrets?.api_key_openai === null,
        panelRestored: globalThis.__PURE_TAVERN_DATA_MANAGEMENT__?.installed === true,
        participantCountAfterReload:
          globalThis.__PURE_TAVERN__?.features?.['import-export']?.participants?.count ?? 0,
        backupCountAfterRestore: backups.length,
        recoveryBackupVisible: backups.some((backup) => backup.reason === 'pre-restore'),
        backupDeleteOk:
          deleteResponse?.ok === true && !afterDelete.some((backup) => backup.id === backupId),
        inspectionModuleCount: inspection?.modules?.length ?? 0,
        routesHandled: {
          inspect: globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
            (request) => request.pathname === '/api/backups/archive/inspect' && request.handled,
          ) ?? false,
          list: globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
            (request) => request.pathname === '/api/backups/archive/local/list' && request.handled,
          ) ?? false,
          delete: globalThis.__PURE_TAVERN__?.diagnostics.requests.some(
            (request) => request.pathname === '/api/backups/archive/local/delete' && request.handled,
          ) ?? false,
        },
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const dataManagementWorkflow = {
    ...(dataManagementPre ?? {}),
    ...(dataManagementRestore ?? {}),
    ...(dataManagementVerifyEvaluation.result?.value ?? {}),
    routesHandled: {
      ...(dataManagementPre?.routesHandled ?? {}),
      ...(dataManagementVerifyEvaluation.result?.value?.routesHandled ?? {}),
      restore: dataManagementRestore?.restoreRouteHandled === true,
    },
  };

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
    settingsStorageReady:
      snapshot?.settingsStorage?.status === 'ready' &&
      snapshot?.settingsStorage?.backend === 'indexeddb',
    settingsPersistedThroughLegacyUi:
      settingsPersistence?.available === true &&
      settingsPersistence?.valueAfterClick === settingsPersistence?.targetValue &&
      settingsPersistence?.savedValue === settingsPersistence?.targetValue &&
      settingsPersistence?.reloadedValue === settingsPersistence?.targetValue &&
      settingsPersistence?.saveRequestHandled === true,
    settingsSnapshotsReady:
      settingsSnapshotWorkflow?.storage?.status === 'ready' &&
      settingsSnapshotWorkflow?.storage?.backend === 'indexeddb',
    settingsSnapshotRestoredThroughLegacyUi:
      settingsSnapshotWorkflow?.available === true &&
      settingsSnapshotWorkflow?.snapshotCount >= 1 &&
      settingsSnapshotWorkflow?.previewValue === settingsPersistence?.targetValue &&
      settingsSnapshotWorkflow?.routesHandled?.list === true &&
      settingsSnapshotWorkflow?.routesHandled?.make === true &&
      settingsSnapshotWorkflow?.routesHandled?.load === true &&
      settingsSnapshotWorkflow?.valueAfterSnapshot === settingsPersistence?.initialValue &&
      settingsSnapshotWorkflow?.restoreRequested === true &&
      settingsSnapshotWorkflow?.restoredValue === settingsPersistence?.targetValue,
    charactersStorageReady:
      characterWorkflow?.storage?.status === 'ready' &&
      characterWorkflow?.storage?.backend === 'indexeddb' &&
      characterWorkflow?.assets?.status === 'ready' &&
      characterWorkflow?.assets?.backend === 'indexeddb',
    personasStorageReady:
      personaWorkflow?.storage?.status === 'ready' &&
      personaWorkflow?.storage?.backend === 'indexeddb' &&
      personaWorkflow?.assets?.status === 'configured',
    personaBrowserWorkflow:
      personaWorkflow?.available === true &&
      personaWorkflow?.uploadOk === true &&
      personaWorkflow?.selected === true &&
      personaWorkflow?.defaultLockedAfterCall === true &&
      personaWorkflow?.characterLockedAfterCall === true &&
      personaWorkflow?.defaultPersona === true &&
      personaWorkflow?.persistedName === 'Browser Persona' &&
      personaWorkflow?.persistedDescription === 'Browser Persona description' &&
      personaWorkflow?.persistedDepth === 3 &&
      personaWorkflow?.characterBound === true &&
      personaWorkflow?.legacyCardVisible === true &&
      personaWorkflow?.thumbnailSource === 'assets/user-avatars' &&
      personaWorkflow?.avatarListed === true &&
      personaWorkflow?.selectedAfterReload === true &&
      personaWorkflow?.defaultAfterReload === true &&
      personaWorkflow?.descriptorAfterReload === 'Browser Persona description' &&
      personaWorkflow?.deleteRequested === true &&
      personaWorkflow?.avatarRemoved === true &&
      personaWorkflow?.metadataRemoved === true &&
      personaWorkflow?.defaultCleared === true &&
      personaWorkflow?.fallbackSelected === true,
    extensionsStorageReady:
      extensionWorkflow?.registry?.status === 'ready' &&
      extensionWorkflow?.registry?.backend === 'records' &&
      extensionWorkflow?.trustedBuiltIns?.status === 'ready' &&
      extensionWorkflow?.trustedBuiltIns?.source === 'generated-manifest' &&
      extensionWorkflow?.trustedBuiltIns?.count === 15 &&
      extensionWorkflow?.localPackageAssetsInjected === true &&
      extensionWorkflow?.executionModel === 'legacy-same-context-user-approved' &&
      extensionWorkflow?.originalRiskWarningOwnedByLegacyUi === true,
    trustedExtensionsBrowserWorkflow:
      extensionWorkflow?.available === true &&
      extensionWorkflow?.discoveredCount === 15 &&
      extensionWorkflow?.originalRuntimeCount === 15 &&
      extensionWorkflow?.discoveredNames?.includes('regex') === true &&
      extensionWorkflow?.manifestLoaded === true &&
      extensionWorkflow?.regexScriptLoaded === true &&
      extensionWorkflow?.regexStyleLoaded === true &&
      extensionWorkflow?.dataManagementManifestLoaded === true &&
      extensionWorkflow?.dataManagementScriptLoaded === true &&
      extensionWorkflow?.dataManagementStyleLoaded === true &&
      extensionWorkflow?.dataManagementRuntimeInstalled === true &&
      extensionWorkflow?.versionOk === true &&
      extensionWorkflow?.disabledPersisted === true &&
      extensionWorkflow?.enabledPersisted === true,
    thirdPartyExtensionsBrowserWorkflow:
      extensionWorkflow?.warningShown === true &&
      extensionWorkflow?.installOk === true &&
      extensionWorkflow?.runtimeCountAfterInstall >= 16 &&
      extensionWorkflow?.thirdPartyManifestLoaded === true &&
      extensionWorkflow?.manifestAssetServed === true &&
      extensionWorkflow?.scriptAssetServed === true &&
      extensionWorkflow?.styleAssetServed === true &&
      extensionWorkflow?.dotFileAssetServed === true &&
      extensionWorkflow?.minimumClientVersionAccepted === true &&
      extensionWorkflow?.thirdPartyScriptLoaded === true &&
      extensionWorkflow?.thirdPartyStyleLoaded === true &&
      extensionWorkflow?.installHookCalled === true &&
      extensionWorkflow?.thirdPartyDisabled === true &&
      extensionWorkflow?.thirdPartyEnabled === true &&
      extensionWorkflow?.versionInitiallyCurrent === true &&
      extensionWorkflow?.branchCount >= 1 &&
      extensionWorkflow?.updateDetected === true &&
      extensionWorkflow?.updateOk === true &&
      extensionWorkflow?.updatedManifestVersion === '2.0.0' &&
      extensionWorkflow?.switchOk === true &&
      extensionWorkflow?.moveOk === true &&
      extensionWorkflow?.deleteHookCalled === true &&
      extensionWorkflow?.deleteOk === true &&
      Object.values(extensionWorkflow?.routesHandled ?? {}).every(Boolean),
    legacyPromptPipelineAuthoritative:
      generationWorkflow?.originalPrepareFunction === true &&
      generationWorkflow?.duplicatePromptFeatureAbsent === true,
    tokenizerWorkerReady:
      tokenizerWorkflow?.available === true &&
      tokenizerWorkflow?.engine?.status === 'ready' &&
      tokenizerWorkflow?.engine?.workerFailures === 0 &&
      tokenizerWorkflow?.workerRequested === true &&
      tokenizerWorkflow?.semantics === 'unified-approximate-tokenx' &&
      tokenizerWorkflow?.modelSpecific === false &&
      tokenizerWorkflow?.pseudoTokenIds === true,
    tokenizerBrowserWorkflow:
      tokenizerWorkflow?.allAliasCountsSame === true &&
      tokenizerWorkflow?.originalCountsSame === true &&
      tokenizerWorkflow?.pseudoDecodeRoundTrip === true &&
      tokenizerWorkflow?.openAiCount > 0 &&
      tokenizerWorkflow?.directOpenAiCount > 0 &&
      tokenizerWorkflow?.openAiApproximate === true &&
      tokenizerWorkflow?.remoteLocalCount === true &&
      Object.values(tokenizerWorkflow?.routesHandled ?? {}).every(Boolean),
    secretsStorageReady:
      secretWorkflow?.storage?.status === 'ready' &&
      secretWorkflow?.storage?.backend === 'indexeddb' &&
      secretWorkflow?.security?.atRest === 'plaintext' &&
      secretWorkflow?.security?.encrypted === false &&
      secretWorkflow?.security?.sameOriginSecurityBoundary === false,
    secretsBrowserWorkflow:
      secretWorkflow?.available === true &&
      secretWorkflow?.exposureAllowed === true &&
      secretWorkflow?.firstMasked === '*******123' &&
      secretWorkflow?.secondMasked === '*******456' &&
      secretWorkflow?.firstActive === true &&
      secretWorkflow?.firstRenamed === true &&
      secretWorkflow?.foundFirst === 'browser-secret-first-123' &&
      secretWorkflow?.viewedActive === 'browser-secret-first-123' &&
      secretWorkflow?.persisted === true &&
      secretWorkflow?.fallbackValue === 'browser-secret-second-456' &&
      secretWorkflow?.fallbackActivated === true &&
      secretWorkflow?.deletedAll === true &&
      secretWorkflow?.missingStatus === 404 &&
      secretWorkflow?.deleteHandled === true &&
      Object.values(secretWorkflow?.routesHandled ?? {}).every(Boolean),
    generationProvidersReady:
      generationWorkflow?.available === true &&
      generationWorkflow?.sourceCount === 26 &&
      generationWorkflow?.service?.providerCount === 26 &&
      generationWorkflow?.service?.protocolCount === 4 &&
      generationWorkflow?.scope === 'chat-completion-only' &&
      generationWorkflow?.directBrowserRequests === true &&
      generationWorkflow?.optionalBackend === false,
    generationBrowserWorkflow:
      generationWorkflow?.modelIds?.includes('browser-provider-model') === true &&
      generationWorkflow?.nonStreamText === 'Browser non-stream' &&
      generationWorkflow?.streamText === 'Browser stream' &&
      generationWorkflow?.anthropicText === 'Browser Anthropic' &&
      generationWorkflow?.googleText === 'Browser Google' &&
      generationWorkflow?.cohereText === 'Browser Cohere' &&
      generationWorkflow?.bias?.['101'] === -3 &&
      generationWorkflow?.bias?.['202'] === -3 &&
      Object.keys(generationWorkflow?.bias ?? {}).length === 2 &&
      generationWorkflow?.transport?.failures === 0 &&
      Object.values(generationWorkflow?.routesHandled ?? {}).every(Boolean),
    presetsStorageReady:
      presetWorkflow?.storage?.status === 'ready' &&
      presetWorkflow?.storage?.backend === 'indexeddb',
    presetsBrowserWorkflow:
      presetWorkflow?.available === true &&
      Object.values(presetWorkflow?.defaultCounts ?? {}).every((count) => count > 0) &&
      presetWorkflow?.selectorCounts?.context_presets > 0 &&
      presetWorkflow?.selectorCounts?.instruct_presets > 0 &&
      presetWorkflow?.selectorCounts?.themes > 0 &&
      presetWorkflow?.customSavedWithOpaqueField === true &&
      presetWorkflow?.customDeleteOk === true &&
      presetWorkflow?.customDeleted === true &&
      presetWorkflow?.defaultRestoreOk === true &&
      Object.values(presetWorkflow?.specialized ?? {}).every(Boolean) &&
      Object.values(presetWorkflow?.routesHandled ?? {}).every(Boolean),
    worldBooksStorageReady:
      worldBookWorkflow?.storage?.status === 'ready' &&
      worldBookWorkflow?.storage?.backend === 'indexeddb',
    worldBooksBrowserWorkflow:
      worldBookWorkflow?.available === true &&
      worldBookWorkflow?.saveAndGetOk === true &&
      worldBookWorkflow?.matcher?.keyActivated === true &&
      worldBookWorkflow?.matcher?.constantActivated === true &&
      worldBookWorkflow?.matcher?.disabledExcluded === true &&
      worldBookWorkflow?.ui?.editorHasMatcher === true &&
      worldBookWorkflow?.ui?.editorEntryCount >= 1 &&
      worldBookWorkflow?.importVisible === true &&
      worldBookWorkflow?.deleteOk === true &&
      worldBookWorkflow?.deletedFromBootstrap === true &&
      Object.values(worldBookWorkflow?.routesHandled ?? {}).every(Boolean),
    assetsStorageReady:
      assetsWorkflow?.storage?.blobs?.status === 'ready' &&
      assetsWorkflow?.storage?.blobs?.backend === 'indexeddb' &&
      assetsWorkflow?.storage?.index?.status === 'ready' &&
      assetsWorkflow?.storage?.index?.backend === 'indexeddb' &&
      assetsWorkflow?.serviceWorker?.status === 'ready' &&
      assetsWorkflow?.defaultBackgroundSeed?.status === 'ready',
    assetsBrowserWorkflow:
      assetsWorkflow?.available === true &&
      assetsWorkflow?.defaultBackgroundCount > 0 &&
      assetsWorkflow?.background?.uploadOk === true &&
      assetsWorkflow?.background?.domVisible === true &&
      assetsWorkflow?.background?.directSource === 'assets/backgrounds' &&
      assetsWorkflow?.background?.thumbnailSource === 'assets/backgrounds' &&
      assetsWorkflow?.background?.folderOk === true &&
      assetsWorkflow?.background?.renameOk === true &&
      assetsWorkflow?.background?.deleteOk === true &&
      typeof assetsWorkflow?.attachment?.url === 'string' &&
      assetsWorkflow.attachment.url.length > 0 &&
      assetsWorkflow?.attachment?.text === 'Browser attachment text' &&
      assetsWorkflow?.attachment?.verified === true &&
      assetsWorkflow?.attachment?.directSource === 'assets/attachments' &&
      Object.values(assetsWorkflow?.userImage ?? {}).every(Boolean) &&
      Object.values(assetsWorkflow?.avatar ?? {}).every(Boolean) &&
      Object.values(assetsWorkflow?.sprite ?? {}).every(Boolean) &&
      Object.values(assetsWorkflow?.library ?? {}).every(Boolean) &&
      Object.values(assetsWorkflow?.routesHandled ?? {}).every(Boolean),
    importExportStorageReady:
      dataManagementWorkflow?.storage?.status === 'ready' &&
      dataManagementWorkflow?.storage?.backend === 'indexeddb' &&
      dataManagementWorkflow?.participantCount === 10 &&
      dataManagementWorkflow?.participantCountAfterReload === 10 &&
      dataManagementWorkflow?.inspectionModuleCount === 10 &&
      dataManagementWorkflow?.transport?.kind === 'browser-local' &&
      dataManagementWorkflow?.transport?.opaqueArchiveStorage === true &&
      dataManagementWorkflow?.optionalBackend?.implemented === false &&
      dataManagementWorkflow?.optionalBackend?.contract === 'BackupTransport',
    importExportBrowserWorkflow:
      dataManagementWorkflow?.available === true &&
      dataManagementWorkflow?.panelOpen === true &&
      dataManagementWorkflow?.panelModuleRows === 10 &&
      dataManagementWorkflow?.inspectionHasSensitiveSecrets === true &&
      dataManagementWorkflow?.exportOk === true &&
      dataManagementWorkflow?.exportBytes > 0 &&
      dataManagementWorkflow?.fileCount > 0 &&
      dataManagementWorkflow?.hashCount === dataManagementWorkflow?.fileCount &&
      dataManagementWorkflow?.previewModuleCount === 9 &&
      dataManagementWorkflow?.defaultSecretsExcluded === true &&
      dataManagementWorkflow?.explicitSecretsIncluded === true &&
      dataManagementWorkflow?.dryImportOk === true &&
      dataManagementWorkflow?.backupListed === true &&
      dataManagementWorkflow?.backupDownloaded === true &&
      dataManagementWorkflow?.beforeRestoreEmpty === true &&
      dataManagementWorkflow?.restoreOk === true &&
      dataManagementWorkflow?.recoveryBackupCreated === true &&
      dataManagementWorkflow?.restoredModuleCount === 9 &&
      dataManagementWorkflow?.characterRestored === true &&
      dataManagementWorkflow?.chatListed === true &&
      dataManagementWorkflow?.chatRestored === true &&
      dataManagementWorkflow?.personaRestored === true &&
      dataManagementWorkflow?.statsRestored === true &&
      dataManagementWorkflow?.secretsStayedExcluded === true &&
      dataManagementWorkflow?.panelRestored === true &&
      dataManagementWorkflow?.backupCountAfterRestore >= 2 &&
      dataManagementWorkflow?.recoveryBackupVisible === true &&
      dataManagementWorkflow?.backupDeleteOk === true &&
      Object.values(dataManagementWorkflow?.routesHandled ?? {}).every(Boolean),
    chatsStorageReady:
      chatWorkflow?.storage?.status === 'ready' &&
      chatWorkflow?.storage?.backend === 'indexeddb' &&
      chatWorkflow?.messages?.status === 'ready' &&
      chatWorkflow?.messages?.backend === 'indexeddb',
    statsStorageReady:
      statsWorkflow?.storage?.status === 'ready' &&
      statsWorkflow?.storage?.backend === 'indexeddb' &&
      statsWorkflow?.chatSource?.status === 'ready' &&
      statsWorkflow?.consistency?.blocksChatWrites === false,
    statsBrowserWorkflow:
      statsWorkflow?.available === true &&
      chatWorkflow?.statsSeed?.incrementalUpdateOk === true &&
      statsWorkflow?.persistedAcrossReload === true &&
      statsWorkflow?.updateOk === true &&
      statsWorkflow?.recreateOk === true &&
      statsWorkflow?.rebuilt?.userMessages > 0 &&
      statsWorkflow?.rebuilt?.characterMessages > 0 &&
      statsWorkflow?.rebuilt?.userWords > 0 &&
      statsWorkflow?.rebuilt?.characterWords > 0 &&
      statsWorkflow?.rebuilt?.chatSize > 0 &&
      statsWorkflow?.rebuilt?.firstChat > 0 &&
      statsWorkflow?.rebuilt?.lastChat > 0 &&
      statsWorkflow?.characterPopupBlocks === 7 &&
      statsWorkflow?.userPopupBlocks === 7 &&
      Object.values(statsWorkflow?.routesHandled ?? {}).every(Boolean),
    chatBrowserWorkflow:
      chatWorkflow?.available === true &&
      chatWorkflow?.greetingSaved === true &&
      chatWorkflow?.localMessageSaved === true &&
      chatWorkflow?.secondChatSaved === true &&
      chatWorkflow?.manageChatFilesCount >= 2 &&
      chatWorkflow?.searchOk === true &&
      chatWorkflow?.renameOk === true &&
      chatWorkflow?.exportJsonlOk === true &&
      chatWorkflow?.exportTxtOk === true &&
      typeof chatWorkflow?.importedFileName === 'string' &&
      chatWorkflow.importedFileName.endsWith('.jsonl') &&
      chatWorkflow?.importedVisible === true &&
      chatWorkflow?.importedLoadOk === true &&
      chatWorkflow?.deleteOk === true &&
      chatWorkflow?.switchedToRemaining === true &&
      chatWorkflow?.recentOk === true &&
      chatWorkflow?.metadataBeforeReload === 'persisted' &&
      chatWorkflow?.messageRestored === true &&
      chatWorkflow?.metadataRestored === true &&
      chatWorkflow?.attachmentRestored === true &&
      chatWorkflow?.attachmentText === 'Browser attachment text' &&
      chatWorkflow?.attachmentDeleteOk === true &&
      chatWorkflow?.renameCharacterOk === true &&
      chatWorkflow?.renamePreservedChat === true &&
      chatWorkflow?.keepChatsFalseOk === true &&
      Object.values(chatWorkflow?.routesHandled ?? {}).every(Boolean),
    characterBrowserCrudWorkflow:
      characterWorkflow?.createOk === true &&
      characterWorkflow?.listAfterCreateHasCard === true &&
      characterWorkflow?.legacyListDomHasCard === true &&
      characterWorkflow?.legacyListImageUsesThumbnail === true &&
      characterWorkflow?.thumbnailOk === true &&
      characterWorkflow?.thumbnailAssetSource === 'characters/avatar' &&
      characterWorkflow?.directAvatarOk === true &&
      characterWorkflow?.directAvatarAssetSource === 'characters/avatar' &&
      characterWorkflow?.editOk === true &&
      characterWorkflow?.editedDescription === 'Edited in the browser verification flow.' &&
      characterWorkflow?.embeddedWorld?.detected === true &&
      characterWorkflow?.embeddedWorld?.imported === true &&
      characterWorkflow?.embeddedWorld?.content === 'BROWSER_EMBEDDED_LORE' &&
      characterWorkflow?.embeddedWorld?.opaqueFieldKept === true &&
      characterWorkflow?.embeddedWorld?.deleteOk === true &&
      characterWorkflow?.getAfterReloadOk === true &&
      characterWorkflow?.reloadedDescription === 'Edited in the browser verification flow.' &&
      characterWorkflow?.duplicateOk === true &&
      characterWorkflow?.renameOk === true &&
      characterWorkflow?.exportJsonOk === true &&
      characterWorkflow?.exportJsonName === 'Browser Alice Chat Renamed' &&
      characterWorkflow?.exportJsonHasNoChat === true &&
      characterWorkflow?.exportPngOk === true &&
      characterWorkflow?.exportPngIsPng === true &&
      characterWorkflow?.importJsonOk === true &&
      characterWorkflow?.importPngOk === true &&
      characterWorkflow?.externalUrlImportOk === true &&
      characterWorkflow?.deleteResults?.length >= 5 &&
      characterWorkflow.deleteResults.every((result) => result.ok) &&
      characterWorkflow?.deleteChatsTrueOk === true &&
      characterWorkflow?.listAfterDeleteEmpty === true &&
      Object.values(characterWorkflow?.routesHandled ?? {}).every(Boolean),
    upstreamMetadataLoaded:
      typeof snapshot?.upstreamVersion === 'string' && snapshot.upstreamVersion !== 'loading',
    documentComplete: snapshot?.documentReadyState === 'complete',
    legacyJQueryLoaded: snapshot?.jqueryPresent === true,
    criticalDomAnchorsPresent: snapshot?.missingCriticalDomAnchors?.length === 0,
    expectedRuntimeGlobalsPresent:
      snapshot?.runtimeGlobals && Object.values(snapshot.runtimeGlobals).every(Boolean),
    legacyModuleImportsAvailable: moduleContracts?.allImportsOk === true,
    legacyEventSystemOperational:
      moduleContracts?.eventSystem?.delivered === true &&
      moduleContracts?.eventSystem?.scriptEventSourceMatches === true,
    extensionContextAvailable: moduleContracts?.extensionContext?.ok === true,
    legacyCssLoaded:
      snapshot?.styleSheetHrefs?.some((href) => href.endsWith('/style.css')) === true,
    legacyLibraryLoaded:
      localScriptRequests.some((url) => new URL(url).pathname === '/lib.js') &&
      snapshot?.legacyLodashGlobal === true,
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
    moduleContracts,
    settingsPersistence,
    settingsSnapshotWorkflow,
    extensionWorkflow,
    tokenizerWorkflow,
    secretWorkflow,
    generationWorkflow,
    personaWorkflow,
    presetWorkflow,
    worldBookWorkflow,
    assetsWorkflow,
    characterWorkflow,
    chatWorkflow,
    statsWorkflow,
    dataManagementWorkflow,
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
  const browserExit = new Promise((resolve) => browser.once('exit', resolve));
  browser.kill();
  await Promise.race([browserExit, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  await new Promise((resolve) => mockProvider.server.close(resolve));
  await removeBrowserProfile(profileDirectory);
}
