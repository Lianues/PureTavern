import type { GenerationTransportState } from '../application/generation-transport-state';
import type { ProviderHttpClient } from '../ports/provider-http-client';
import type { LocalBackendClient } from './local-backend-client';
import type { DirectFetchClient } from './direct-fetch-client';
import type { RemoteBackendClient } from './remote-backend-client';

export class RoutingFetchClient implements ProviderHttpClient {
  readonly diagnostics;

  readonly #state: GenerationTransportState;
  readonly #direct: DirectFetchClient;
  readonly #local: LocalBackendClient;
  readonly #remote: RemoteBackendClient;

  constructor(
    state: GenerationTransportState,
    direct: DirectFetchClient,
    local: LocalBackendClient,
    remote: RemoteBackendClient,
  ) {
    this.#state = state;
    this.#direct = direct;
    this.#local = local;
    this.#remote = remote;
    this.diagnostics = {
      state: state.diagnostics,
      direct: direct.diagnostics,
      local: local.diagnostics,
      remote: remote.diagnostics,
    };
  }

  async send(source: string, url: URL, init: RequestInit): Promise<Response> {
    switch (this.#state.mode) {
      case 'frontend':
        return await this.#direct.send(source, url, init);
      case 'remote':
        return await this.#remote.send(source, url, init);
      case 'local':
        return await this.#local.send(source, url, init);
    }
  }
}
