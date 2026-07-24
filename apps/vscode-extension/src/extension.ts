import path from 'node:path';

import * as vscode from 'vscode';

import { PackagedWebServer } from './static-server.js';

const VIEW_ID = 'pureTavern.launcher';
const PANEL_TYPE = 'pureTavern.app';
const WEBVIEW_PORT = 43110;

class PureTavernPanelController implements vscode.Disposable {
  readonly #context: vscode.ExtensionContext;
  readonly #server: PackagedWebServer;
  #panel: vscode.WebviewPanel | undefined;
  #opening: Promise<void> | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.#context = context;
    this.#server = new PackagedWebServer(path.join(context.extensionPath, 'dist', 'web'));
  }

  async openOrReveal(): Promise<void> {
    if (this.#panel) {
      this.#panel.reveal(vscode.ViewColumn.One, false);
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      return;
    }
    if (this.#opening) return this.#opening;
    this.#opening = this.#createPanel();
    try {
      await this.#opening;
    } finally {
      this.#opening = undefined;
    }
  }

  async #createPanel(): Promise<void> {
    const extensionHostPort = await this.#server.start();
    const panel = vscode.window.createWebviewPanel(
      PANEL_TYPE,
      'PureTavern',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        portMapping: [{ webviewPort: WEBVIEW_PORT, extensionHostPort }],
      },
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.#context.extensionUri, 'media', 'pt-tab-light.svg'),
      dark: vscode.Uri.joinPath(this.#context.extensionUri, 'media', 'pt-tab-dark.svg'),
    };
    panel.webview.html = panelHtml();
    panel.onDidDispose(() => {
      this.#panel = undefined;
    });
    this.#panel = panel;
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
  }

  dispose(): void {
    this.#opening = undefined;
    this.#panel?.dispose();
    this.#panel = undefined;
    void this.#server.stop();
  }
}

class PureTavernLauncherView implements vscode.WebviewViewProvider {
  readonly #controller: PureTavernPanelController;

  constructor(controller: PureTavernPanelController) {
    this.#controller = controller;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = launcherHtml(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (message === 'open') void this.#controller.openOrReveal();
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.#controller.openOrReveal();
    });
    void this.#controller.openOrReveal();
  }
}

function launcherHtml(webview: vscode.Webview): string {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>body{padding:12px}button{width:100%;padding:8px}</style>
</head>
<body>
  <button id="open" type="button">Open PureTavern</button>
  <script nonce="${nonce}">const vscode=acquireVsCodeApi();document.getElementById('open').addEventListener('click',()=>vscode.postMessage('open'));</script>
</body>
</html>`;
}

function panelHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://localhost:${WEBVIEW_PORT}; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>html,body,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden;background:#111}</style>
</head>
<body>
  <iframe src="http://localhost:${WEBVIEW_PORT}/" title="PureTavern" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
</body>
</html>`;
}

let controller: PureTavernPanelController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  controller = new PureTavernPanelController(context);
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand('pureTavern.open', () => controller?.openOrReveal()),
    vscode.window.registerWebviewViewProvider(VIEW_ID, new PureTavernLauncherView(controller), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
}

export function deactivate(): Thenable<void> | undefined {
  const current = controller;
  controller = undefined;
  current?.dispose();
  return undefined;
}
