# M23 Stats

M23 keeps the original `public/scripts/stats.js` UI and replaces the former discarded compatibility response with browser persistence.

## Storage

- IndexedDB generic records: module `stats`, collection `documents`, id `current`.
- A resilient memory fallback is used when persistent storage is unavailable.
- No new database store/version and no backend service are introduced.

## Compatibility

The feature implements the original routes:

- `POST /api/stats/get`
- `POST /api/stats/update`
- `POST /api/stats/recreate`

Incremental updates are still issued by unchanged Legacy `statMesProcess()` without awaiting the request. Stats never participate in the M05 chat save transaction. Recreate consumes only `ChatStatsSourceCapability`, a read-only snapshot of stable chat metadata and opaque messages, and does not import Chats or Characters internals.

The derived document follows SillyTavern 1.18.0 semantics for ASCII word counts, base messages, swipes, `swipe_info`, generation time, first/last chat dates and chat byte size. Duplicate non-empty message text is counted once per character, matching the original server hash-based deduplication.

## Limits

Statistics are local and do not aggregate across devices. A browser crash can occur between a chat save and the fire-and-forget incremental update; `/api/stats/recreate` repairs the document from persisted chats. Missing or malformed optional message timestamps/generation fields contribute zero rather than blocking recreation.
