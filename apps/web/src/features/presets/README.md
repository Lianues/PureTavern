# Presets feature

Browser-owned prompt presets, themes, Moving UI layouts, and Quick Reply sets.
The module keeps these documents out of the Settings repository while retaining
SillyTavern 1.18.0's Legacy HTTP and bootstrap DTO shapes.

## Supported types

- Completion presets: `kobold`, `novel`, `openai`, `textgenerationwebui`
- Advanced formatting: `instruct`, `context`, `sysprompt`, `reasoning`
- UI data: `theme`, `moving-ui`, `quick-reply`

Every type is namespaced independently. Documents are opaque JSON objects: the
module validates safety/size/depth boundaries but does not normalize prompt or
extension fields.

## Ports and storage

Modern callers depend on `PresetRepository<T>`. The IndexedDB adapter reuses the
application-wide `records` store and writes only namespaced records:

```text
presets / documents / <type>:<stable-id>
presets / aliases / <type>:<legacy-name>
presets / seed-state / <type>
presets / tombstones / <type>:<legacy-name>
```

Aliases decouple stable IDs from display/file names. Writes are serialized, a
save replaces the complete opaque document, and renames migrate aliases without
relying on a filesystem. `ResilientPresetRepository` switches permanently to a
page-memory adapter after an IndexedDB failure and exposes diagnostics.

## Default content

`PresetSeedLoader` provides a versioned manifest containing
`type/name/value/sourceHash`. `PresetSeedService` implements these upgrade rules:

1. missing defaults are inserted;
2. unchanged default-owned records follow a changed source hash;
3. user-saved records are marked modified and are never overwritten;
4. deletes create tombstones and therefore do not reappear during seeding;
5. restore reads the loader's current value regardless of local modification or
   deletion.

The browser adapter reads `/__pure_tavern/default-presets.json`; the build step is
responsible for generating it from the current upstream default-content tree.

## Compatibility

`legacy/register-routes.ts` implements:

- `/api/presets/save`, `/api/presets/delete`, `/api/presets/restore`
- `/api/themes/save`, `/api/themes/delete`
- `/api/quick-replies/save`, `/api/quick-replies/delete`
- `/api/moving-ui/save`

`PresetLegacyBootstrapProvider` produces Settings transport fields without
making Settings own or query preset records. Completion preset arrays contain
JSON strings, matching 1.18.0; advanced formatting, themes, Moving UI, and Quick
Replies are parsed object arrays.

`PresetImportExportService` supports one-document JSON and per-type bundles.
Callers must explicitly choose `overwrite` or `unique` for conflicts. Exports
contain only original documents and names, never internal IDs or metadata.

## Runtime integration and acceptance

`presetsFeature` registers `PresetLegacyBootstrapProvider` as a typed capability. Settings composes
Legacy preset arrays from that provider at request time, without importing this module's storage.
`prepare-legacy-runtime.mjs` generates the default manifest directly from the selected read-only
upstream snapshot, including SHA-256 source hashes for upgrade-safe seed decisions.

The production Chrome gate verifies all 11 default categories, original preset selector population,
original `PresetManager` save/delete/default restore, theme/Quick Reply/Moving UI routes, opaque
field preservation, IndexedDB diagnostics, and zero compatibility requests escaping to the network.
