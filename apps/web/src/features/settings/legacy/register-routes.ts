import type { CapabilityRegistry } from '@/platform/features/capability-registry';
import {
  legacyExtensionSettingsCapability,
  legacyPersonaStateCapability,
  legacyPresetBootstrapCapability,
  worldNamesCapability,
} from '@/platform/features/standard-capabilities';
import type { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { emptyResponse, jsonResponse, textResponse } from '@/platform/legacy/compatibility-router';

import {
  InvalidSettingsSnapshotNameError,
  SettingsSnapshotNotFoundError,
  type SettingsSnapshotService,
} from '../application/settings-snapshot-service';
import type { SettingsService } from '../application/settings-service';

export function registerSettingsLegacyRoutes(
  router: CompatibilityRouter,
  settings: SettingsService,
  snapshots: SettingsSnapshotService,
  capabilities: CapabilityRegistry,
) {
  let personasHydrated = false;
  let extensionsHydrated = false;

  const composeSettingsForLegacy = async () => {
    let document = await settings.getSettings();
    const personas = capabilities.get(legacyPersonaStateCapability);
    if (personas) {
      if (!personasHydrated) {
        await personas.importLegacyPersonaState(document);
        personasHydrated = true;
      }
      document = await personas.composeLegacyPersonaState(document);
    }

    const extensions = capabilities.get(legacyExtensionSettingsCapability);
    if (extensions) {
      if (!extensionsHydrated) {
        await extensions.applyDisabledLegacyNames(readDisabledExtensions(document));
        extensionsHydrated = true;
      }
      document = composeDisabledExtensions(document, await extensions.getDisabledLegacyNames());
    }
    return document;
  };

  const synchronizeSettingsFromLegacy = async (value: unknown) => {
    let document = cloneSettingsObject(value);
    const personas = capabilities.get(legacyPersonaStateCapability);
    if (personas) {
      await personas.importLegacyPersonaState(document);
      personasHydrated = true;
      document = await personas.composeLegacyPersonaState(document);
    }

    const extensions = capabilities.get(legacyExtensionSettingsCapability);
    if (extensions) {
      await extensions.applyDisabledLegacyNames(readDisabledExtensions(document));
      extensionsHydrated = true;
      document = composeDisabledExtensions(document, await extensions.getDisabledLegacyNames());
    }
    return document;
  };

  router.register('POST', '/api/settings/get', async () => {
    const [presetData, worldNames, composedSettings] = await Promise.all([
      loadPresetBootstrapData(capabilities),
      loadWorldNames(capabilities),
      composeSettingsForLegacy(),
    ]);
    return jsonResponse({
      settings: JSON.stringify(composedSettings),
      ...presetData,
      world_names: worldNames,
      enable_extensions: capabilities.has(legacyExtensionSettingsCapability),
      enable_extensions_auto_update: false,
      enable_accounts: false,
      request_compression: {
        enabled: false,
        minPayloadSize: 0,
        maxPayloadSize: 0,
        timeout: 0,
      },
    });
  });

  router.register('POST', '/api/settings/save', async (request) => {
    try {
      await settings.saveSettings(await synchronizeSettingsFromLegacy(await request.json()));
      return jsonResponse({ result: 'ok' });
    } catch (error) {
      return jsonResponse(
        {
          error: error instanceof Error ? error.message : String(error),
          pureTavern: true,
        },
        400,
      );
    }
  });

  router.register('POST', '/api/settings/get-snapshots', async () =>
    jsonResponse(await snapshots.listSnapshots()),
  );
  router.register('POST', '/api/settings/load-snapshot', async (request) => {
    try {
      const { name } = (await request.json()) as { name?: unknown };
      return textResponse(await snapshots.loadSnapshotContent(name));
    } catch (error) {
      return settingsSnapshotErrorResponse(error);
    }
  });
  router.register('POST', '/api/settings/make-snapshot', async () => {
    try {
      await settings.saveSettings(await composeSettingsForLegacy());
      await snapshots.createSnapshot();
      return emptyResponse();
    } catch (error) {
      return settingsSnapshotErrorResponse(error);
    }
  });
  router.register('POST', '/api/settings/restore-snapshot', async (request) => {
    try {
      const { name } = (await request.json()) as { name?: unknown };
      await snapshots.restoreSnapshot(name);
      personasHydrated = false;
      extensionsHydrated = false;
      return emptyResponse();
    } catch (error) {
      return settingsSnapshotErrorResponse(error);
    }
  });
}

async function loadPresetBootstrapData(
  capabilities: CapabilityRegistry,
): Promise<Record<string, unknown>> {
  const provider = capabilities.get(legacyPresetBootstrapCapability);
  if (!provider) return {};
  try {
    return await provider.getLegacyBootstrapData();
  } catch (error) {
    console.warn('[PureTavern Settings] Preset bootstrap data is unavailable.', error);
    return {};
  }
}

async function loadWorldNames(capabilities: CapabilityRegistry): Promise<string[]> {
  const provider = capabilities.get(worldNamesCapability);
  if (!provider) return [];
  try {
    return await provider.listWorldNames();
  } catch (error) {
    console.warn('[PureTavern Settings] World Book names are unavailable.', error);
    return [];
  }
}

function cloneSettingsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Settings payload must be a JSON object.');
  }
  return structuredClone(value) as Record<string, unknown>;
}

function readDisabledExtensions(settings: Record<string, unknown>): string[] {
  const extensionSettings = settings.extension_settings;
  if (
    !extensionSettings ||
    typeof extensionSettings !== 'object' ||
    Array.isArray(extensionSettings)
  ) {
    return [];
  }
  const disabled = (extensionSettings as Record<string, unknown>).disabledExtensions;
  return Array.isArray(disabled)
    ? disabled.filter((value): value is string => typeof value === 'string')
    : [];
}

function composeDisabledExtensions(
  settings: Record<string, unknown>,
  disabledExtensions: readonly string[],
): Record<string, unknown> {
  const document = structuredClone(settings);
  const current = document.extension_settings;
  const extensionSettings =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  document.extension_settings = {
    ...extensionSettings,
    disabledExtensions: [...disabledExtensions],
  };
  return document;
}

function settingsSnapshotErrorResponse(error: unknown): Response {
  const status =
    error instanceof InvalidSettingsSnapshotNameError
      ? 400
      : error instanceof SettingsSnapshotNotFoundError
        ? 404
        : 500;
  return jsonResponse(
    {
      error: error instanceof Error ? error.message : String(error),
      pureTavern: true,
    },
    status,
  );
}
