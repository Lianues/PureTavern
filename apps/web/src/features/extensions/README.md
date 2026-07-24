# M11 Extensions

Browser-owned extension registry, isolated plugin storage, explicit permission grants, local package validation, sandbox messaging, and truthful Legacy compatibility responses.

## Composition

`createExtensionsFeature(options)` accepts security-sensitive injection points:

- `packageAssets` / `createPackageAssets`: the only allowed persistence/resolution port for local
  package `Blob`s. The default feature consumes M13 `ExtensionPackageAssetsCapability`; this module
  never uses `ModuleBlobStore`, creates no IndexedDB store, and changes no database version.
- `trustedBuiltIns` / `loadTrustedBuiltIns`: audited Legacy extensions shipped in the selected
  upstream snapshot. `prepare-legacy-runtime.mjs` generates
  `/__pure_tavern/trusted-extensions.json`; the compiled list is only a startup fallback.

The feature registers `extensionsRuntimeCapability` and `LegacyExtensionSettingsCapability`.
Settings serializes `disabledExtensions` against registry enable state, while Assets stores validated
local package files behind stable aliases.

```ts
const feature = createExtensionsFeature({
  packageAssets: assetsBridge,
  trustedBuiltIns: TRUSTED_LEGACY_BUILTINS,
  createCapabilityHandlers: (extensionId) => ({
    'host:events': (input) => eventBridge.publish(extensionId, input),
  }),
});
```

No optional runtime asset or second root Service Worker is installed by this module.

## Storage namespaces

All JSON records use the existing module-scoped `records` port:

- `manifests/<stable extension id>`
- `installations/<stable extension id>`
- `enabled/<stable extension id>`
- `permissions/<stable extension id>:<capability>`
- `plugin-kv:<stable extension id>/<plugin key>`

The stable extension ID is the manifest identity. Display name, Legacy route name, package path, and asset URL are separate fields. User package Legacy aliases are derived from the package hash, not from display names.

Every records adapter has an in-memory fallback and diagnostics. Blob fallback/persistence is deliberately not invented here; it belongs behind the injected Assets port.

## Local package format

A package is supplied as browser-selected `{ path, data: Blob }[]` entries. ZIP extraction, if used by UI code, must happen before this API and must preserve raw relative paths for validation.

Root `manifest.json` schema:

```json
{
  "schema_version": 1,
  "id": "org.example.my-extension",
  "display_name": "My Extension",
  "version": "1.0.0",
  "author": "Example",
  "description": "Runs in a sandbox",
  "entry": { "type": "worker", "path": "worker.js" },
  "permissions": ["storage:plugin"],
  "hashes": {
    "worker.js": "64 lowercase or uppercase SHA-256 hex characters"
  }
}
```

User entry types are only `iframe` (`.html`) or `worker` (`.js`/`.mjs`). `same-context` is not accepted from package JSON. Hashes must cover every file except `manifest.json`, with no extras. Default limits are 256 files, 20 MiB total, 256 KiB manifest, and 240-character paths.

Rejected inputs include absolute/drive paths, backslashes, percent-encoded paths, URL/query/fragment syntax, control characters, `.`/`..`, empty segments, Unicode/case duplicate conflicts, missing/extra hashes, hash mismatch, duplicate identity, invalid entry type, and missing entry file.

This module does not fetch package URLs and does not claim to bypass CORS or provide Git. Legacy
remote install/update/branch/switch/move routes return structured HTTP 501 responses instead of
pretending that browser-only Git/filesystem operations succeeded.

## Permissions and sandbox

All permissions default to denied. A grant is accepted only when the installed manifest requested that capability. Sensitive capabilities (`secrets:read`, `network:fetch`, `dom:legacy`, and `storage:modules`) have no default host handler.

`SandboxProtocolHost` verifies exact source identity, exact origin, protocol, extension ID, session ID, request ID, and envelope shape. It supports request/response timeouts and a single capability call method. The built-in plugin KV handler always binds to the caller's stable extension ID.

The production Chrome gate verifies all 14 generated trusted built-ins through the unchanged Legacy
loader, including Regex manifest/script/style and Settings-backed disable/enable persistence. User
packages remain excluded from Legacy discover, so they cannot bypass the sandbox.

See [THREAT-MODEL.md](./THREAT-MODEL.md) and [LEGACY-CONTRACT.md](./LEGACY-CONTRACT.md).
