# Extensions threat model

## Trust classes

### Trusted Legacy built-ins

The allowlist in `trusted-builtins.ts` represents code physically shipped in the audited upstream snapshot under `/scripts/extensions/<name>/`. Upstream `extensions.js` injects each discovered script as a module into the page and many built-ins directly use DOM, globals, settings, fetch, and other Legacy modules. Preserving that behavior requires same-page authority.

Only records with all three properties are eligible for `same-context`:

1. `trust === "trusted-builtin"`;
2. source is `upstream-snapshot`;
3. normalized entrypoint type is `same-context`.

The user package parser cannot construct such a record. Built-ins cannot be deleted through the browser route. Changing a built-in allowlist is therefore a release/code-review action, not an install-time user assertion.

Capability grants cannot contain same-context code after it starts; the trust boundary is the reviewed snapshot itself. `dom:legacy` in a built-in manifest documents authority rather than pretending to sandbox it.

### User-imported third-party extensions

User packages are always `untrusted-user`, disabled after install, and limited to `iframe` or `worker` entrypoints. Iframes are planned with `sandbox="allow-scripts"` and no `allow-same-origin`; Workers use their own global. The Legacy `/discover` response intentionally omits user packages because upstream treats every returned folder as trusted page-context code.

Package bytes are stored only through `ExtensionPackageAssets`. The registry stores metadata and hashes, not executable Blob data.

## Protected assets

- application secrets and provider keys;
- arbitrary network access and authenticated browser requests;
- top-level DOM and Legacy globals;
- records owned by Settings, Assets, chats, characters, or any other feature;
- another extension's KV namespace;
- extension registry/permission records;
- origin identity and sandbox response correlation.

## Controls

- stable, validated extension IDs separate from display/path aliases;
- no remote URL install, Git update, branch, move, process, or filesystem emulation;
- package file-count/size/manifest/path/hash/entrypoint/conflict validation before persistence;
- explicit requested capability plus explicit persisted grant;
- default denial for every absent grant;
- plugin KV operations bind the extension ID in the host, not in sandbox payload;
- exact message source and origin checks (no `*` acceptance in the protocol);
- protocol/session/extension/request correlation and finite request timeout;
- capability allowlist and host handler allowlist;
- non-2xx `unsupported` responses for server-only Legacy operations;
- in-memory degradation for records failures without granting extra authority.

## Residual risks and assumptions

- A reviewed built-in has full page authority and can exfiltrate data; update the snapshot only through normal release review.
- Browser sandbox strength depends on the embedding code applying the returned execution plan exactly. Do not add `allow-same-origin` to untrusted iframes.
- A Blob/object URL must be revoked by the injected Assets implementation when replaced or removed.
- Hash validation proves package consistency, not author identity or safety. There is no signature trust store in M11.
- A granted `network:fetch`, `secrets:read`, `dom:legacy`, or `storage:modules` handler is security-critical. M11 supplies none by default.
- Browser storage can be cleared, quota-limited, or unavailable. Memory fallback is session-only.
- Same-origin browser code outside a sandbox could call feature APIs if a future UI exposes them carelessly; central integration must keep capability handles out of untrusted globals.
- CORS still applies. This module does not proxy requests or claim otherwise.
