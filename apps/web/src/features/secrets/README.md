# M14 Secrets / local credentials

This feature preserves SillyTavern 1.18.0's secret manager DTO and UI while storing credentials locally in the browser.

## Scope

- Eight `/api/secrets/*` compatibility routes: write, read, view, find, delete, rotate, rename and settings.
- Multiple labeled values per key with one active value.
- `CredentialResolverCapability` for future M12 providers.
- Generic records storage at `secrets / store / current` with page-memory fallback.
- No Web Crypto, unlock password, remote Vault, backend proxy or synchronization.

## Deliberate security boundary

Values are plaintext in IndexedDB. They can be read by DevTools, a copied browser profile, browser extensions, XSS and code executing in the same page. Once M12 sends a request, same-context code can also wrap `fetch`/XHR and inspect authorization data. This feature must never be described as a secure Vault.

The Legacy `read` route returns masked display values. Explicit `find`, `view` and the internal credential resolver return plaintext because the original manager and future providers need it. `allowKeysExposure` is therefore reported as `true` in this browser-only runtime. Diagnostics contain storage status and the `plaintext` policy but never key names or values.

Untrusted M11 extensions do not receive this capability automatically. Their existing `secrets:read` permission remains denied unless a future audited host handler explicitly connects it.

## Degradation

If IndexedDB fails, the repository switches permanently to page memory for the current page. New values then disappear after refresh. Diagnostics report `backend: "memory"` and never include the failed credential payload.
