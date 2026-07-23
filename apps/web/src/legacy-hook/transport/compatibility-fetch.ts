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
