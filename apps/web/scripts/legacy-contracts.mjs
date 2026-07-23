import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const currentLegacyPublicRoot = path.join(packageRoot, 'legacy', 'upstream', 'public');
const currentUpstreamMetadataPath = path.join(packageRoot, 'legacy', 'upstream.json');
const contractsRoot = path.join(packageRoot, 'legacy', 'contracts');
const featuresRoot = path.join(packageRoot, 'src', 'features');

export const CONTRACT_SCHEMA_VERSION = 2;

export const CRITICAL_DOM_IDS = Object.freeze([
  'preloader',
  'top-bar',
  'sheld',
  'chat',
  'send_textarea',
  'send_but',
  'form_sheld',
  'leftNavDrawerIcon',
  'rightNavDrawerIcon',
  'WIDrawerIcon',
  'left-nav-panel',
  'right-nav-panel',
  'WorldInfo',
  'character_popup',
  'rm_print_characters_block',
  'rm_button_characters',
  'options',
  'dialogue_popup',
  'shadow_popup',
]);

export const EXTENSION_DOM_IDS = Object.freeze([
  'extensions-settings-button',
  'rm_extensions_block',
  'extensions_settings',
  'extensions_settings2',
  'extensions_details',
  'third_party_extension_button',
  'assets_container',
  'typing_indicator_container',
  'expressions_container',
  'sd_container',
  'tts_container',
  'qr_container',
  'translation_container',
  'regex_container',
  'vectors_container',
  'extensions_status',
  'extensions_connect',
  'extensions_url',
  'extensions_api_key',
]);

export const CRITICAL_SCRIPT_ENTRIES = Object.freeze([
  'lib/jquery-3.5.1.min.js',
  'lib/jquery-ui.min.js',
  'lib/polyfill.js',
  'scripts/i18n.js',
  'script.js',
]);

export const CRITICAL_STYLE_ENTRIES = Object.freeze([
  'style.css',
  'css/extensions-panel.css',
  'css/world-info.css',
  'css/mobile-styles.css',
]);

export const KEY_MODULE_PATHS = Object.freeze([
  'lib.js',
  'script.js',
  'scripts/events.js',
  'scripts/extensions.js',
  'scripts/st-context.js',
  'scripts/popup.js',
  'scripts/templates.js',
]);

export const EXPECTED_RUNTIME_GLOBALS = Object.freeze([
  '$',
  'jQuery',
  'SillyTavern',
  'Fuse',
  'DOMPurify',
  'hljs',
  'localforage',
  'Handlebars',
  'diff_match_patch',
  'SVGInject',
  'showdown',
  'moment',
  'Popper',
  'droll',
  '__PURE_TAVERN__',
]);

