import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  compareLegacyContracts,
  generateLegacyContract,
  mergeCompatibilityRequests,
} from './legacy-contracts.mjs';

const temporaryRoots: string[] = [];

async function writeFixtureFile(publicRoot: string, relativePath: string, content: string) {
  const absolutePath = path.join(publicRoot, ...relativePath.split('/'));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
}

async function createLegacyFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'pure-tavern-contract-'));
  temporaryRoots.push(root);
  const publicRoot = path.join(root, 'public');
  await mkdir(publicRoot, { recursive: true });

  await writeFixtureFile(
    publicRoot,
    'index.html',
    `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="style.css">
    <link rel="stylesheet" href="css/extensions-panel.css">
    <script src="lib/jquery-3.5.1.min.js"></script>
    <script src="lib/polyfill.js"></script>
    <script type="module" src="script.js"></script>
  </head>
  <body>
    <div id="preloader"></div>
    <div id="top-bar"></div>
    <div id="sheld"></div>
    <div id="chat"></div>
    <textarea id="send_textarea"></textarea>
    <button id="send_but"></button>
    <form id="form_sheld"></form>
    <button id="leftNavDrawerIcon"></button>
    <button id="rightNavDrawerIcon"></button>
    <button id="WIDrawerIcon"></button>
    <aside id="left-nav-panel"></aside>
    <aside id="right-nav-panel"></aside>
    <aside id="WorldInfo"></aside>
    <section id="character_popup"></section>
    <section id="rm_print_characters_block"></section>
    <button id="rm_button_characters"></button>
    <section id="options"></section>
    <section id="dialogue_popup"></section>
    <section id="shadow_popup"></section>
    <section id="extensions-settings-button"></section>
    <section id="rm_extensions_block"></section>
    <section id="extensions_settings"></section>
    <section id="extensions_settings2"></section>
    <section id="extensions_details"></section>
    <section id="third_party_extension_button"></section>
    <section id="assets_container"></section>
    <section id="qr_container"></section>
    <section id="extensions_status"></section>
  </body>
</html>`,
  );
  await writeFixtureFile(publicRoot, 'style.css', 'body { color: white; }');
  await writeFixtureFile(publicRoot, 'css/extensions-panel.css', '.extensions_block {}');
  await writeFixtureFile(
    publicRoot,
    'lib/jquery-3.5.1.min.js',
    'window.jQuery = window.$ = function jquery() {};',
  );
  await writeFixtureFile(publicRoot, 'lib/polyfill.js', '');
  await writeFixtureFile(
    publicRoot,
    'lib.js',
    'window.DOMPurify = {}; window.Fuse = function Fuse() {};',
  );
  await writeFixtureFile(
    publicRoot,
    'scripts/events.js',
    `export const event_types = {
      APP_READY: 'app_ready',
      MESSAGE_SENT: 'message_sent',
    };
    export const eventSource = { on() {}, emit() {}, removeListener() {} };`,
  );
  await writeFixtureFile(
    publicRoot,
    'scripts/extensions.js',
    `export const extension_settings = { disabledExtensions: [] };
    export const extensionNames = [];
    export function getContext() { return {}; }
    export async function initExtensions() { return []; }`,
  );
  await writeFixtureFile(
    publicRoot,
    'scripts/st-context.js',
    'export function getContext() { return {}; }',
  );
  await writeFixtureFile(
    publicRoot,
    'scripts/popup.js',
    'export const POPUP_TYPE = {}; export class Popup {}',
  );
  await writeFixtureFile(
    publicRoot,
    'scripts/templates.js',
    'export function renderTemplate() { return ""; }',
  );
  await writeFixtureFile(
    publicRoot,
    'script.js',
    `import { event_types, eventSource } from './scripts/events.js';
    globalThis.SillyTavern = { getContext() {} };
    export const getRequestHeaders = () => ({});
    export { event_types, eventSource };`,
  );
  await writeFixtureFile(
    publicRoot,
    'scripts/extensions/example/index.js',
    'export function onEnable() {}',
  );
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8');

  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('legacy compatibility contracts', () => {
  it('lets a feature manifest override a core bootstrap declaration without duplicates', () => {
    const requests = mergeCompatibilityRequests(
      [
        {
          method: 'POST',
          pathname: '/api/example/get',
          migrationStatus: 'bootstrap-empty-response-not-migrated',
        },
      ],
      [
        {
          method: 'POST',
          pathname: '/api/example/get',
          migrationStatus: 'browser-ready-example',
        },
      ],
    );

    expect(requests).toEqual([
      expect.objectContaining({ migrationStatus: 'browser-ready-example' }),
    ]);
  });

  it('generates a categorized contract from a read-only upstream snapshot', async () => {
    const root = await createLegacyFixture();

    const contract = await generateLegacyContract({ source: root });

    expect(contract.version).toBe('9.9.9');
    expect(contract.categories.uiRequired.criticalDomIds).toContain('send_textarea');
    expect(contract.categories.uiRequired.resourceEntries.scripts).toContainEqual(
      expect.objectContaining({ src: 'script.js', type: 'module' }),
    );
    expect(contract.categories.extensionEcosystemRequired.modulePaths).toContain(
      'scripts/extensions.js',
    );
    expect(contract.categories.extensionEcosystemRequired.eventTypes).toContainEqual({
      name: 'APP_READY',
      value: 'app_ready',
    });
    expect(contract.categories.extensionEcosystemRequired.keyModuleExports['script.js']).toEqual(
      expect.arrayContaining(['eventSource', 'event_types', 'getRequestHeaders']),
    );
    expect(
      contract.categories.dataCapabilities.startupCompatibilityRequests.some(
        (request) => request.migrationStatus === 'bootstrap-empty-response-not-migrated',
      ),
    ).toBe(true);
    expect(contract.categories.dataCapabilities.startupCompatibilityRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pathname: '/api/settings/save',
          migrationStatus: 'browser-ready-core-settings',
        }),
        expect.objectContaining({
          pathname: '/api/settings/restore-snapshot',
          migrationStatus: 'browser-ready-settings-snapshots',
        }),
      ]),
    );
  });

  it('reports critical risks when key Legacy contracts disappear', async () => {
    const root = await createLegacyFixture();
    const baseline = await generateLegacyContract({ source: root });
    const candidate = JSON.parse(JSON.stringify(baseline));
    candidate.categories.uiRequired.domIds = candidate.categories.uiRequired.domIds.filter(
      (id: string) => id !== 'send_textarea',
    );
    candidate.categories.extensionEcosystemRequired.eventTypes = [];
    candidate.categories.extensionEcosystemRequired.keyModuleExports['script.js'] = [];

    const report = compareLegacyContracts(baseline, candidate);

    expect(report.ok).toBe(false);
    expect(report.differences.uiRequired.criticalDomRemoved).toContain('send_textarea');
    expect(report.risks.some((risk) => risk.severity === 'critical')).toBe(true);
  });
});
