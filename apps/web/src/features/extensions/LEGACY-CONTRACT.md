# M11 Legacy Contract

## Upstream ownership

`public/scripts/extensions.js` remains authoritative for the extension manager UI, `thirdPartyExtensionWarning`, manifest ordering/dependencies, JS/CSS/i18n loading, hooks, enable/disable state, update prompts, and same-context execution.

The browser module owns the former server boundary and serves installed files at the exact path expected by upstream:

```text
/scripts/extensions/third-party/<folder>/<resource>
```

## HTTP routes

| Route                           | Request                              | Browser response                                                                                                      |
| ------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `GET /api/extensions/discover`  | none                                 | `{name,type}[]` for 14 built-ins and browser-installed third-party packages                                           |
| `POST /api/extensions/install`  | `{url,global,branch}`                | `{version,author,display_name,extensionPath,folderName}` after CORS fetch, validation, M13 save, and registry install |
| `POST /api/extensions/version`  | `{extensionName,global}`             | `{currentBranchName,currentCommitHash,isUpToDate,remoteUrl}` from current browser-visible snapshot                    |
| `POST /api/extensions/update`   | `{extensionName,global}`             | `{shortCommitHash,extensionPath,isUpToDate,remoteUrl}` after validated replacement or no-op                           |
| `POST /api/extensions/branches` | `{extensionName,global}`             | `{current,commit,name,label}[]`; current-only fallback when a host cannot expose refs                                 |
| `POST /api/extensions/switch`   | `{extensionName,branch,global}`      | `204` after downloading and replacing the selected ref                                                                |
| `POST /api/extensions/move`     | `{extensionName,source,destination}` | `204` after changing the browser compatibility scope label                                                            |
| `POST /api/extensions/delete`   | `{extensionName,global}`             | text success after registry and M13 package removal; built-ins return `403`                                           |

`POST /api/sd/comfy/workflows` remains an empty startup compatibility response and does not claim that Stable Diffusion generation is migrated.

## Source mapping

- GitHub repositories: CORS GitHub metadata/refs when available; jsDelivr CORS listing and files for snapshots.
- GitLab repositories: CORS project/commit/refs/archive API.
- Other hosts: direct CORS-enabled `.zip` only.

The implementation downloads immutable validated snapshots rather than pretending a browser can run `git clone`. `currentCommitHash` is the remote revision when available, otherwise a deterministic browser-visible snapshot/archive hash.

## Scope semantics

The original server's `local` and `global` directories represent different user scopes. A standalone browser has one Profile, so M11 stores the requested scope as compatibility metadata and exposes it through discover. `move` does not duplicate Blob data or create a multi-user ACL.

## Security compatibility

Original third-party extensions are intentionally returned by discover and loaded in the top-level page after the original warning is accepted. They are not sandboxed and may access local data and credentials. See `THREAT-MODEL.md`.

Node plugins, npm install scripts, arbitrary server routes, private Git credentials, CORS proxying, and non-CORS remotes are not emulated.
