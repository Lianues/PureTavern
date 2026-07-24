# Personas feature

M08 implements browser-local Persona metadata while preserving the SillyTavern 1.18.0 Settings
shape. This directory intentionally registers no HTTP route: upstream has no Persona-specific API.

## Audited Legacy contract

`public/scripts/personas.js` stores the active alias in top-level `settings.user_avatar` and the active
name in `settings.username`. Persona metadata lives under `settings.power_user`:

- `personas`: `{ [avatarFilename]: displayName }`;
- `default_persona`: avatar filename or `null`/absent;
- `persona_descriptions`: descriptors keyed by avatar filename. Known fields are `description`,
  `position` (`0`, deprecated `1`, `2`, `3`, `4`, `9`), `depth` (default `2`), `role` (default
  `0`), `lorebook`, `title`, and `connections`;
- `connections`: `{ type: 'character' | 'group', id }[]`, where a character id is its avatar key and
  a group id is the group id;
- active descriptor mirrors: `persona_description`, `persona_description_position`,
  `persona_description_depth`, `persona_description_role`, `persona_description_lorebook`;
- preferences observed by upstream: `persona_show_notifications`, `persona_sort_order`,
  `persona_allow_multi_connections`, and `persona_auto_lock`.

Chat-specific locking is **not** a Settings Persona field: upstream writes the selected avatar alias
to `chat_metadata.persona`, which remains a Chats integration concern.

Avatar list/upload/delete is not a Persona API. Upstream calls the central Assets routes
`/api/avatars/get`, `/api/avatars/upload`, `/api/avatars/delete`, renders `/User Avatars/<file>`, and
uses `getThumbnailUrl('persona', file)`. M08 therefore consumes only the injected
`PersonaAssetRepository`; it does not duplicate M13 or invent endpoints.

## Domain and storage

A Persona has an immutable browser-local UUID plus a mutable Legacy `avatarAlias`. Display name,
stable id, and file alias are separate. Complete descriptor objects and future `persona_*` Settings
fields are cloned as opaque JSON so unknown extension fields survive import, CRUD updates, and
output.

The fixed application database schema is reused. Module `personas` stores one serialized aggregate
at generic records collection `state`, id `current`; no Object Store or database version is added.
Repository and service writes are queued. If IndexedDB fails, `ResilientPersonaRepository` switches
to page-session memory and exposes `status/backend/message/lastSavedAt` diagnostics.

## Settings and Assets integration

`PersonaService` implements both `LegacyPersonaStateProvider` and `LegacyPersonaStateComposer` and
registers `LegacyPersonaStateCapability`. Settings now hydrates M08 on the first complete document,
imports every Legacy save in the same ordered chain, and composes M08 state for get/snapshot output.
Snapshot restore resets hydration so the restored full document becomes the next source of truth.

The default feature consumes M13 `PersonaAvatarAssetsCapability`: default avatar checks, create,
replace, alias move and delete remain owned by the central Assets index/Blob stores. Persona metadata
never accesses the Blob store. Chats continues to preserve `chat_metadata.persona` as the original
opaque avatar-alias field.

Composition starts from and returns the complete Settings document, preserving unrelated root and
`power_user` fields. Deleting or clearing the selected Persona falls back to the real upstream local
identity defaults (`User`, `user-default.png`) unless a different local identity was imported while
no Persona was selected. A missing selected/default avatar asks M13 to materialize its default image
under the alias; if that is unavailable, selection/default is cleared and diagnostics report the
missing alias.

## Browser acceptance and limitations

The production Chrome gate uses the unchanged `personas.js` to upload/create/select a Persona, set it
as default, bind it to a character, render the original card/thumbnail, reload it from Settings,
delete it, and verify default/local-user fallback. Without M13, custom avatar operations degrade
explicitly; no alternative Persona Blob store is created.
