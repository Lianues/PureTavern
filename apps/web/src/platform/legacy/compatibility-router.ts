export interface CompatibilityRequestLog {
  method: string;
  pathname: string;
  handled: boolean;
  timestamp: string;
}

export interface CompatibilityDiagnostics {
  requests: CompatibilityRequestLog[];
  unhandledEndpoints: string[];
}

export type CompatibilityHandler = (request: Request, url: URL) => Promise<Response> | Response;

export class CompatibilityRouter {
  readonly diagnostics: CompatibilityDiagnostics = {
    requests: [],
    unhandledEndpoints: [],
  };

  readonly #routes = new Map<string, CompatibilityHandler>();

  register(method: string, pathname: string, handler: CompatibilityHandler) {
    this.#routes.set(`${method.toUpperCase()} ${pathname}`, handler);
  }

  async dispatch(request: Request, url: URL): Promise<Response | null> {
    const key = `${request.method.toUpperCase()} ${url.pathname}`;
    const handler = this.#routes.get(key);
    const isCompatibilityPath =
      url.pathname === '/csrf-token' ||
      url.pathname === '/version' ||
      url.pathname.startsWith('/api/');

    if (!handler && !isCompatibilityPath) return null;

    this.diagnostics.requests.push({
      method: request.method.toUpperCase(),
      pathname: url.pathname,
      handled: Boolean(handler),
      timestamp: new Date().toISOString(),
    });

    if (handler) return handler(request, url);

    if (!this.diagnostics.unhandledEndpoints.includes(key)) {
      this.diagnostics.unhandledEndpoints.push(key);
      console.warn(`[PureTavern Hook] Unhandled Legacy endpoint: ${key}`);
    }

    return jsonResponse(
      {
        error: 'This Legacy endpoint has not been migrated.',
        endpoint: key,
        pureTavern: true,
      },
      501,
    );
  }
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Pure-Tavern-Hook': '1',
    },
  });
}

export function textResponse(data: string, status = 200): Response {
  return new Response(data, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Pure-Tavern-Hook': '1',
    },
  });
}

export function emptyResponse(status = 204): Response {
  return new Response(null, {
    status,
    headers: {
      'X-Pure-Tavern-Hook': '1',
    },
  });
}

export function installCompatibilityFetch(router: CompatibilityRouter) {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const resolvedInput = typeof input === 'string' ? new URL(input, window.location.href) : input;
    const request = new Request(resolvedInput, init);
    const url = new URL(request.url);

    if (url.origin === window.location.origin) {
      const response = await router.dispatch(request, url);
      if (response) return response;
    }

    return nativeFetch(input, init);
  };

  return nativeFetch;
}

/**
 * Legacy jQuery still uses XMLHttpRequest for a few startup-adjacent calls. This wrapper routes
 * same-origin compatibility URLs through the same registry as fetch without changing upstream JS.
 * Requests outside the compatibility boundary continue through the browser's native XHR.
 */
