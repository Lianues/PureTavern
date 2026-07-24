import path from 'node:path';

import * as vscode from 'vscode';

import { PackagedWebServer } from './static-server.js';

const VIEW_ID = 'pureTavern.launcher';
const PANEL_TYPE = 'pureTavern.app';

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
    const appUri = await vscode.env.asExternalUri(
      vscode.Uri.parse(`http://127.0.0.1:${extensionHostPort}/`),
    );
    const panel = vscode.window.createWebviewPanel(
      PANEL_TYPE,
      'PureTavern',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.#context.extensionUri, 'media', 'pt-tab-light.svg'),
      dark: vscode.Uri.joinPath(this.#context.extensionUri, 'media', 'pt-tab-dark.svg'),
    };
    panel.webview.html = panelHtml(panel.webview, appUri);
    panel.onDidDispose(() => {
      this.#panel = undefined;
    });
    this.#panel = panel;
  }

  dispose(): void {
    this.#opening = undefined;
    this.#panel?.dispose();
    this.#panel = undefined;
    void this.#server.stop();
  }
}

function openWithFeedback(controller: PureTavernPanelController): void {
  void controller.openOrReveal().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`PureTavern could not open: ${detail}`);
  });
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
      if (message === 'open') openWithFeedback(this.#controller);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) openWithFeedback(this.#controller);
    });
    openWithFeedback(this.#controller);
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

function panelHtml(webview: vscode.Webview, appUri: vscode.Uri): string {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const appUrl = escapeHtml(appUri.toString(true));
  const frameSource = escapeHtml(`${appUri.scheme}://${appUri.authority}`);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${frameSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    html,body{width:100%;height:100%;margin:0;overflow:hidden;background:var(--vscode-editor-background,#111);color:var(--vscode-editor-foreground,#ddd);font-family:var(--vscode-font-family,sans-serif)}
    iframe{width:100%;height:100%;margin:0;border:0;background:#111;opacity:0;transition:opacity .12s ease}
    iframe.ready{opacity:1}
    #status{position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center}
    #status[hidden]{display:none}
    #status.error{color:var(--vscode-errorForeground,#f48771)}
  </style>
</head>
<body>
  <div id="status" role="status">Loading PureTavern…</div>
  <iframe id="app" src="${appUrl}" title="PureTavern" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
  <script nonce="${nonce}">
    const frame=document.getElementById('app');
    const status=document.getElementById('status');
    const timeout=setTimeout(()=>{status.textContent='PureTavern is taking longer than expected to load.';status.classList.add('error');},15000);
    frame.addEventListener('load',()=>{clearTimeout(timeout);frame.classList.add('ready');status.hidden=true;},{once:true});
    frame.addEventListener('error',()=>{clearTimeout(timeout);status.textContent='PureTavern could not be loaded. Reopen the tab to retry.';status.classList.add('error');},{once:true});
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
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
