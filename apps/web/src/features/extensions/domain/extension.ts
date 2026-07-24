export const EXTENSION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,126}[a-z0-9])$/;

export const EXTENSION_CAPABILITIES = Object.freeze([
  'storage:plugin',
  'network:fetch',
  'dom:legacy',
  'secrets:read',
  'storage:modules',
  'host:events',
] as const);

export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];
export type ExtensionTrust = 'trusted-builtin' | 'untrusted-user';
export type ExtensionEntrypointType = 'same-context' | 'iframe' | 'worker';

export interface ExtensionEntrypoint {
  type: ExtensionEntrypointType;
  path: string;
}

/** Normalized manifest used by the modern runtime. It is intentionally not a filesystem path. */
export interface ExtensionManifest {
  schemaVersion: 1;
  id: string;
  displayName: string;
  version: string;
  author: string;
  description: string;
  entrypoint: ExtensionEntrypoint;
  requestedCapabilities: ExtensionCapability[];
}

export interface TrustedBuiltInSource {
  kind: 'upstream-snapshot';
  snapshotPath: string;
}

export interface LocalPackageSource {
  kind: 'local-package';
  packageHash: string;
  fileCount: number;
  totalBytes: number;
}

export type ExtensionSource = TrustedBuiltInSource | LocalPackageSource;

export interface ExtensionInstallation {
  extensionId: string;
  legacyName: string;
  trust: ExtensionTrust;
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
  remoteUrl: null;
  branch: null;
}

export interface ExtensionRecord {
  extensionId: string;
  legacyName: string;
  trust: ExtensionTrust;
  enabled: boolean;
  manifest: ExtensionManifest;
  source: ExtensionSource;
  installedAt: string;
  updatedAt: string;
  version: ExtensionVersionMetadata;
}

export interface TrustedLegacyBuiltInDefinition {
  extensionId: string;
  legacyName: string;
  displayName: string;
  version: string;
  author: string;
  scriptPath: string;
  description?: string;
}

export function assertExtensionId(value: string): void {
  if (!EXTENSION_ID_PATTERN.test(value)) {
    throw new TypeError(
      'Extension id must be 3-128 lowercase ASCII letters, numbers, dots, underscores, or hyphens.',
    );
  }
}

export function isExtensionCapability(value: unknown): value is ExtensionCapability {
  return typeof value === 'string' && (EXTENSION_CAPABILITIES as readonly string[]).includes(value);
}

export function cloneExtensionRecord(record: ExtensionRecord): ExtensionRecord {
  return structuredClone(record);
}

export function createVersionMetadata(record: {
  extensionId: string;
  manifestVersion: string;
  source: ExtensionSource;
  installedAt: string;
  updatedAt: string;
}): ExtensionVersionMetadata {
  return {
    extensionId: record.extensionId,
    manifestVersion: record.manifestVersion,
    packageHash: record.source.kind === 'local-package' ? record.source.packageHash : null,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    remoteUrl: null,
    branch: null,
  };
}