export const CORE_COMPATIBILITY_REQUESTS = Object.freeze([
  {
    method: 'GET',
    pathname: '/csrf-token',
    category: 'ui-required',
    responseKind: 'fixed-json',
    migrationStatus: 'bootstrap-compatibility-only',
  },
  {
    method: 'GET',
    pathname: '/version',
    category: 'ui-required',
    responseKind: 'upstream-metadata-json',
    migrationStatus: 'bootstrap-compatibility-only',
  },
  {
    method: 'POST',
    pathname: '/api/ping',
    category: 'ui-required',
    responseKind: 'empty-204',
    migrationStatus: 'bootstrap-compatibility-only',
  },
  {
    method: 'GET',
    pathname: '/api/users/me',
    category: 'ui-required',
    responseKind: 'fixed-default-user-json',
    migrationStatus: 'bootstrap-compatibility-only',
  },
  {
    method: 'POST',
    pathname: '/api/users/get',
    category: 'ui-required',
    responseKind: 'fixed-default-user-list-json',
    migrationStatus: 'bootstrap-compatibility-only',
  },
  {
    method: 'POST',
    pathname: '/api/secrets/settings',
    category: 'extension-ecosystem-required',
    responseKind: 'safe-default-json',
    migrationStatus: 'bootstrap-empty-response-not-migrated',
  },
  {
    method: 'POST',
    pathname: '/api/secrets/read',
    category: 'extension-ecosystem-required',
    responseKind: 'empty-object-json',
    migrationStatus: 'bootstrap-empty-response-not-migrated',
  },
  {
    method: 'GET',
    pathname: '/api/extensions/discover',
    category: 'extension-ecosystem-required',
    responseKind: 'empty-array-json',
    migrationStatus: 'extension-loading-disabled',
  },
  {
    method: 'POST',
    pathname: '/api/horde/status',
    category: 'data-capability-pending-migration',
    responseKind: 'offline-json',
    migrationStatus: 'bootstrap-empty-response-not-migrated',
  },
  {
    method: 'POST',
    pathname: '/api/horde/text-models',
    category: 'data-capability-pending-migration',
    responseKind: 'empty-array-json',
    migrationStatus: 'bootstrap-empty-response-not-migrated',
  },
  {
    method: 'POST',
    pathname: '/api/chats/recent',
    category: 'data-capability-pending-migration',
    responseKind: 'empty-array-json',
    migrationStatus: 'bootstrap-empty-response-not-migrated',
  },
  {
    method: 'POST',
    pathname: '/api/characters/all',
    category: 'data-capability-pending-migration',
    responseKind: 'empty-array-json',
    migrationStatus: 'bootstrap-empty-response-not-migrated',
  },
  {
    method: 'POST',
    pathname: '/api/groups/all',
    category: 'data-capability-pending-migration',
    responseKind: 'empty-array-json',
    migrationStatus: 'bootstrap-empty-response-not-migrated',
  },
  {
    method: 'POST',
    pathname: '/api/avatars/get',
    category: 'ui-required',
    responseKind: 'default-avatar-list-json',
    migrationStatus: 'bootstrap-compatibility-only',
  },
  {
    method: 'POST',
    pathname: '/api/worldinfo/list',
    category: 'data-capability-pending-migration',
    responseKind: 'empty-array-json',
    migrationStatus: 'bootstrap-empty-response-not-migrated',
  },
  {
    method: 'POST',
    pathname: '/api/backgrounds/all',
    category: 'ui-required',
    responseKind: 'empty-backgrounds-json',
    migrationStatus: 'bootstrap-compatibility-only',
  },
  {
    method: 'POST',
    pathname: '/api/backgrounds/folders',
    category: 'ui-required',
    responseKind: 'empty-background-folders-json',
    migrationStatus: 'bootstrap-compatibility-only',
  },
  {
    method: 'POST',
    pathname: '/api/image-metadata/all',
    category: 'data-capability-pending-migration',
    responseKind: 'empty-image-metadata-json',
    migrationStatus: 'bootstrap-empty-response-not-migrated',
  },
  {
    method: 'POST',
    pathname: '/api/stats/get',
    category: 'data-capability-pending-migration',
    responseKind: 'empty-object-json',
    migrationStatus: 'bootstrap-empty-response-not-migrated',
  },
]);

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function portablePath(absolutePath) {
  const relative = path.relative(packageRoot, absolutePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return normalizeRelativePath(relative);
  }
  return absolutePath;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  if (!(await exists(filePath))) return null;
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export function mergeCompatibilityRequests(coreRequests, featureRequests) {
  const requests = new Map();
  for (const request of [...coreRequests, ...featureRequests]) {
    requests.set(`${request.method.toUpperCase()} ${request.pathname}`, request);
  }
  return [...requests.values()];
}

async function loadFeatureCompatibilityRequests() {
  if (!(await exists(featuresRoot))) return [];
  const entries = await readdir(featuresRoot, { withFileTypes: true });
  const requests = [];

  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const contractPath = path.join(featuresRoot, entry.name, 'legacy', 'contract.json');
    const contract = await readJsonIfExists(contractPath);
    if (!contract) continue;
    if (contract.module !== entry.name || !Array.isArray(contract.legacyRequests)) {
      throw new Error(`Invalid feature Legacy contract: ${contractPath}`);
    }
    requests.push(...contract.legacyRequests);
  }

  return requests;
}

async function listFiles(root, prefix = '') {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolutePath, relativePath)));
    else if (entry.isFile()) files.push(normalizeRelativePath(relativePath));
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export async function resolveLegacySource(sourceArgument) {
  if (!sourceArgument) {
    return {
      repositoryRoot: path.join(packageRoot, 'legacy', 'upstream'),
      publicRoot: currentLegacyPublicRoot,
      packagePath: path.join(packageRoot, 'legacy', 'upstream', 'package.json'),
      metadataPath: currentUpstreamMetadataPath,
    };
  }

  const candidate = path.resolve(sourceArgument);
  const nestedPublic = path.join(candidate, 'public');
  const publicRoot = (await exists(nestedPublic)) ? nestedPublic : candidate;
  const indexPath = path.join(publicRoot, 'index.html');
  if (!(await exists(indexPath))) {
    throw new Error(`Source does not contain public/index.html or index.html: ${candidate}`);
  }

  const repositoryRoot = publicRoot === nestedPublic ? candidate : path.dirname(publicRoot);
  return {
    repositoryRoot,
    publicRoot,
    packagePath: path.join(repositoryRoot, 'package.json'),
    metadataPath: path.join(repositoryRoot, 'upstream.json'),
  };
}

