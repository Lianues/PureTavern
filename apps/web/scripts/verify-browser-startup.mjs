import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
        const openRequest = indexedDB.open('pure-frontend-tavern-modular-dev');
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
      form.append('json_data', '{}');
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
      editForm.append('json_data', '{}');
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

  await client.send('Page.navigate', { url: appUrl });
  snapshot = await waitForApplicationSnapshot();

  const characterPostReloadEvaluation = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const createdAvatar = ${JSON.stringify(characterCreateEdit?.createdAvatar ?? '')};
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
      ].filter(Boolean);
      const deleteResults = [];
      for (const avatar of avatarsToDelete) {
        const response = await postJson('/api/characters/delete', { avatar_url: avatar, delete_chats: true });
        deleteResults.push({ avatar, ok: response.ok });
      }
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
        deleteResults,
        listAfterDeleteEmpty: listAfterDelete.length === 0,
        routesHandled: {
          duplicate: routeHandled('/api/characters/duplicate'),
          rename: routeHandled('/api/characters/rename'),
          export: routeHandled('/api/characters/export'),
          import: routeHandled('/api/characters/import'),
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
      characterWorkflow?.getAfterReloadOk === true &&
      characterWorkflow?.reloadedDescription === 'Edited in the browser verification flow.' &&
      characterWorkflow?.duplicateOk === true &&
      characterWorkflow?.renameOk === true &&
      characterWorkflow?.exportJsonOk === true &&
      characterWorkflow?.exportJsonName === 'Browser Alice' &&
      characterWorkflow?.exportJsonHasNoChat === true &&
      characterWorkflow?.exportPngOk === true &&
      characterWorkflow?.exportPngIsPng === true &&
      characterWorkflow?.importJsonOk === true &&
      characterWorkflow?.importPngOk === true &&
      characterWorkflow?.deleteResults?.length >= 4 &&
      characterWorkflow.deleteResults.every((result) => result.ok) &&
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
    moduleContracts,
    settingsPersistence,
    settingsSnapshotWorkflow,
    characterWorkflow,
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
