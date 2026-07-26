# M11 Extensions

M11 keeps the unchanged SillyTavern extension manager, warning dialog, manifest loader, hooks, enable/disable UI, and same-context execution model. Browser-owned code replaces only the server Git/filesystem boundary.

## Runtime flow

```text
upstream extensions.js + thirdPartyExtensionWarning
  -> /api/extensions/* compatibility routes
  -> ExtensionService + ExtensionRegistry
  -> CORS Source Gateway
  -> M13 package assets
  -> /scripts/extensions/third-party/<folder>/...
  -> upstream loader imports manifest/js/css in the page context
```

The original warning is shown before a non-official repository is installed. Once accepted, third-party code has the same authority it has in upstream SillyTavern: it can access the DOM, globals, browser storage, network, and credentials available to same-origin scripts. This module does not claim sandbox isolation.

## Supported remote sources

- Public GitHub repository install/update prefers jsDelivr's CORS file catalog and single-file CDN. An omitted branch resolves through jsDelivr `HEAD`, so ordinary installation consumes no GitHub REST quota. If the jsDelivr catalog is unavailable or rejects an oversized package, the gateway makes one recursive GitHub Tree API request, filters non-runtime source maps/Finder metadata, and still downloads each file from jsDelivr first. A failed jsDelivr file request falls back to `raw.githubusercontent.com`, which supports browser CORS and does not consume GitHub REST's 60-requests/hour/IP core quota. Truncated trees and existing package/file safety limits remain hard failures. The branch/tag UI also uses GitHub REST and degrades to the current ref when rate-limited; rate-limit errors expose the remaining count and reset time when GitHub provides them.
- Public GitLab repository URLs use GitLab's CORS REST/archive endpoints.
- Direct HTTPS `.zip` URLs are supported when the host permits browser CORS. HTTP is accepted only for localhost development and browser tests.

No CORS proxy or private-repository credential relay exists. A remote host that blocks CORS, TLS, Private Network Access, or anonymous downloads cannot be installed by this pure frontend.

## Original package format

Packages use SillyTavern's existing root `manifest.json`, including `display_name`, `version`, `author`, `js`, `css`, `i18n`, `requires`, `optional`, `dependencies`, `hooks`, and future opaque fields. M11 validates only structural and resource safety; all extension behavior remains owned by the upstream loader.

Archives and remote file catalogs are bounded by compressed size, expanded size, per-file size, file count, path length, and compression ratio. Absolute paths, drive paths, backslashes, control characters, `.`/`..`, zip-slip, duplicate Unicode/case paths, missing manifest entries, and unsupported URLs are rejected.

## Lifecycle

The unchanged Legacy UI can now use:

- `GET /api/extensions/discover`
- `POST /api/extensions/install`
- `POST /api/extensions/version`
- `POST /api/extensions/update`
- `POST /api/extensions/branches`
- `POST /api/extensions/switch`
- `POST /api/extensions/move`
- `POST /api/extensions/delete`

Install, update, and switch save complete validated snapshots to M13. Stable extension identity is derived from the canonical repository URL; folder/display name and branch are separate. Operations for one extension are serialized. Updates preserve enabled state and installation time.

`local` and `global` are compatibility scope labels inside one browser Profile. `move` changes that label without copying blobs because the pure frontend has no multi-user server directory.

## Storage

Registry records use the existing module-scoped records store (`registry-v2/<stable id>`). Package files use M13's existing `library` blobs/index and are served by the one shared Assets Service Worker. No Object Store, database version, root Worker, plugin KV store, or second permission system is added.

Settings remains the owner of `extension_settings.disabledExtensions`; M11 synchronizes it with registry enabled state. Built-ins come from the generated 14-entry trusted manifest and cannot be deleted.

## Validation

- Unit/integration tests cover original manifests, CORS source adapters, ZIP security, registry fallback, all lifecycle routes, branch/scope changes, update stability, and M13 resource paths.
- A live validation run downloaded `https://github.com/Lianues/cocktail` through browser-CORS endpoints and validated its original manifest and resources.
- Production Chrome verifies the original warning, installation, manifest/JS/CSS loading, install/enable/disable/delete hooks, update detection, branch/switch/move routes, removal, IndexedDB persistence, and zero runtime/console/network compatibility errors.

Node server plugins, npm install scripts, arbitrary server routes, private repository proxies, and non-CORS Git hosts remain outside a pure-browser extension system.
