export const REMOTE_BACKEND_PROTOCOL = 'pure-tavern-generation-proxy';
export const REMOTE_BACKEND_PROTOCOL_VERSION = 1;

export interface RemoteBackendHealth {
  status: 'ok';
  service: 'pure-tavern-remote-backend';
  protocol: typeof REMOTE_BACKEND_PROTOCOL;
  protocolVersion: typeof REMOTE_BACKEND_PROTOCOL_VERSION;
}

export interface RemoteBackendProxyRequest {
  protocol: typeof REMOTE_BACKEND_PROTOCOL;
  protocolVersion: typeof REMOTE_BACKEND_PROTOCOL_VERSION;
  request: {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body: string | null;
  };
}