async function inferVersion(source, explicitVersion) {
  if (explicitVersion) return explicitVersion;
  const metadata = await readJsonIfExists(source.metadataPath);
  if (typeof metadata?.version === 'string') return metadata.version;
  const packageJson = await readJsonIfExists(source.packagePath);
  if (typeof packageJson?.version === 'string') return packageJson.version;
  return 'unknown';
}

function parseAttributes(tag) {
  const attributes = {};
  const attributePattern = /([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  let isFirst = true;
  for (const match of tag.matchAll(attributePattern)) {
    if (isFirst) {
      isFirst = false;
      continue;
    }
    const [, name, doubleQuoted, singleQuoted, bare] = match;
    attributes[name.toLowerCase()] = doubleQuoted ?? singleQuoted ?? bare ?? true;
  }
  return attributes;
}

function extractDomIds(html) {
  return uniqueSorted(
    [...html.matchAll(/\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/giu)].map(
      (match) => match[1] ?? match[2] ?? match[3],
    ),
  );
}

function extractResourceEntries(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*>/giu)]
    .map((match) => parseAttributes(match[0]))
    .filter((attributes) => typeof attributes.src === 'string')
    .map((attributes) => ({
      src: attributes.src,
      type: typeof attributes.type === 'string' ? attributes.type : '',
      defer: attributes.defer === true || attributes.defer === '',
      async: attributes.async === true || attributes.async === '',
    }));

  const stylesheets = [...html.matchAll(/<link\b[^>]*>/giu)]
    .map((match) => parseAttributes(match[0]))
    .filter(
      (attributes) =>
        typeof attributes.href === 'string' &&
        String(attributes.rel ?? '')
          .toLowerCase()
          .split(/\s+/u)
          .includes('stylesheet'),
    )
    .map((attributes) => ({
      href: attributes.href,
      rel: typeof attributes.rel === 'string' ? attributes.rel : 'stylesheet',
      type: typeof attributes.type === 'string' ? attributes.type : '',
    }));

  return { scripts, stylesheets };
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

function extractNamedExports(source) {
  const exports = new Set();
  const withoutComments = stripComments(source);

  for (const match of withoutComments.matchAll(
    /\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gu,
  )) {
    exports.add(match[1]);
  }

  for (const match of withoutComments.matchAll(/\bexport\s+default\b/gu)) {
    if (match) exports.add('default');
  }

  for (const match of withoutComments.matchAll(
    /\bexport\s*\{([\s\S]*?)\}\s*(?:from\s*["'][^"']+["'])?\s*;?/gu,
  )) {
    const body = match[1];
    for (const rawPart of body.split(',')) {
      const part = rawPart.trim();
      if (!part) continue;
      const alias = /\bas\s+([A-Za-z_$][\w$]*)$/u.exec(part);
      const direct = /^([A-Za-z_$][\w$]*)$/u.exec(part);
      const renamedSource = /^([A-Za-z_$][\w$]*)\s+as\s+[A-Za-z_$][\w$]*$/u.exec(part);
      exports.add(alias?.[1] ?? direct?.[1] ?? renamedSource?.[1] ?? part);
    }
  }

  for (const match of withoutComments.matchAll(/\bexport\s+\*\s+from\s*["']([^"']+)["']/gu)) {
    exports.add(`* from ${match[1]}`);
  }

  return uniqueSorted([...exports]);
}

function extractGlobalAssignmentNames(source) {
  const names = [];
  for (const match of source.matchAll(/\b(?:window|globalThis)\.([A-Za-z_$][\w$]*)\s*=/gu)) {
    names.push(match[1]);
  }
  for (const match of source.matchAll(/\b(?:window|globalThis)\[['"]([^'"]+)['"]\]\s*=/gu)) {
    names.push(match[1]);
  }
  return uniqueSorted(names);
}

function extractEventTypes(source) {
  const eventTypes = [];
  const objectMatch = /\bexport\s+const\s+event_types\s*=\s*\{([\s\S]*?)\n\};/u.exec(source);
  const body = objectMatch?.[1] ?? source;
  for (const match of body.matchAll(/\b([A-Z][A-Z0-9_]*)\s*:\s*['"]([^'"]+)['"]/gu)) {
    eventTypes.push({ name: match[1], value: match[2] });
  }
  return eventTypes.sort((left, right) => left.name.localeCompare(right.name));
}

function selectKeys(record, keys) {
  return Object.fromEntries(keys.map((key) => [key, record[key] ?? []]));
}

function countExisting(values, allValues) {
  const allSet = new Set(allValues);
  return values.filter((value) => allSet.has(value));
}

function missingFrom(values, allValues) {
  const allSet = new Set(allValues);
  return values.filter((value) => !allSet.has(value));
}

export async function generateLegacyContract(options = {}) {
  const source = await resolveLegacySource(options.source);
  const version = await inferVersion(source, options.version);
  const indexHtml = await readFile(path.join(source.publicRoot, 'index.html'), 'utf8');
  const files = await listFiles(source.publicRoot);
  const domIds = extractDomIds(indexHtml);
  const resourceEntries = extractResourceEntries(indexHtml);
  const javaScriptFiles = files.filter((file) => file.endsWith('.js'));
  const extensionModulePaths = javaScriptFiles.filter(
    (file) => file === 'scripts/extensions.js' || file.startsWith('scripts/extensions/'),
  );
  const extensionDirectories = uniqueSorted(
    extensionModulePaths
      .filter((file) => file.startsWith('scripts/extensions/'))
      .map((file) => file.split('/').slice(0, 3).join('/')),
  );

  const moduleExports = {};
  const globalAssignments = {};
  for (const file of javaScriptFiles) {
    const sourceText = await readFile(path.join(source.publicRoot, ...file.split('/')), 'utf8');
    const exports = extractNamedExports(sourceText);
    const globals = extractGlobalAssignmentNames(sourceText);
    if (exports.length > 0) moduleExports[file] = exports;
    if (globals.length > 0) globalAssignments[file] = globals;
  }

  const eventsPath = path.join(source.publicRoot, 'scripts', 'events.js');
  const eventTypes = (await exists(eventsPath))
    ? extractEventTypes(await readFile(eventsPath, 'utf8'))
    : [];

  const scriptEntryPaths = resourceEntries.scripts.map((entry) => entry.src);
  const stylesheetEntryPaths = resourceEntries.stylesheets.map((entry) => entry.href);
  const compatibilityRequests = mergeCompatibilityRequests(
    CORE_COMPATIBILITY_REQUESTS,
    await loadFeatureCompatibilityRequests(),
  );

  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    project: 'SillyTavern',
    version,
    generatedAt: new Date().toISOString(),
    source: {
      publicRoot: portablePath(source.publicRoot),
      repositoryRoot: portablePath(source.repositoryRoot),
    },
    categories: {
      uiRequired: {
        description:
          'Original SillyTavern DOM, CSS and jQuery-driven interaction anchors that the root page keeps as the long-term compatibility layer.',
        domIds,
        criticalDomIds: countExisting(CRITICAL_DOM_IDS, domIds),
        missingCriticalDomIds: missingFrom(CRITICAL_DOM_IDS, domIds),
        resourceEntries,
        criticalScriptEntries: CRITICAL_SCRIPT_ENTRIES.map((src) => ({
          src,
          present: scriptEntryPaths.includes(src),
        })),
        criticalStyleEntries: CRITICAL_STYLE_ENTRIES.map((href) => ({
          href,
          present: stylesheetEntryPaths.includes(href),
        })),
      },
      extensionEcosystemRequired: {
        description:
          'Static extension ecosystem surface retained for compatibility. Runtime discovery currently returns an empty list and third-party extension loading is disabled.',
        status: {
          uiFoundation: 'present',
          discoveryApi: 'empty-bootstrap-response',
          thirdPartyLoading: 'disabled-until-permission-and-data-contracts-exist',
        },
        domIds: countExisting(EXTENSION_DOM_IDS, domIds),
        missingDomIds: missingFrom(EXTENSION_DOM_IDS, domIds),
        modulePaths: extensionModulePaths,
        extensionDirectories,
        eventTypes,
        keyModuleExports: selectKeys(moduleExports, KEY_MODULE_PATHS),
        moduleExports,
        globalAssignments,
        expectedRuntimeGlobals: [...EXPECTED_RUNTIME_GLOBALS],
      },
      dataCapabilities: {
        description:
          'Legacy request compatibility surface. Core settings and snapshots persist in IndexedDB; remaining empty bootstrap responses are not migrated character/chat/world-book implementations.',
        startupCompatibilityRequests: compatibilityRequests,
      },
    },
    extraction: {
      domIdCount: domIds.length,
      scriptEntryCount: resourceEntries.scripts.length,
      stylesheetEntryCount: resourceEntries.stylesheets.length,
      javaScriptFileCount: javaScriptFiles.length,
      extensionModuleFileCount: extensionModulePaths.length,
      exportedModuleFileCount: Object.keys(moduleExports).length,
      globalAssignmentFileCount: Object.keys(globalAssignments).length,
      eventTypeCount: eventTypes.length,
    },
  };
}

