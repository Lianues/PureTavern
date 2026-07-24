# World Books feature

M07 browser-owned World Books storage and Legacy compatibility module. It keeps the original
SillyTavern editor and matching implementation unchanged while replacing its server persistence
with browser storage.

## Storage and routes

- `world-books / books / <stable-book-id>` stores the opaque document and timestamps.
- `world-books / aliases / <legacy-file-id>` maps the Legacy name to the stable ID.
- IndexedDB-backed CRUD degrades to page-memory storage and exposes diagnostics when persistence is
  unavailable.
- Legacy routes implement `/api/worldinfo/list`, `get`, `edit`, `delete`, and `import`.
- Native `{ entries }` JSON and already converted Novel/Agnai/Risu `convertedData` are accepted.
- Unknown top-level, entry and extension fields round-trip unchanged.

Names are safe logical file IDs rather than filesystem paths. Editing/importing an existing alias
replaces that complete book while retaining its stable ID.

## Integration boundary

`worldBooksFeature` registers a `WorldNamesCapability`. Settings reads that capability at request
time to compose the Legacy `world_names` bootstrap field; neither module imports the other's
repository. The matching algorithm stays in the unmodified `/scripts/world-info.js`
(`checkWorldInfo` / `getWorldInfoPrompt`) and consumes documents through the Legacy routes.

The production Chrome gate verifies original-editor rendering, CRUD and JSON import, keyword,
constant and disabled-entry matching, opaque-field preservation, Settings world-name composition,
and Character Card embedded lore import.
