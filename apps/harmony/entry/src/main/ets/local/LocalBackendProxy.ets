import { util } from '@kit.ArkTS';
import { webview } from '@kit.ArkWeb';
import { http } from '@kit.NetworkKit';

const APP_ORIGIN: string = 'https://puretavern.local';
const CHUNK_SIZE: number = 32 * 1024;
const MAX_ACTIVE_REQUESTS: number = 4;
const MAX_BODY_BYTES: number = 64 * 1024 * 1024;
const MAX_QUEUED_EVENTS: number = 2048;
const EVENT_BATCH_SIZE: number = 16;
const BLOCKED_REQUEST_HEADERS: Set<string> = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

interface LocalHeader {
  name: string;
  value: string;
}

interface LocalBackendRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Array<LocalHeader>;
  hasBody: boolean;
  body: string;
}

class LocalRequestSession {
  readonly requestId: string;
  readonly request: http.HttpRequest;
  private readonly base64: util.Base64Helper = new util.Base64Helper();
  private readonly emitEvent: (event: string) => void;
  private readonly closeSession: (requestId: string) => void;
  private status: number = 0;
  private headersJson: string = '{}';
  private headersReceived: boolean = false;
  private headersSent: boolean = false;
  private ended: boolean = false;
  private closed: boolean = false;
  private nextSequence: number = 0;
  private pendingChunks: Array<Uint8Array> = [];

  constructor(
    requestId: string,
    request: http.HttpRequest,
    emitEvent: (event: string) => void,
    closeSession: (requestId: string) => void,
  ) {
    this.requestId = requestId;
    this.request = request;
    this.emitEvent = emitEvent;
    this.closeSession = closeSession;
  }

  receiveStatus(status: number): void {
    if (this.closed) return;
    this.status = status;
    this.flush();
  }

  receiveHeaders(headers: Object): void {
    if (this.closed || this.headersReceived) return;
    this.headersJson = JSON.stringify(headers);
    this.headersReceived = true;
    this.flush();
  }

  receiveData(buffer: ArrayBuffer): void {
    if (this.closed) return;
    const source = new Uint8Array(buffer);
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    if (!this.headersSent) {
      this.pendingChunks.push(copy);
      return;
    }
    this.emitBytes(copy);
  }

  receiveEnd(): void {
    if (this.closed) return;
    this.ended = true;
    this.flush();
  }

  fail(code: string, message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingChunks = [];
    this.emitEvent(
      `{"requestId":${JSON.stringify(this.requestId)},"type":"error","code":${JSON.stringify(code)},"message":${JSON.stringify(message)}}`,
    );
    this.closeSession(this.requestId);
  }

  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingChunks = [];
    this.request.destroy();
  }

  private flush(): void {
    if (this.closed || !this.headersReceived || this.status < 100 || this.status > 599) return;
    if (!this.headersSent) {
      this.headersSent = true;
      this.emitEvent(
        `{"requestId":${JSON.stringify(this.requestId)},"type":"headers","status":${this.status},"statusText":"","headers":${this.headersJson}}`,
      );
      const chunks = this.pendingChunks;
      this.pendingChunks = [];
      for (const chunk of chunks) this.emitBytes(chunk);
    }
    if (this.ended) {
      this.closed = true;
      this.emitEvent(`{"requestId":${JSON.stringify(this.requestId)},"type":"complete"}`);
      this.closeSession(this.requestId);
    }
  }

  private emitBytes(bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const end = Math.min(offset + CHUNK_SIZE, bytes.byteLength);
      const encoded = this.base64.encodeToStringSync(bytes.subarray(offset, end));
      this.emitEvent(
        `{"requestId":${JSON.stringify(this.requestId)},"type":"chunk","sequence":${this.nextSequence},"data":${JSON.stringify(encoded)}}`,
      );
      this.nextSequence += 1;
      offset = end;
    }
  }
}

export class LocalBackendProxy {
  private readonly controller: webview.WebviewController;
  private readonly active: Map<string, LocalRequestSession> = new Map();
  private events: Array<string> = [];
  private disposed: boolean = false;

  constructor(controller: webview.WebviewController) {
    this.controller = controller;
  }

  startRequest(payload: string): string {
    this.ensureTrustedCaller();
    if (this.disposed) throw new Error('The Harmony local backend is unavailable.');
    if (payload.length > MAX_BODY_BYTES * 2) throw new Error('The local backend request is too large.');

    const input = JSON.parse(payload) as LocalBackendRequest;
    this.validateRequest(input);
    if (this.active.size >= MAX_ACTIVE_REQUESTS) {
      throw new Error('Too many local backend requests are active.');
    }
    if (this.active.has(input.requestId)) {
      throw new Error('The local backend request ID is already active.');
    }

    const nativeRequest = http.createHttp();
    const session = new LocalRequestSession(
      input.requestId,
      nativeRequest,
      (event: string): void => this.enqueue(event),
      (requestId: string): void => this.close(requestId),
    );
    this.active.set(input.requestId, session);

    nativeRequest.on('headersReceive', (headers: Object): void => session.receiveHeaders(headers));
    nativeRequest.on('dataReceive', (data: ArrayBuffer): void => session.receiveData(data));
    nativeRequest.on('dataEnd', (): void => session.receiveEnd());

    const options: http.HttpRequestOptions = {
      method: input.method === 'GET' ? http.RequestMethod.GET : http.RequestMethod.POST,
      header: this.buildHeaders(input.headers),
      usingCache: false,
      connectTimeout: 15_000,
      readTimeout: 600_000,
      maxRedirects: 10,
    };
    if (input.hasBody) options.extraData = input.body;

    nativeRequest
      .requestInStream(input.url, options)
      .then((status: number): void => session.receiveStatus(status))
      .catch((): void => session.fail('network', 'The Harmony local backend could not reach the provider.'));
    return input.requestId;
  }