function asSet(values) {
  return new Set(values ?? []);
}

function diffArrays(previousValues, nextValues) {
  const previous = asSet(previousValues);
  const next = asSet(nextValues);
  return {
    added: [...next]
      .filter((value) => !previous.has(value))
      .sort((left, right) => left.localeCompare(right)),
    removed: [...previous]
      .filter((value) => !next.has(value))
      .sort((left, right) => left.localeCompare(right)),
  };
}

function entriesByPath(entries, key) {
  return new Map((entries ?? []).map((entry) => [entry[key], entry]));
}

function diffResourceEntries(previousEntries, nextEntries, key) {
  const previous = entriesByPath(previousEntries, key);
  const next = entriesByPath(nextEntries, key);
  const paths = diffArrays([...previous.keys()], [...next.keys()]);
  const changed = [];
  for (const [entryPath, previousEntry] of previous) {
    const nextEntry = next.get(entryPath);
    if (!nextEntry) continue;
    if (JSON.stringify(previousEntry) !== JSON.stringify(nextEntry)) {
      changed.push({ path: entryPath, previous: previousEntry, next: nextEntry });
    }
  }
  return { ...paths, changed };
}

function eventTypeMap(contract) {
  return new Map(
    (contract.categories.extensionEcosystemRequired.eventTypes ?? []).map((event) => [
      event.name,
      event.value,
    ]),
  );
}

