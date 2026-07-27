import type { ExtensionSourceProvider, RemoteExtensionSource } from '../domain/extension';
import type { ExtensionPackageFile } from '../application/package-validator';

export interface ExtensionSourceSnapshot {
  provider: ExtensionSourceProvider;
  repositoryUrl: string;
  requestedRef: string;
  resolvedRef: string;
  revision: string;
  folderName: string;
  files: readonly ExtensionPackageFile[];
}

export interface ExtensionSourceRef {
  current: boolean;
  commit: string;
  name: string;
  label: string;
}

export interface ExtensionSourceGateway {
  fetchSnapshot(
    url: string,
    ref?: string,
    signal?: AbortSignal,
  ): Promise<ExtensionSourceSnapshot>;
  listRefs(source: RemoteExtensionSource, signal?: AbortSignal): Promise<ExtensionSourceRef[]>;
}
