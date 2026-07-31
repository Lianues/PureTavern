# PureTavern for VS Code

Open the complete, packaged PureTavern web application in a VS Code editor tab.

- Extension ID: `lianues.pure-tavern`
- Author: Limerence
- Click the `PT` Activity Bar icon to open or reveal the existing `PureTavern` tab.
- The extension embeds the generic `apps/web/dist` build and does not depend on a hosted website.
- PureTavern Feature Modules remain platform-independent.

## Local generation transport

The extension binds its packaged static server only to `127.0.0.1` and injects a VS Code-only, versioned `pure-tavern-local-backend` bridge before the Legacy Hook. A random per-session token protects the extension-host proxy; the bridge also refuses to initialize when its script is loaded by a different origin. Neither the token nor any VS Code API is compiled into generic `apps/web/dist`.

The extension host validates the final GET/POST request, manually follows safe redirects, filters hop-by-hop/Cookie/CORS headers, forwards ordinary responses and SSE incrementally, and cancels upstream work when the browser request stops. Both “本地后端调用” and the health/proxy hop of “远程后端调用” can therefore reach user-configured HTTP or HTTPS LAN addresses without browser CORS or Mixed Content blocking.

HTTP remains plaintext: proxy access keys, Provider keys, prompts and responses can be observed or modified on the network. Use it only on a trusted test LAN and prefer HTTPS.

## Local package

From the repository root:

```bash
pnpm vscode:package
code --install-extension apps/vscode-extension/release/PureTavern-VSCode-0.1.11.vsix
```

Repository: <https://github.com/Lianues/PureTavern>

License: [AGPL-3.0](./LICENSE)