function diffEventTypes(previousContract, nextContract) {
  const previous = eventTypeMap(previousContract);
  const next = eventTypeMap(nextContract);
  const names = diffArrays([...previous.keys()], [...next.keys()]);
  const changed = [];
  for (const [name, previousValue] of previous) {
    const nextValue = next.get(name);
    if (nextValue !== undefined && previousValue !== nextValue) {
      changed.push({ name, previous: previousValue, next: nextValue });
    }
  }
  return { ...names, changed };
}

function diffModuleExports(previousContract, nextContract) {
  const previous = previousContract.categories.extensionEcosystemRequired.keyModuleExports ?? {};
  const next = nextContract.categories.extensionEcosystemRequired.keyModuleExports ?? {};
  const modulePaths = uniqueSorted([...Object.keys(previous), ...Object.keys(next)]);
  const byModule = {};
  for (const modulePath of modulePaths) {
    byModule[modulePath] = diffArrays(previous[modulePath] ?? [], next[modulePath] ?? []);
  }
  return byModule;
}

function flattenGlobalAssignments(contract) {
  return uniqueSorted(
    Object.values(contract.categories.extensionEcosystemRequired.globalAssignments ?? {}).flat(),
  );
}

function requestKeys(contract) {
  const capabilities =
    contract.categories.dataCapabilities ?? contract.categories.dataCapabilitiesPendingMigration;
  return (capabilities?.startupCompatibilityRequests ?? []).map(
    (request) => `${request.method.toUpperCase()} ${request.pathname}`,
  );
}

function pushRisk(risks, severity, area, message, items) {
  if (!items || (Array.isArray(items) && items.length === 0)) return;
  risks.push({ severity, area, message, items });
}

