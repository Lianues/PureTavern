# PureTavern for VS Code

Open the complete, packaged PureTavern web application in a VS Code editor tab.

- Extension ID: `lianues.pure-tavern`
- Author: Limerence
- Click the `PT` Activity Bar icon to open or reveal the existing `PureTavern` tab.
- The extension embeds the generic `apps/web/dist` build and does not depend on a hosted website.
- PureTavern Feature Modules remain platform-independent.

## Local package

From the repository root:

```bash
pnpm vscode:package
code --install-extension apps/vscode-extension/release/PureTavern-VSCode-0.1.3.vsix
```

Repository: <https://github.com/Lianues/PureTavern>

License: [AGPL-3.0](./LICENSE)
