import {
  createVersionMetadata,
  type ExtensionCapability,
  type ExtensionRecord,
} from '../domain/extension';
import type { ExtensionPackageFile } from '../application/package-validator';
import { sha256Hex } from '../application/package-validator';

export function makeExtensionRecord(
  extensionId: string,
  options: {
    legacyName?: string;
    enabled?: boolean;
    capabilities?: ExtensionCapability[];
    entryType?: 'iframe' | 'worker' | 'same-context';
    trust?: 'trusted-builtin' | 'untrusted-user';
  } = {},
): ExtensionRecord {
  const now = '2026-07-24T00:00:00.000Z';
  const trust = options.trust ?? 'untrusted-user';
  const entryType = options.entryType ?? (trust === 'trusted-builtin' ? 'same-context' : 'worker');
  const source =
    trust === 'trusted-builtin'
      ? ({
          kind: 'upstream-snapshot' as const,
          snapshotPath: `/scripts/extensions/${options.legacyName ?? extensionId}/`,
        } as const)
      : ({
          kind: 'local-package' as const,
          packageHash: 'a'.repeat(64),
          fileCount: 2,
          totalBytes: 128,
        } as const);
  return {
    extensionId,
    legacyName: options.legacyName ?? `third-party/${extensionId}`,
    trust,
    enabled: options.enabled ?? true,
    manifest: {
      schemaVersion: 1,
      id: extensionId,
      displayName: `Extension ${extensionId}`,
      version: '1.0.0',
      author: 'Test',
      description: 'Test extension',
      entrypoint: {
        type: entryType,
        path:
          entryType === 'same-context'
            ? `/scripts/extensions/${options.legacyName ?? extensionId}/index.js`
            : entryType === 'iframe'
              ? 'index.html'
              : 'worker.js',
      },
      requestedCapabilities: options.capabilities ?? [],
    },
    source,
    installedAt: now,
    updatedAt: now,
    version: createVersionMetadata({
      extensionId,
      manifestVersion: '1.0.0',
      source,
      installedAt: now,
      updatedAt: now,
    }),
  };
}

export async function makeWorkerPackage(
  id = 'org.example.worker',
  options: {
    capabilities?: ExtensionCapability[];
    entryType?: 'iframe' | 'worker' | 'same-context';
    entryPath?: string;
    content?: string;
    hashOverride?: string;
    extraFiles?: ExtensionPackageFile[];
  } = {},
): Promise<ExtensionPackageFile[]> {
  const entryType = options.entryType ?? 'worker';
  const entryPath = options.entryPath ?? (entryType === 'iframe' ? 'index.html' : 'worker.js');
  const entry = new Blob([options.content ?? 'self.onmessage = () => undefined;']);
  const digest = options.hashOverride ?? (await sha256Hex(entry));
  const manifest = {
    schema_version: 1,
    id,
    display_name: 'Worker Test',
    version: '1.0.0',
    author: 'Test',
    description: 'Package test',
    entry: { type: entryType, path: entryPath },
    permissions: options.capabilities ?? [],
    hashes: {
      [entryPath]: digest,
      ...Object.fromEntries(
        await Promise.all(
          (options.extraFiles ?? []).map(async (file) => [file.path, await sha256Hex(file.data)]),
        ),
      ),
    },
  };
  return [
    { path: 'manifest.json', data: new Blob([JSON.stringify(manifest)]) },
    { path: entryPath, data: entry },
    ...(options.extraFiles ?? []),
  ];
}
