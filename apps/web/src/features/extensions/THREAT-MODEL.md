# M11 Threat Model

## Trust decision

SillyTavern extensions are page-context plugins, not isolated web applications. The upstream `installExtension()` flow displays `thirdPartyExtensionWarning` before installing a non-official URL and requires affirmative user consent. Pure Tavern preserves that flow unchanged and does not add a second warning.

After consent, a third-party extension can potentially:

- read or modify the complete DOM and JavaScript globals;
- read Settings, chats, characters, IndexedDB/Blob data, and M14 plaintext credentials;
- wrap `fetch`/XHR or send data to arbitrary network origins allowed by the browser;
- register persistent event handlers and alter prompt/generation behavior;
- exploit vulnerabilities in the page or another trusted extension.

SHA-256/package hashes prove snapshot consistency only. They do not prove author identity, code safety, or absence of malicious behavior.

## Controls

M11 reduces accidental package/source risk without pretending to isolate runtime code:

- only HTTPS remote sources, plus localhost HTTP for development;
- GitHub/GitLab/direct ZIP source allowlist instead of arbitrary URL rewriting;
- no embedded URL credentials, backend CORS proxy, private token relay, Git process, npm scripts, or Node plugin execution;
- archive/file-count, compressed/expanded/per-file byte, path-length, and compression-ratio limits;
- rejection of absolute paths, drives, backslashes, control characters, empty/`.`/`..` segments, zip-slip, case/NFKC conflicts, and missing manifest resources;
- complete package snapshots stored behind M13 stable blob/index ownership;
- built-ins seeded from the audited upstream snapshot and protected from deletion;
- keyed lifecycle serialization and stable identity derived from canonical repository URL;
- Settings-backed enable/disable state and the original extension hooks.

## Residual risks

- User-approved extensions execute with same-origin page authority. There is no meaningful secrecy from them.
- Browser CORS, TLS, Private Network Access, CDN propagation, anonymous API rate limits, and remote host availability can block install/update.
- GitHub's CORS CDN branch view may lag repository updates; version checks compare the snapshot visible to the browser.
- `local`/`global` are compatibility labels in one Profile, not server-wide ACLs.
- A repository can publish a benign version and later replace branch contents. Users must review the source and disable automatic updates when trust is uncertain.
- Dependencies declared by an extension are checked by the unchanged upstream loader; M11 does not download npm/server dependencies.
- A malicious package that passes structural validation is still malicious code once the user authorizes it.

## Not implemented

Pure Tavern does not emulate Node server plugins, arbitrary Express routes, child processes, filesystem access, package-manager installation, server Git credentials, private-repository proxying, or cryptographic author signatures.