export function compareLegacyContracts(previousContract, nextContract) {
  const uiDom = diffArrays(
    previousContract.categories.uiRequired.domIds,
    nextContract.categories.uiRequired.domIds,
  );
  const criticalDomIds = previousContract.categories.uiRequired.criticalDomIds ?? CRITICAL_DOM_IDS;
  const criticalDomRemoved = uiDom.removed.filter((id) => criticalDomIds.includes(id));

  const scripts = diffResourceEntries(
    previousContract.categories.uiRequired.resourceEntries.scripts,
    nextContract.categories.uiRequired.resourceEntries.scripts,
    'src',
  );
  const stylesheets = diffResourceEntries(
    previousContract.categories.uiRequired.resourceEntries.stylesheets,
    nextContract.categories.uiRequired.resourceEntries.stylesheets,
    'href',
  );
  const criticalScriptsRemoved = scripts.removed.filter((src) =>
    CRITICAL_SCRIPT_ENTRIES.includes(src),
  );
  const criticalStylesRemoved = stylesheets.removed.filter((href) =>
    CRITICAL_STYLE_ENTRIES.includes(href),
  );
  const criticalScriptAttributesChanged = scripts.changed.filter((entry) =>
    CRITICAL_SCRIPT_ENTRIES.includes(entry.path),
  );

  const extensionModulePaths = diffArrays(
    previousContract.categories.extensionEcosystemRequired.modulePaths,
    nextContract.categories.extensionEcosystemRequired.modulePaths,
  );
  const criticalExtensionModulesRemoved = extensionModulePaths.removed.filter(
    (modulePath) => modulePath === 'scripts/extensions.js' || KEY_MODULE_PATHS.includes(modulePath),
  );
  const extensionDom = diffArrays(
    previousContract.categories.extensionEcosystemRequired.domIds,
    nextContract.categories.extensionEcosystemRequired.domIds,
  );
  const eventTypes = diffEventTypes(previousContract, nextContract);
  const moduleExports = diffModuleExports(previousContract, nextContract);
  const removedKeyExports = Object.entries(moduleExports)
    .filter(([, diff]) => diff.removed.length > 0)
    .map(([modulePath, diff]) => ({ modulePath, removed: diff.removed }));
  const globalAssignments = diffArrays(
    flattenGlobalAssignments(previousContract),
    flattenGlobalAssignments(nextContract),
  );
  const expectedGlobals =
    previousContract.categories.extensionEcosystemRequired.expectedRuntimeGlobals ?? [];
  const removedExpectedGlobalAssignments = globalAssignments.removed.filter((name) =>
    expectedGlobals.includes(name),
  );
  const startupRequests = diffArrays(requestKeys(previousContract), requestKeys(nextContract));

  const differences = {
    uiRequired: {
      domIds: uiDom,
      criticalDomRemoved,
      scripts,
      stylesheets,
      criticalScriptsRemoved,
      criticalStylesRemoved,
      criticalScriptAttributesChanged,
    },
    extensionEcosystemRequired: {
      domIds: extensionDom,
      modulePaths: extensionModulePaths,
      criticalExtensionModulesRemoved,
      eventTypes,
      moduleExports,
      removedKeyExports,
      globalAssignments,
      removedExpectedGlobalAssignments,
    },
    dataCapabilities: {
      startupCompatibilityRequests: startupRequests,
    },
  };

  const risks = [];
  pushRisk(
    risks,
    'critical',
    'uiRequired.domIds',
    'Critical original UI DOM anchors were removed.',
    criticalDomRemoved,
  );
  pushRisk(
    risks,
    'critical',
    'uiRequired.scripts',
    'Critical original script entries were removed.',
    criticalScriptsRemoved,
  );
  pushRisk(
    risks,
    'critical',
    'uiRequired.stylesheets',
    'Critical original stylesheet entries were removed.',
    criticalStylesRemoved,
  );
  pushRisk(
    risks,
    'critical',
    'uiRequired.scripts',
    'Critical script entry attributes changed and may affect load order or module semantics.',
    criticalScriptAttributesChanged,
  );
  pushRisk(
    risks,
    'critical',
    'extensionEcosystemRequired.modulePaths',
    'Critical extension ecosystem modules were removed.',
    criticalExtensionModulesRemoved,
  );
  pushRisk(
    risks,
    'critical',
    'extensionEcosystemRequired.moduleExports',
    'Exports from key Legacy modules were removed.',
    removedKeyExports,
  );
  pushRisk(
    risks,
    'critical',
    'extensionEcosystemRequired.eventTypes',
    'Legacy event names were removed.',
    eventTypes.removed,
  );
  pushRisk(
    risks,
    'critical',
    'extensionEcosystemRequired.eventTypes',
    'Legacy event values changed.',
    eventTypes.changed,
  );
  pushRisk(
    risks,
    'critical',
    'extensionEcosystemRequired.globalAssignments',
    'Expected runtime global assignments disappeared from the upstream snapshot.',
    removedExpectedGlobalAssignments,
  );
  pushRisk(
    risks,
    'warning',
    'uiRequired.domIds',
    'Non-critical original DOM IDs were removed and may affect less common UI paths.',
    uiDom.removed.filter((id) => !criticalDomRemoved.includes(id)),
  );
  pushRisk(
    risks,
    'warning',
    'extensionEcosystemRequired.domIds',
    'Extension UI anchors were removed.',
    extensionDom.removed,
  );
  pushRisk(
    risks,
    'warning',
    'extensionEcosystemRequired.modulePaths',
    'Extension module files were removed.',
    extensionModulePaths.removed.filter(
      (modulePath) => !criticalExtensionModulesRemoved.includes(modulePath),
    ),
  );
  pushRisk(
    risks,
    'warning',
    'dataCapabilities.startupCompatibilityRequests',
    'Legacy compatibility request declarations changed; confirm each path remains correctly classified as browser-ready or pending migration.',
    [...startupRequests.added, ...startupRequests.removed],
  );

  const ok = !risks.some((risk) => risk.severity === 'critical');
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    comparedAt: new Date().toISOString(),
    baselineVersion: previousContract.version,
    candidateVersion: nextContract.version,
    ok,
    summary: {
      criticalRiskCount: risks.filter((risk) => risk.severity === 'critical').length,
      warningCount: risks.filter((risk) => risk.severity === 'warning').length,
      addedDomIdCount: uiDom.added.length,
      removedDomIdCount: uiDom.removed.length,
      addedExtensionModuleCount: extensionModulePaths.added.length,
      removedExtensionModuleCount: extensionModulePaths.removed.length,
      addedEventTypeCount: eventTypes.added.length,
      removedEventTypeCount: eventTypes.removed.length,
      changedEventTypeCount: eventTypes.changed.length,
    },
    differences,
    risks,
  };
}