  cancelRequest(requestId: string): void {
    this.ensureTrustedCaller();
    const session = this.active.get(requestId);
    if (session === undefined) return;
    this.active.delete(requestId);
    session.cancel();
  }

  takeEvents(): string {
    this.ensureTrustedCaller();
    const batch = this.events.splice(0, EVENT_BATCH_SIZE);
    return `{"events":[${batch.join(',')}],"active":${this.active.size > 0}}`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const sessions = Array.from(this.active.values());
    this.active.clear();
    this.events = [];
    for (const session of sessions) session.cancel();
  }

  private close(requestId: string): void {
    const session = this.active.get(requestId);
    if (session === undefined) return;
    this.active.delete(requestId);
    session.request.destroy();
  }

  private enqueue(event: string): void {
    if (this.disposed) return;
    if (this.events.length >= MAX_QUEUED_EVENTS) {
      const sessions = Array.from(this.active.values());
      const requestIds = Array.from(this.active.keys());
      this.active.clear();
      this.events = [];
      for (const session of sessions) session.cancel();
      for (const requestId of requestIds) {
        this.events.push(
          `{"requestId":${JSON.stringify(requestId)},"type":"error","code":"protocol","message":"The Harmony local backend event queue overflowed."}`,
        );
      }
      return;
    }
    this.events.push(event);
  }

  private validateRequest(input: LocalBackendRequest): void {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.requestId)) {
      throw new Error('A valid local backend request ID is required.');
    }
    if (!this.isAllowedURL(input.url)) {
      throw new Error('The provider URL must be an HTTP or HTTPS URL.');
    }
    if (input.method !== 'GET' && input.method !== 'POST') {
      throw new Error('The local backend supports only GET and POST requests.');
    }
    if (!Array.isArray(input.headers) || input.headers.length > 256) {
      throw new Error('The provider request contains too many headers.');
    }
    if (input.body.length > MAX_BODY_BYTES) {
      throw new Error('The provider request body is too large.');
    }
    for (const header of input.headers) {
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/.test(header.name) ||
        header.value.length > 64 * 1024 ||
        header.value.includes('\r') ||
        header.value.includes('\n') ||
        header.value.includes('\u0000')
      ) {
        throw new Error('The provider request contains an invalid header.');
      }
    }
  }

  private buildHeaders(headers: Array<LocalHeader>): Object {
    const blocked: Set<string> = new Set(BLOCKED_REQUEST_HEADERS);
    for (const header of headers) {
      if (header.name.toLowerCase() !== 'connection') continue;
      for (const token of header.value.split(',')) {
        const normalized = token.trim().toLowerCase();
        if (normalized.length > 0) blocked.add(normalized);
      }
    }

    const parts: Array<string> = [];
    for (const header of headers) {
      if (blocked.has(header.name.toLowerCase())) continue;
      parts.push(`${JSON.stringify(header.name)}:${JSON.stringify(header.value)}`);
    }
    parts.push('"Accept-Encoding":"identity"');
    return JSON.parse(`{${parts.join(',')}}`);
  }

  private isAllowedURL(value: string): boolean {
    // Stage-mode profiles do not accept the legacy FA `module.network` block. Without a
    // network-security base override, NetworkKit's documented base policy permits cleartext.
    if (value.length === 0 || value.length > 16 * 1024) return false;
    const prefixLength = value.startsWith('https://') ? 8 : value.startsWith('http://') ? 7 : 0;
    if (prefixLength === 0) return false;
    const authorityEnd = this.firstBoundary(value, prefixLength);
    const authority = value.slice(prefixLength, authorityEnd);
    return authority.length > 0 && !authority.includes('@');
  }

  private firstBoundary(value: string, start: number): number {
    let result = value.length;
    for (const marker of ['/', '?', '#']) {
      const index = value.indexOf(marker, start);
      if (index >= 0 && index < result) result = index;
    }
    return result;
  }

  private ensureTrustedCaller(): void {
    let caller: string = '';
    try {
      caller = this.controller.getLastJavascriptProxyCallingFrameUrl();
    } catch (_error) {
      throw new Error('Untrusted local backend caller.');
    }
    if (!caller.startsWith(APP_ORIGIN)) throw new Error('Untrusted local backend caller.');
    const suffix = caller.slice(APP_ORIGIN.length);
    if (suffix.length > 0 && !suffix.startsWith('/') && !suffix.startsWith('?') && !suffix.startsWith('#')) {
      throw new Error('Untrusted local backend caller.');
    }
  }
}
