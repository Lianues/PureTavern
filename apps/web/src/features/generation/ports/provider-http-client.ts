export interface ProviderHttpClient {
  send(source: string, url: URL, init: RequestInit): Promise<Response>;
}
