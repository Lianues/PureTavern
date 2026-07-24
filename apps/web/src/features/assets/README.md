# Assets feature

M13 browser-local storage and Legacy API compatibility for attachments, user images, backgrounds,
background metadata/folders, persona avatars, expression sprites, and extension assets.

## Storage layout

The feature uses the fixed generic stores without changing the IndexedDB schema:

- blobs: module `assets`, collections `backgrounds`, `attachments`, `user-images`,
  `user-avatars`, `sprites`, and `library`, keyed by stable asset UUID;
- records: module `assets`, collections `index`, `path-aliases`, `background-folders`, and seed state.

M08 consumes a narrow Persona avatar capability. M11 consumes a narrow extension-package capability;
validated iframe/Worker files use `/assets/extensions/<stable-id>/<path>` aliases and remain served by
the same root Service Worker. Neither consumer receives raw access to the Assets stores.

Legacy URLs are aliases in the index. A rename updates alias/metadata without copying the Blob.
Application writes compensate index/alias/blob failures, while resilient adapters fall back to
page memory and expose degradation diagnostics if IndexedDB is unavailable.

Upstream default backgrounds are described by `/__pure_tavern/default-assets.json`. New upstream
files are seeded incrementally; a user's deletion remains a tombstone and is not recreated on every
start.

## Image and input safety

`BrowserImageProcessor` validates PNG/JPEG/GIF/WebP signatures, dimensions, and common animation
markers (GIF/APNG/animated WebP). Avatar crop/resize uses `createImageBitmap` plus
`OffscreenCanvas`/Canvas. If those APIs are unavailable, the request fails with a diagnostic
`IMAGE_PROCESSING_UNSUPPORTED` response rather than pretending that processing succeeded.

All entry points enforce filename/path traversal rules, unsafe extension checks, MIME/signature
checks, per-file limits, and ZIP compressed/expanded byte and file-count limits. Sprite ZIP paths
are checked for zip-slip before extraction.

## Shared Service Worker

Assets owns the one root-scope `/pure-tavern-assets-service-worker.js`. It resolves IndexedDB blobs
for the original URLs used by SillyTavern:

- Character avatars: `/thumbnail?type=avatar` and `/characters/<avatar>`;
- backgrounds and thumbnails;
- persona avatars;
- chat attachments and user images;
- expression sprites;
- extension/library assets.

Characters consumes the typed `AssetServiceWorkerCapability`; it does not install a second worker.
The worker opens the existing database without requesting a version or creating stores, preventing
version conflicts with the application database.

## Browser-only limitations

Remote extension asset downloads use the injected native browser `fetch`. CORS and network errors
are returned explicitly; this module cannot bypass remote CORS policy. Clearing site data removes
IndexedDB blobs and the Service Worker, and browser quota still bounds large local libraries.

The production Chrome gate covers default backgrounds, upload/list/direct URL/thumbnail/rename/
delete, folders, attachments persisted through M05 chat metadata, user images, persona avatars,
sprites, extension assets/packages, Persona alias lifecycle, shared Worker routing, IndexedDB
diagnostics, and zero local 404s.