export function installCompatibilityXhr(router: CompatibilityRouter): () => void {
  const NativeXmlHttpRequest = window.XMLHttpRequest;

  class CompatibilityXmlHttpRequest extends EventTarget {
    static readonly UNSENT = 0;
    static readonly OPENED = 1;
    static readonly HEADERS_RECEIVED = 2;
    static readonly LOADING = 3;
    static readonly DONE = 4;

    readonly UNSENT = 0;
    readonly OPENED = 1;
    readonly HEADERS_RECEIVED = 2;
    readonly LOADING = 3;
    readonly DONE = 4;
    readonly upload: XMLHttpRequestUpload;

    onreadystatechange: ((this: XMLHttpRequest, event: Event) => unknown) | null = null;
    onabort: ((this: XMLHttpRequest, event: ProgressEvent) => unknown) | null = null;
    onerror: ((this: XMLHttpRequest, event: ProgressEvent) => unknown) | null = null;
    onload: ((this: XMLHttpRequest, event: ProgressEvent) => unknown) | null = null;
    onloadend: ((this: XMLHttpRequest, event: ProgressEvent) => unknown) | null = null;
    onloadstart: ((this: XMLHttpRequest, event: ProgressEvent) => unknown) | null = null;
    onprogress: ((this: XMLHttpRequest, event: ProgressEvent) => unknown) | null = null;
    ontimeout: ((this: XMLHttpRequest, event: ProgressEvent) => unknown) | null = null;

    readonly #native = new NativeXmlHttpRequest();
    readonly #requestHeaders = new Headers();
    #method = 'GET';
    #url = '';
    #intercept = false;
    #aborted = false;
    #readyState = CompatibilityXmlHttpRequest.UNSENT;
    #responseType: XMLHttpRequestResponseType = '';
    #responseText = '';
    #response: unknown = null;
    #responseUrl = '';
    #status = 0;
    #statusText = '';
    #responseHeaders = new Headers();

    constructor() {
      super();
      this.upload = this.#native.upload;
      for (const type of [
        'readystatechange',
        'abort',
        'error',
        'load',
        'loadend',
        'loadstart',
        'progress',
        'timeout',
      ]) {
        this.#native.addEventListener(type, (event) => this.#emit(type, event));
      }
    }

    get readyState(): number {
      return this.#intercept ? this.#readyState : this.#native.readyState;
    }

    get response(): unknown {
      return this.#intercept ? this.#response : this.#native.response;
    }

    get responseText(): string {
      return this.#intercept ? this.#responseText : this.#native.responseText;
    }

    get responseType(): XMLHttpRequestResponseType {
      return this.#intercept ? this.#responseType : this.#native.responseType;
    }

    set responseType(value: XMLHttpRequestResponseType) {
      this.#responseType = value;
      if (!this.#intercept) this.#native.responseType = value;
    }

    get responseURL(): string {
      return this.#intercept ? this.#responseUrl : this.#native.responseURL;
    }

    get responseXML(): Document | null {
      return this.#intercept ? null : this.#native.responseXML;
    }

    get status(): number {
      return this.#intercept ? this.#status : this.#native.status;
    }

    get statusText(): string {
      return this.#intercept ? this.#statusText : this.#native.statusText;
    }

    get timeout(): number {
      return this.#native.timeout;
    }

    set timeout(value: number) {
      this.#native.timeout = value;
    }

    get withCredentials(): boolean {
      return this.#native.withCredentials;
    }

    set withCredentials(value: boolean) {
      this.#native.withCredentials = value;
    }

    open(
      method: string,
      url: string | URL,
      async = true,
      username?: string | null,
      password?: string | null,
    ): void {
      const resolvedUrl = new URL(String(url), window.location.href);
      this.#method = method.toUpperCase();
      this.#url = resolvedUrl.href;
      this.#intercept =
        resolvedUrl.origin === window.location.origin &&
        (resolvedUrl.pathname === '/csrf-token' ||
          resolvedUrl.pathname === '/version' ||
          resolvedUrl.pathname.startsWith('/api/'));
      if (!this.#intercept || !async) {
        this.#intercept = false;
        this.#native.open(method, resolvedUrl, async, username ?? null, password ?? null);
        return;
      }
      this.#readyState = CompatibilityXmlHttpRequest.OPENED;
      this.#emit('readystatechange', new Event('readystatechange'));
    }

    setRequestHeader(name: string, value: string): void {
      if (this.#intercept) this.#requestHeaders.append(name, value);
      else this.#native.setRequestHeader(name, value);
    }

    getResponseHeader(name: string): string | null {
      return this.#intercept
        ? this.#responseHeaders.get(name)
        : this.#native.getResponseHeader(name);
    }

    getAllResponseHeaders(): string {
      if (!this.#intercept) return this.#native.getAllResponseHeaders();
      return [...this.#responseHeaders.entries()]
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join('');
    }

    overrideMimeType(mime: string): void {
      if (!this.#intercept) this.#native.overrideMimeType(mime);
    }

    abort(): void {
      if (!this.#intercept) {
        this.#native.abort();
        return;
      }
      this.#aborted = true;
      this.#readyState = CompatibilityXmlHttpRequest.UNSENT;
      this.#emit('abort', new ProgressEvent('abort'));
      this.#emit('loadend', new ProgressEvent('loadend'));
    }

    send(body: Document | XMLHttpRequestBodyInit | null = null): void {
      if (!this.#intercept) {
        this.#native.send(body);
        return;
      }
      void this.#sendCompatibilityRequest(body);
    }

    async #sendCompatibilityRequest(body: Document | XMLHttpRequestBodyInit | null): Promise<void> {
      this.#emit('loadstart', new ProgressEvent('loadstart'));
      try {
        const hasBody = this.#method !== 'GET' && this.#method !== 'HEAD' && body !== null;
        const request = new Request(this.#url, {
          method: this.#method,
          headers: this.#requestHeaders,
          body: hasBody ? (body as BodyInit) : null,
        });
        const response = await router.dispatch(request, new URL(this.#url));
        if (!response || this.#aborted) return;
        this.#readyState = CompatibilityXmlHttpRequest.HEADERS_RECEIVED;
        this.#emit('readystatechange', new Event('readystatechange'));
        this.#status = response.status;
        this.#statusText = response.statusText;
        this.#responseUrl = response.url || this.#url;
        this.#responseHeaders = new Headers(response.headers);
        this.#readyState = CompatibilityXmlHttpRequest.LOADING;
        this.#emit('readystatechange', new Event('readystatechange'));
        const buffer = await response.arrayBuffer();
        this.#responseText = new TextDecoder().decode(buffer);
        this.#response =
          this.#responseType === 'arraybuffer'
            ? buffer
            : this.#responseType === 'blob'
              ? new Blob([buffer], { type: response.headers.get('content-type') ?? '' })
              : this.#responseType === 'json'
                ? JSON.parse(this.#responseText || 'null')
                : this.#responseText;
        this.#readyState = CompatibilityXmlHttpRequest.DONE;
        this.#emit('readystatechange', new Event('readystatechange'));
        this.#emit('load', new ProgressEvent('load', { loaded: buffer.byteLength }));
        this.#emit('loadend', new ProgressEvent('loadend', { loaded: buffer.byteLength }));
      } catch {
        if (this.#aborted) return;
        this.#readyState = CompatibilityXmlHttpRequest.DONE;
        this.#emit('readystatechange', new Event('readystatechange'));
        this.#emit('error', new ProgressEvent('error'));
        this.#emit('loadend', new ProgressEvent('loadend'));
      }
    }

    #emit(type: string, source: Event): void {
      const event =
        source instanceof ProgressEvent
          ? new ProgressEvent(type, {
              lengthComputable: source.lengthComputable,
              loaded: source.loaded,
              total: source.total,
            })
          : new Event(type);
      const handler = this[`on${type}` as keyof this];
      if (typeof handler === 'function') {
        (handler as (this: XMLHttpRequest, event: Event) => unknown).call(
          this as unknown as XMLHttpRequest,
          event,
        );
      }
      this.dispatchEvent(event);
    }
  }

  window.XMLHttpRequest = CompatibilityXmlHttpRequest as unknown as typeof XMLHttpRequest;
  return () => {
    window.XMLHttpRequest = NativeXmlHttpRequest;
  };
}
