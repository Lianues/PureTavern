# Audited Legacy extensions contract

Sources audited read-only:

- `apps/web/legacy/upstream/public/scripts/extensions.js`
- `apps/web/legacy/upstream/public/scripts/extensions/**/manifest.json`
- reference `SillyTavern-1.18.0/src/endpoints/extensions.js`
- reference `SillyTavern-1.18.0/src/plugin-loader.js`
- reference `SillyTavern-1.18.0/plugins.js`

## Upstream browser flow

1. `GET /api/extensions/discover`
2. Response: `{ name: string, type: "system" | "local" | "global" }[]`
3. For every name, browser fetches `/scripts/extensions/<name>/manifest.json`.
4. If enabled/requirements pass, browser injects:
   - module script `/scripts/extensions/<name>/<manifest.js>`;
   - stylesheet `/scripts/extensions/<name>/<manifest.css>`;
   - optional i18n file;
   - exported manifest hooks (`install`, `update`, `delete`, `clean`, `enable`, `disable`, `activate`).

That is why untrusted packages are not returned by M11's Legacy discover route.

Observed manifest fields include `display_name`, `loading_order`, `requires`, `optional`, `dependencies`, `minimum_client_version`, `js`, `css`, `i18n`, `author`, `version`, `homePage`, `auto_update`, `generate_interceptor`, and `hooks`.

## Reference server routes and DTOs

Mounted under `/api/extensions`:

| Route            | Request                              | Successful response in reference server                                  | Browser-only result                                              |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `GET /discover`  | none                                 | `{name,type}[]` from system/user/global directories                      | implemented; trusted same-context built-ins only                 |
| `POST /install`  | `{url,global,branch}`                | `{version,author,display_name,extensionPath,folderName}` after Git clone | `501 unsupported`                                                |
| `POST /update`   | `{extensionName,global}`             | `{shortCommitHash,extensionPath,isUpToDate,remoteUrl}` after fetch/pull  | `501 unsupported`                                                |
| `POST /branches` | `{extensionName,global}`             | `{current,commit,name,label}[]`                                          | `501 unsupported`                                                |
| `POST /switch`   | `{extensionName,branch,global}`      | `204` after Git checkout                                                 | `501 unsupported`                                                |
| `POST /move`     | `{extensionName,source,destination}` | `204` after filesystem copy/remove                                       | `501 unsupported`                                                |
| `POST /version`  | `{extensionName,global}`             | `{currentBranchName,currentCommitHash,isUpToDate,remoteUrl}`             | implemented for local metadata; no remote check                  |
| `POST /delete`   | `{extensionName,global}`             | text after recursive filesystem removal                                  | implemented for removable local records/assets; built-ins denied |

M11 local-package version DTO uses an empty branch/remote URL, package SHA-256 as `currentCommitHash`, and `isUpToDate: true` because there is no configured remote. A `global: true` request is rejected as unsupported because the browser app has no server-wide multi-user directory.

The reference server plugin loader is a separate, disabled-by-default Node authority: it dynamically imports files/npm packages, runs `init(router)`, mounts `/api/plugins/<id>`, runs exit hooks, and optionally performs Git updates. None of those server-plugin semantics are emulated in browser code.
