import { GenerationProviderError } from '../domain/provider';

export interface DirectFetchDiagnostics {
  requests: number;
  streams: number;
  failures: number;
  aborted: number;
  lastSource: string | null;
  lastErrorCode: string | null;
}

export class DirectFetchClient {
  readonly diagnostics: DirectFetchDiagnostics = {
    requests: 0,
    streams: 0,
    failures: 0,
    aborted: 0,
    lastSource: null,
    lastErrorCode: null,
  };

  readonly #fetch: typeof window.fetch;

  constructor(nativeFetch: typeof window.fetch) {
    this.#fetch = nativeFetch;
  }

  async send(source: string, url: URL, init: RequestInit): Promise<Response> {
    this.diagnostics.requests += 1;
    this.diagnostics.lastSource = source;
    try {
      const response = await this.#fetch(url, init);
      if (response.headers.get('Content-Type')?.includes('text/event-stream')) {
        this.diagnostics.streams += 1;
      }
      return response;
    } catch (error) {
      const aborted =
        init.signal?.aborted === true ||
        (error instanceof DOMException && error.name === 'AbortError');
      this.diagnostics.failures += 1;
      if (aborted) this.diagnostics.aborted += 1;
      this.diagnostics.lastErrorCode = aborted ? 'aborted' : 'cors-or-network';
      throw new GenerationProviderError(
        aborted ? 'aborted' : 'cors-or-network',
        aborted
          ? 'The direct provider request was aborted.'
          : 'The browser could not reach the provider. Check CORS, URL, certificate and network policy.',
        aborted ? 499 : 502,
        { cause: error },
      );
    }
  }
}
