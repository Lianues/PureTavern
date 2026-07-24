export type ExtensionTrust = 'trusted-builtin' | 'user-approved-legacy';
export type ExtensionScope = 'system' | 'local' | 'global';
export type ExtensionSourceProvider = 'github' | 'gitlab' | 'cors-zip';

export interface LegacyExtensionManifest extends Record<string, unknown> {
  display_name: string;
  version: string;
  author: string;
  js?: string;
  css?: string;
}

export interface TrustedBuiltInSource {
  kind: 'upstream-snapshot' | 'pure-tavern-first-party';
  snapshotPath: string;
}

export interface RemoteExtensionSource {
  kind: 'remote';
  provider: ExtensionSourceProvider;
  repositoryUrl: string;
  requestedRef: string;
  resolvedRef: string;
  revision: string;
  packageHash: string;
  fileCount: number;
  totalBytes: number;
}

export type ExtensionSource = TrustedBuiltInSource | RemoteExtensionSource;

export interface ExtensionRecord {
  extensionId: string;
  legacyName: string;
  folderName: string;
  trust: ExtensionTrust;
  scope: ExtensionScope;
  enabled: boolean;
  manifest: LegacyExtensionManifest;
  source: ExtensionSource;
  installedAt: string;
  updatedAt: string;
}

export interface ExtensionVersionMetadata {
  extensionId: string;
  manifestVersion: string;
  packageHash: string | null;
  installedAt: string;
  updatedAt: string;
  remoteUrl: string | null;
  branch: string | null;
  revision: string | null;
}

export interface TrustedLegacyBuiltInDefinition {
  extensionId: string;
  legacyName: string;
  displayName: string;
  version: string;
  author: string;
  scriptPath: string;
  description?: string;
  sourceKind?: TrustedBuiltInSource['kind'];
}

export function assertExtensionId(value: string): void {
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])$/u.test(value)) {
    throw new TypeError(
      'Extension id must be 3-128 lowercase ASCII letters, numbers, dots, underscores, or hyphens.',
    );
  }
}

export function cloneExtensionRecord(record: ExtensionRecord): ExtensionRecord {
  return structuredClone(record);
}

export function createVersionMetadata(record: ExtensionRecord): ExtensionVersionMetadata {
  return {
    extensionId: record.extensionId,
    manifestVersion: record.manifest.version,
    packageHash: record.source.kind === 'remote' ? record.source.packageHash : null,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    remoteUrl: record.source.kind === 'remote' ? record.source.repositoryUrl : null,
    branch: record.source.kind === 'remote' ? record.source.resolvedRef : null,
    revision: record.source.kind === 'remote' ? record.source.revision : null,
  };
}