async function readContract(contractPath) {
  return JSON.parse(await readFile(contractPath, 'utf8'));
}

async function defaultBaselinePath() {
  const metadata = await readJsonIfExists(currentUpstreamMetadataPath);
  const version = typeof metadata?.version === 'string' ? metadata.version : '1.18.0';
  return path.join(contractsRoot, `${version}.json`);
}

export async function generateLegacyContractFile(options = {}) {
  const contract = await generateLegacyContract(options);
  const outputPath = options.out
    ? path.resolve(options.out)
    : path.join(contractsRoot, `${contract.version}.json`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
  return { contract, outputPath };
}

export async function checkLegacyContract(options = {}) {
  const baselinePath = options.baseline
    ? path.resolve(options.baseline)
    : await defaultBaselinePath();
  const baseline = await readContract(baselinePath);
  const candidate = await generateLegacyContract(options);
  return {
    baselinePath: portablePath(baselinePath),
    candidateSource: candidate.source,
    ...compareLegacyContracts(baseline, candidate),
  };
}

function parseArguments(args) {
  const command = args[0];
  if (!command || command === '--help' || command === '-h') {
    return { command: 'help' };
  }
  if (command !== 'generate' && command !== 'check') {
    throw new Error(`Unknown command: ${command}`);
  }

  const options = { command };
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (
      argument === '--source' ||
      argument === '--version' ||
      argument === '--out' ||
      argument === '--baseline'
    ) {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  node apps/web/scripts/legacy-contracts.mjs generate [--source <repo-or-public-dir>] [--version x.y.z] [--out file]
  node apps/web/scripts/legacy-contracts.mjs check [--source <repo-or-public-dir>] [--version x.y.z] [--baseline file]

Commands:
  generate  Create a versioned Legacy compatibility contract JSON without writing to the upstream snapshot.
  check     Compare a generated candidate contract with the committed baseline. Critical breaks exit non-zero.`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === 'help') {
    printHelp();
  } else if (options.command === 'generate') {
    const { contract, outputPath } = await generateLegacyContractFile(options);
    console.log(
      JSON.stringify({ ok: true, outputPath: portablePath(outputPath), contract }, null, 2),
    );
  } else {
    const report = await checkLegacyContract(options);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}
