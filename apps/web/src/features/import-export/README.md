# M21 Import / Export / Backup

M21 provides a versioned, hashed ZIP archive over all registered browser data modules. It is independent from the first-party management panel and can be reused by modern UI or a future optional backend.

## Stable boundary

`@pure-tavern/contracts` owns the manifest, file descriptors, conflict previews, reports, backup descriptors and transport capabilities. `BackupTransport` stores the complete archive as an opaque object. The current adapter is browser-local IndexedDB; a future server only needs list/upload/download/delete and does not reinterpret module records.

## Archive semantics

- `manifest.json` identifies schema/app/upstream versions, modules, sizes and SHA-256 for every payload.
- Module records and blobs are exported under stable logical paths, not IndexedDB physical keys.
- ZIP path traversal, duplicates, Unicode/case conflicts, file count, expanded size, file size, compression ratio and hashes are validated before import.
- Import supports merge, skip, replace-module and replace-all.
- Dry-run preview reports new items, conflicts, unavailable modules, sensitive data and version differences.
- A recovery archive is created before import/restore and an import journal records the active module/stage.

## Privacy

Secrets are excluded by default. Explicit inclusion produces a plaintext archive and must be confirmed by the UI. Archive hashes provide integrity only; they are not encryption, signatures or author authentication.

## Storage

M21 local backups use its own generic records/blobs namespace. The default retention is five archives. File System Access is an enhancement; standard browser downloads and file inputs remain available.
