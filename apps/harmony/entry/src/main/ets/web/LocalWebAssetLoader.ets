import { common } from '@kit.AbilityKit';
import { WEB_ASSET_PATHS } from '../generated/WebAssetManifest';

const APP_HOST: string = 'puretavern.local';
const RAWFILE_ROOT: string = 'web/';

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

  constructor(context: common.UIAbilityContext) {
    this.context = context;
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
      const bytes = this.context.resourceManager.getRawFileContentSync(`${RAWFILE_ROOT}${assetPath}`);
      const response = new WebResourceResponse();
      response.setResponseData(bytes.buffer as ArrayBuffer);
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

  private resolveAssetPath(requestUrl: string): string | null {
    let url: URL;
    try {
      url = new URL(requestUrl);
    } catch (_error) {
      return null;
    }
    if (url.protocol !== 'https:' || url.hostname !== APP_HOST) {
      return null;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
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
