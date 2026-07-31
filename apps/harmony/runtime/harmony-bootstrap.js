(() => {
  'use strict';

  globalThis.__PURE_TAVERN_PLATFORM__ = 'harmony';

  const BRIDGE_KEY = '__PURE_TAVERN_LOCAL_BACKEND__';
  const native = globalThis.PureTavernHarmonyLocalServer;
  if (
    !native ||
    typeof native.startRequest !== 'function' ||
    typeof native.cancelRequest !== 'function' ||
    typeof native.takeEvents !== 'function' ||
    Object.prototype.hasOwnProperty.call(globalThis, BRIDGE_KEY)
  ) {
    return;
  }

  const listeners = new Set();
  let timer = null;
  let draining = false;
  let hasActiveRequests = false;

  function schedulePump(delay) {
    if (listeners.size === 0) return;
    if (timer !== null) {
      if (delay !== 0) return;
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      void drainEvents();
    }, delay);
  }

  async function drainEvents() {
    if (draining || listeners.size === 0) return;
    draining = true;
    try {
      const raw = await Promise.resolve(native.takeEvents());
      const envelope = typeof raw === 'string' ? JSON.parse(raw) : null;
      const events = Array.isArray(envelope?.events) ? envelope.events : [];
      hasActiveRequests = envelope?.active === true;
      for (const rawEvent of events) {
        const event = normalizeEvent(rawEvent);
        if (event === null) continue;
        for (const listener of [...listeners]) {
          try {
            listener(event);
          } catch {
            // One consumer must not stop delivery to the local transport.
          }
        }
      }
    } catch {
      // A transient bridge read failure is retried while a listener remains installed.
    } finally {
      draining = false;
      schedulePump(hasActiveRequests ? 8 : 250);
    }
  }

  const bridge = Object.freeze({
    protocol: 'pure-tavern-local-backend',
    protocolVersion: 1,
    async startRequest(options) {
      const payload = JSON.stringify({
        requestId: options.requestId,
        url: options.url,
        method: options.method,
        headers: Object.entries(options.headers ?? {}).map(([name, value]) => ({ name, value })),
        hasBody: options.body !== null,
        body: options.body ?? '',
      });
      await Promise.resolve(native.startRequest(payload));
      hasActiveRequests = true;
      schedulePump(0);
      return { requestId: options.requestId };
    },
    async cancelRequest(requestId) {
      await Promise.resolve(native.cancelRequest(requestId));
      schedulePump(0);
    },
    async listen(listener) {
      listeners.add(listener);
      schedulePump(0);
      return Object.freeze({
        async remove() {
          listeners.delete(listener);
          if (listeners.size === 0 && timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
        },
      });
    },
  });

  Object.defineProperty(globalThis, BRIDGE_KEY, {
    value: bridge,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  function normalizeEvent(value) {
    if (!value || typeof value !== 'object' || typeof value.requestId !== 'string') return null;
    if (value.type !== 'headers') return value;
    return { ...value, headers: filterResponseHeaders(value.headers) };
  }

  function filterResponseHeaders(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const entries = [];
    const connectionTokens = new Set();
    for (const [name, rawValue] of Object.entries(value)) {
      const headerValue = normalizeHeaderValue(rawValue);
      if (headerValue === null) continue;
      entries.push([name, headerValue]);
      if (name.toLowerCase() === 'connection') {
        for (const token of headerValue.split(',')) {
          const normalized = token.trim().toLowerCase();
          if (normalized) connectionTokens.add(normalized);
        }
      }
    }

    const blocked = new Set([
      'connection',
      'content-length',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'set-cookie',
      'set-cookie2',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      ...connectionTokens,
    ]);
    const result = Object.create(null);
    for (const [name, headerValue] of entries) {
      const lowerName = name.toLowerCase();
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        blocked.has(lowerName) ||
        lowerName.startsWith('access-control-')
      ) {
        continue;
      }
      result[name] = headerValue;
    }
    return result;
  }

  function normalizeHeaderValue(value) {
    let normalized = null;
    if (typeof value === 'string') normalized = value;
    else if (typeof value === 'number' || typeof value === 'boolean') normalized = String(value);
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      normalized = value.join(', ');
    }
    if (
      normalized === null ||
      normalized.length > 64 * 1024 ||
      normalized.includes('\r') ||
      normalized.includes('\n') ||
      normalized.includes('\0')
    ) {
      return null;
    }
    return normalized;
  }
})();
