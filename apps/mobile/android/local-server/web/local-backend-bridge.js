(() => {
  'use strict';

  const BRIDGE_KEY = '__PURE_TAVERN_LOCAL_BACKEND__';
  const RESPONSE_EVENT = 'pureTavernLocalServerResponse';
  const capacitor = globalThis.Capacitor;
  if (!capacitor || capacitor.getPlatform?.call(capacitor) !== 'android') return;

  const plugin = capacitor.Plugins?.PureTavernLocalServer;
  if (
    !plugin ||
    typeof plugin.startRequest !== 'function' ||
    typeof plugin.cancelRequest !== 'function' ||
    typeof plugin.addListener !== 'function'
  ) {
    return;
  }
  if (Object.prototype.hasOwnProperty.call(globalThis, BRIDGE_KEY)) return;

  const bridge = Object.freeze({
    protocol: 'pure-tavern-local-backend',
    protocolVersion: 1,
    async startRequest(options) {
      return await plugin.startRequest(options);
    },
    async cancelRequest(requestId) {
      await plugin.cancelRequest({ requestId });
    },
    async listen(listener) {
      const handle = await plugin.addListener(RESPONSE_EVENT, listener);
      return Object.freeze({
        async remove() {
          await handle.remove();
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
})();
