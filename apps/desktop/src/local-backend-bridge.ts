import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const BRIDGE_KEY = '__PURE_TAVERN_LOCAL_BACKEND__';
const RESPONSE_EVENT = 'pureTavernLocalServerResponse';
const START_COMMAND = 'pure_tavern_local_start_request';
const CANCEL_COMMAND = 'pure_tavern_local_cancel_request';

interface FinalProviderRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body: string | null;
}

interface LocalBackendRequest extends FinalProviderRequest {
  requestId: string;
}

if (!Object.prototype.hasOwnProperty.call(globalThis, BRIDGE_KEY)) {
  const bridge = Object.freeze({
    protocol: 'pure-tavern-local-backend',
    protocolVersion: 1,
    async startRequest(request: LocalBackendRequest) {
      return await invoke(START_COMMAND, { request });
    },
    async cancelRequest(requestId: string) {
      await invoke(CANCEL_COMMAND, { requestId });
    },
    async listen(listener: (event: unknown) => void) {
      const unlisten = await listen<unknown>(RESPONSE_EVENT, (message) =>
        listener(message.payload),
      );
      return Object.freeze({
        async remove() {
          await unlisten();
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
}
