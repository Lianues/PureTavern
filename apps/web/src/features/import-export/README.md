# M21 Import / Export / Backup

M21 provides a versioned, hashed ZIP archive over all registered browser data modules. It is independent from the first-party management panel and can be reused by modern UI or a future optional backend.

## Stable boundary

`@pure-tavern/contracts` owns the manifest, file descriptors, conflict previews, reports, backup descriptors and transport capabilities. `BackupTransport` stores the complete archive as an opaque object. The current adapter is browser-local IndexedDB; a future server only needs list/upload/download/delete and does not reinterpret module records.

## Archive semantics

- `manifest.json` identifies schema/app/upstream versions, modules, sizes and SHA-256 for every payload.
- Module records and blobs are exported under stable logical paths, not IndexedDB physical keys.
- ZIP path traversal, unsafe paths, duplicate and Unicode/case-conflicting targets, manifest consistency and payload hashes are validated before import.
- Import supports merge, skip, replace-module, replace-all and a guarded replace-local mode that backs up every module (including Secrets) before clearing local data.
- Dry-run preview reports new items, conflicts, unavailable modules, sensitive data and version differences.
- A recovery archive is created before import/restore and an import journal records the active module/stage.

## TauriTavern interop

`tauri-tavern/` converts between module records and the SillyTavern `data/default-user` tree that
TauriTavern's data-migration extension reads and its export scripts produce. The conversion is
semantic, not path rewriting: a character is one `cards` record plus one `avatars` blob here and a
single PNG with an embedded card there, so every module has its own mapping.

- Export produces `data/default-user/...` (`characters/`, `chats/<character>/`, `worlds/`, the
  preset directories, `backgrounds/`, `User Avatars/`, `user/images/`, `user/files/`, `assets/`,
  `settings.json`, `secrets.json`, `stats.json`, `image-metadata.json`). Local recovery points can
  be converted without being restored first.
- `image-metadata.json` carries the background virtual folders and each image's dimensions,
  aspect ratio and dominant colour. It maps onto the `background-folders` records plus
  `AssetRecord.folderIds` / `AssetRecord.imageMetadata`; without it an imported library loses all
  of its grouping.
- Import turns the tree back into standard archive entries and hands them to `ArchiveService`, so
  conflict preview, the pre-import recovery point, the import journal and the four conflict
  strategies behave exactly as they do for a native archive.
- Record ids are derived from natural keys (avatar file name, chat file name, world book file name,
  preset type/name, asset path) and reuse any matching local id, so re-importing the same package
  updates records instead of duplicating them.
- Personas have no file of their own; they travel inside `settings.json` and `User Avatars/`.
- Third-party extensions move as installed packages. `extensions` owns validation and identity via
  `ExtensionMigrationCapability`, so a migrated extension is byte-for-byte the same registry record
  a normal remote install produces — same `legacy.<hash>` id derived from the repository URL, so
  update checks keep working and a later reinstall collides instead of duplicating. The repository,
  ref and commit come from TauriTavern's `data/_tauritavern/extension-sources/`, falling back to
  `manifest.homePage`; an extension with neither is skipped and named. Package files are stored as
  `library` assets under `/scripts/extensions/third-party/...`, exactly where the unchanged
  upstream loader looks. Every file in the folder is carried over verbatim — migration does not
  decide which of the user's files are worth keeping. Local migration and remote installation use
  the same path-safety and manifest validation without frontend-only byte or file-count quotas.
- Every file in a package is accounted for. Extensions, host-application files and unmapped
  directories (`groups/`, `user/workflows/`) land in the `extensions` / `unsupported` rows with
  example paths; regenerable data (`thumbnails/`, `backups/`, `vectors/`) lands in `derived`. The
  per-module `files` counts sum to the package's file count, so nothing disappears unreported.

## Privacy

Secrets are excluded by default. Explicit inclusion produces a plaintext archive and must be confirmed by the UI. Archive hashes provide integrity only; they are not encryption, signatures or author authentication.

## Durability

The app requests persistent storage at startup and again whenever the panel is opened. In a browser,
failing to get it means best-effort: a browser under disk pressure may evict the whole database
without notice, so the panel turns that state red.

Inside the Capacitor shell the warning is deliberately suppressed. Android WebView exposes
`persist()` but has no flow that can ever grant it, and the data lives in the app's private
directory rather than a shared browser profile, so the browser-eviction risk the warning describes
does not apply. A permanent red alarm the user cannot act on only teaches them to ignore warnings.
The panel reports `应用私有存储` there and names the risks that are real on that platform: clearing
app data, or uninstalling. Container detection is re-evaluated on every read because the native
bridge may not be injected yet during early startup.

PureTavern does not impose a feature-specific byte, file-count or compression-ratio quota on archive
import/export. Format, path and integrity validation still applies. The practical ceiling is browser
memory: decoding reads the whole archive in and inflates it in memory, so a multi-gigabyte package
may exhaust the tab.

## Storage

M21 local backups use its own generic records/blobs namespace. The default retention is five archives. File System Access is an enhancement; standard browser downloads and file inputs remain available.
