import type { FinalProviderRequest } from '../domain/final-provider-request';

export const LOCAL_BACKEND_BRIDGE_PROTOCOL = 'pure-tavern-local-backend';
export const LOCAL_BACKEND_BRIDGE_PROTOCOL_VERSION = 1;

export interface LocalBackendBridgeListenerHandle {
  remove(): Promise<void> | void;
}

export interface LocalBackendBridge {
  readonly protocol: typeof LOCAL_BACKEND_BRIDGE_PROTOCOL;
  readonly protocolVersion: typeof LOCAL_BACKEND_BRIDGE_PROTOCOL_VERSION;
  startRequest(options: FinalProviderRequest & { requestId: string }): Promise<unknown>;
  cancelRequest(requestId: string): Promise<void>;
  listen(listener: (event: unknown) => void): Promise<LocalBackendBridgeListenerHandle>;
}

export interface LocalBackendBridgeScope {
  __PURE_TAVERN_LOCAL_BACKEND__?: unknown;
}

export function resolveLocalBackendBridge(
  scope: LocalBackendBridgeScope = globalThis as LocalBackendBridgeScope,
): LocalBackendBridge | null {
  const bridge = scope.__PURE_TAVERN_LOCAL_BACKEND__;
  if (!isRecord(bridge)) return null;
  if (
    bridge.protocol !== LOCAL_BACKEND_BRIDGE_PROTOCOL ||
    bridge.protocolVersion !== LOCAL_BACKEND_BRIDGE_PROTOCOL_VERSION ||
    typeof bridge.startRequest !== 'function' ||
    typeof bridge.cancelRequest !== 'function' ||
    typeof bridge.listen !== 'function'
  ) {
    return null;
  }
  return bridge as unknown as LocalBackendBridge;
}

export function isLocalBackendBridgeAvailable(
  scope: LocalBackendBridgeScope = globalThis as LocalBackendBridgeScope,
): boolean {
  return resolveLocalBackendBridge(scope) !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
