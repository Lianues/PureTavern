# PureTavern Android local server

`local-server` is an Android Library used only by the PureTavern Capacitor app. Despite the directory name, it does **not** open a loopback TCP port. The frontend sends its already-final provider request to a directly registered Capacitor plugin, and the plugin performs that request with `HttpURLConnection`.

This keeps provider behavior in `apps/web/src/features/generation`: Claude, Gemini, OpenRouter, Vertex and other Chat Completion request construction is not duplicated in Java. The Android code is transport-only and has no runtime Maven dependency beyond the existing `:capacitor-android` module.

The Capacitor-specific adapter lives beside this module in `web/local-backend-bridge.js`. After `cap sync android`, `apps/mobile/scripts/install-android-local-backend-bridge.mjs` copies it only into Android assets and inserts it before the Legacy Hook. The generic `apps/web/dist` therefore contains only the versioned local-backend port and no Android or Tauri adapter.

## Bridge protocol

The frontend calls `PureTavernLocalServer.startRequest` with:

- an opaque request ID;
- the final HTTP(S) URL;
- `GET` or `POST`;
- final request headers;
- an optional UTF-8 string body.

The plugin emits `pureTavernLocalServerResponse` events keyed by request ID:

1. one `headers` event;
2. ordered `chunk` events containing at most 32 KiB as base64;
3. one `complete` or `error` event.

The frontend rebuilds a standard `Response` and `ReadableStream`, so JSON and SSE use the same Generation pipeline as direct and remote modes. `AbortSignal` and stream cancellation call `cancelRequest`, which closes the active input stream and disconnects `HttpURLConnection`.

## Network and security boundaries

- Only absolute `http://` and `https://` URLs without embedded credentials or fragments are accepted.
- Redirects are followed manually, up to 10 hops. A cross-origin redirect removes `Authorization`, `Cookie`, and `Proxy-Authorization`; POST is changed to GET for HTTP 301/302/303.
- `Host`, `Content-Length`, hop-by-hop request headers, `Set-Cookie`, hop-by-hop response headers, and upstream CORS headers are not bridged.
- URLs, provider keys, headers, and bodies are not logged or retained after a request.
- Four native worker threads bound concurrent blocking requests.

The library manifest enables cleartext traffic because users may target an HTTP provider on their LAN. This weakens Android's application-wide cleartext policy: HTTP traffic can be observed or modified on the network. HTTPS should be used whenever the provider supports it.

## Verification

From `apps/mobile`:

```sh
node scripts/run-gradle.mjs local-server:testDebugUnitTest
pnpm build:android:debug
```

The first command runs the native redirect, header-filtering, chunking, cancellation, and request-validation tests. The second compiles the library into the debug APK.
