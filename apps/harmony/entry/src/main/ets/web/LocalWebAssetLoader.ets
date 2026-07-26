import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { WEB_ASSET_PATHS } from '../generated/WebAssetManifest';

const APP_ORIGIN: string = 'https://puretavern.local';
const RAWFILE_ROOT: string = 'web/';
const LOG_DOMAIN: number = 0x5054;
const LOG_TAG: string = 'PureTavernAssetLoader';

const MIME_TYPES: Map<string, string> = new Map([
  ['css', 'text/css'],
  ['gif', 'image/gif'],
  ['html', 'text/html'],
  ['ico', 'image/x-icon'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['js', 'application/javascript'],
  ['json', 'application/json'],
  ['map', 'application/json'],
  ['mjs', 'application/javascript'],
  ['mp3', 'audio/mpeg'],
  ['mp4', 'video/mp4'],
  ['ogg', 'audio/ogg'],
  ['otf', 'font/otf'],
  ['png', 'image/png'],
  ['svg', 'image/svg+xml'],
  ['ttf', 'font/ttf'],
  ['txt', 'text/plain'],
  ['wasm', 'application/wasm'],
  ['webm', 'video/webm'],
  ['webp', 'image/webp'],
  ['woff', 'font/woff'],
  ['woff2', 'font/woff2']
]);

export class LocalWebAssetLoader {
  private readonly context: common.UIAbilityContext;
  private readonly serviceWorkerSchemeHandler: webview.WebSchemeHandler = new webview.WebSchemeHandler();

  constructor(context: common.UIAbilityContext) {
    this.context = context;
    this.serviceWorkerSchemeHandler.onRequestStart(
      (request: webview.WebSchemeHandlerRequest, handler: webview.WebResourceHandler): boolean =>
        this.interceptServiceWorkerRequest(request, handler),
    );
  }

  registerServiceWorkerSchemeHandler(): void {
    webview.WebviewController.clearServiceWorkerWebSchemeHandler();
    webview.WebviewController.setServiceWorkerWebSchemeHandler('https', this.serviceWorkerSchemeHandler);
  }

  intercept(event: OnInterceptRequestEvent): WebResourceResponse | null {
    const requestUrl = event.request.getRequestUrl();
    const assetPath = this.resolveAssetPath(requestUrl);
    if (assetPath === null) {
      return null;
    }
    if (!WEB_ASSET_PATHS.has(assetPath)) {
      return this.errorResponse(404, 'Not Found');
    }

    try {
      const bytes = this.readAsset(assetPath);
      const response = new WebResourceResponse();
      response.setResponseData(this.copyBytes(bytes));
      response.setResponseMimeType(this.mimeType(assetPath));
      response.setResponseEncoding('utf-8');
      response.setResponseCode(200);
      response.setReasonMessage('OK');
      return response;
    } catch (error) {
      console.error(`PureTavern rawfile read failed: ${assetPath}; ${JSON.stringify(error)}`);
      return this.errorResponse(500, 'Internal Server Error');
    }
  }

  private interceptServiceWorkerRequest(
    request: webview.WebSchemeHandlerRequest,
    handler: webview.WebResourceHandler,
  ): boolean {
    const requestUrl = request.getRequestUrl();
    const assetPath = this.resolveAssetPath(requestUrl);
    if (assetPath === null) {
      return false;
    }

    if (!WEB_ASSET_PATHS.has(assetPath)) {
      this.finishSchemeResponse(handler, assetPath, 404, 'Not Found', new Uint8Array());
      return true;
    }

    try {
      const bytes = this.readAsset(assetPath);
      this.finishSchemeResponse(handler, assetPath, 200, 'OK', bytes);
    } catch (error) {
      hilog.error(
        LOG_DOMAIN,
        LOG_TAG,
        'service-worker rawfile read failed %{public}s %{public}s',
        assetPath,
        JSON.stringify(error),
      );
      this.finishSchemeResponse(
        handler,
        assetPath,
        500,
        'Internal Server Error',
        new Uint8Array(),
      );
    }
    return true;
  }

  private finishSchemeResponse(
    handler: webview.WebResourceHandler,
    assetPath: string,
    status: number,
    statusText: string,
    bytes: Uint8Array,
  ): void {
    const response = new webview.WebSchemeHandlerResponse();
    response.setStatus(status);
    response.setStatusText(statusText);
    response.setMimeType(status === 200 ? this.mimeType(assetPath) : 'text/plain');
    response.setEncoding('utf-8');
    response.setHeaderByName('Cache-Control', 'no-store', true);
    response.setHeaderByName('Content-Length', bytes.byteLength.toString(), true);
    handler.didReceiveResponse(response);
    if (bytes.byteLength > 0) {
      handler.didReceiveResponseBody(this.copyBytes(bytes));
    }
    handler.didFinish();
  }

  private readAsset(assetPath: string): Uint8Array {
    return this.context.resourceManager.getRawFileContentSync(`${RAWFILE_ROOT}${assetPath}`);
  }

  private copyBytes(bytes: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer as ArrayBuffer;
  }

  private resolveAssetPath(requestUrl: string): string | null {
    if (!requestUrl.startsWith(APP_ORIGIN)) {
      return null;
    }
    const suffix = requestUrl.slice(APP_ORIGIN.length);
    if (suffix.length > 0) {
      const boundary = suffix.charAt(0);
      if (boundary !== '/' && boundary !== '?' && boundary !== '#') {
        return null;
      }
    }

    let pathname = suffix.startsWith('/') ? suffix : '/';
    let pathEnd = pathname.length;
    const queryIndex = pathname.indexOf('?');
    const fragmentIndex = pathname.indexOf('#');
    if (queryIndex >= 0 && queryIndex < pathEnd) {
      pathEnd = queryIndex;
    }
    if (fragmentIndex >= 0 && fragmentIndex < pathEnd) {
      pathEnd = fragmentIndex;
    }
    pathname = pathname.slice(0, pathEnd);
    try {
      pathname = decodeURIComponent(pathname);
    } catch (_error) {
      return '';
    }
    const assetPath = pathname.replace(/^\/+/, '') || 'index.html';
    if (assetPath.includes('..') || assetPath.includes('\\') || assetPath.includes('\u0000')) {
      return '';
    }
    return assetPath.endsWith('/') ? `${assetPath}index.html` : assetPath;
  }

  private mimeType(assetPath: string): string {
    const extension = assetPath.includes('.') ? assetPath.split('.').pop()?.toLowerCase() ?? '' : '';
    return MIME_TYPES.get(extension) ?? 'application/octet-stream';
  }

  private errorResponse(code: number, reason: string): WebResourceResponse {
    const response = new WebResourceResponse();
    response.setResponseData(reason);
    response.setResponseMimeType('text/plain');
    response.setResponseEncoding('utf-8');
    response.setResponseCode(code);
    response.setReasonMessage(reason);
    return response;
  }
}
