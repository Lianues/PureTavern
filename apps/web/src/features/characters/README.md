# Characters feature

M04 browser-side character module for the Legacy SillyTavern UI.

## Scope

Implemented in this module:

- `/api/characters/all`, `get`, `create`, `edit`, `rename`, `edit-avatar`, `edit-attribute`, `merge-attributes`, `duplicate`, `import`, `export`, `delete`.
- Character metadata in the generic `records` store: `characters / cards / <stable-id>`.
- Avatar/card PNG blobs in the generic `blobs` store: `characters / avatars / <avatar-file>`.
- JSON and PNG Character Card V2/V3 import/export, including `chara` and `ccv3` PNG tEXt chunks.
- A root-scoped Service Worker declared by `runtime-assets.json` that serves original Legacy avatar URLs:
  - `/thumbnail?type=avatar&file=<avatar.png>`
  - `/characters/<avatar.png>`

M05 owns real chat history. `/api/characters/chats` intentionally returns an empty list for compatibility instead of pretending chats have migrated.

## Notes

Display names and avatar file names are separate. Create, edit, and edit-avatar forward the Legacy `crop` query to the shared Assets avatar processor, which matches the upstream PNG/crop/512×768 `cover` behavior. Duplicate copies the stored avatar payload directly without running image processing again. Rename updates the card display name and moves/copies the blob to a unique avatar file, preventing blob loss. If IndexedDB is unavailable, repositories degrade to page-memory storage and report diagnostics; Service Worker avatar serving requires IndexedDB, so image persistence is only guaranteed in the normal browser-ready path.

The Service Worker handles only the two avatar URL shapes above. All other requests fall through to the browser/network.
