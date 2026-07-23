export interface UpstreamMetadata {
  project: string;
  version: string;
  upstreamRepository: string;
  syncedAt: string;
  fileCount: number;
}

let metadataPromise: Promise<UpstreamMetadata> | undefined;

export function loadUpstreamMetadata(nativeFetch: typeof window.fetch) {
  return (metadataPromise ??= nativeFetch('/__pure_tavern/upstream.json').then(async (response) => {
    if (!response.ok) {
      throw new Error(`Upstream metadata failed to load: HTTP ${response.status}`);
    }

    return (await response.json()) as UpstreamMetadata;
  }));
}
