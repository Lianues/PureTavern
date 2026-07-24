import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { decodeArchive, encodeArchive } from '../application/archive-codec';
import type { PortableArchiveEntry } from '../application/archive-participant-registry';

const moduleSummary = {
  moduleId: 'settings',
  displayName: 'Settings',
  dataVersion: 1,
  sensitive: false,
  recordCount: 1,
  blobCount: 0,
  totalBytes: 16,
};

function entry(): PortableArchiveEntry {
  const data = new TextEncoder().encode('{"theme":"dark"}');
  return {
    descriptor: {
      path: 'modules/settings/records/documents/current.json',
      moduleId: 'settings',
      kind: 'record',
      collection: 'documents',
      id: 'current',
      size: data.byteLength,
      sha256: '',
      updatedAt: '2026-07-24T00:00:00.000Z',
      contentType: 'application/json',
    },
    data,
  };
}

async function encoded() {
  return encodeArchive(
    {
      archiveId: 'archive-test',
      createdAt: '2026-07-24T00:00:00.000Z',
      appVersion: '0.1.0',
      upstreamVersion: '1.18.0',
      includeSecrets: false,
      modules: [moduleSummary],
    },
    [entry()],
  );
}

describe('Pure Tavern archive codec', () => {
  it('round-trips a versioned manifest and verifies every payload hash', async () => {
    const output = await encoded();
    const decoded = await decodeArchive(output.blob);
    expect(decoded.manifest).toMatchObject({
      format: 'pure-tavern-archive',
      schemaVersion: 1,
      archiveId: 'archive-test',
      modules: [moduleSummary],
    });
    expect(decoded.entries).toHaveLength(1);
    expect(decoded.entries[0]?.descriptor.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(new TextDecoder().decode(decoded.entries[0]?.data)).toBe('{"theme":"dark"}');
  });

  it('rejects hash tampering, zip-slip and undeclared payloads', async () => {
    const output = await encoded();
    const files = unzipSync(new Uint8Array(await output.blob.arrayBuffer()));
    const payloadPath = Object.keys(files).find((path) => path !== 'manifest.json');
    if (!payloadPath) throw new Error('Payload missing from test archive.');
    files[payloadPath] = new TextEncoder().encode('{"theme":"evil"}');
    const tampered = zipSync(files);
    await expect(decodeArchive(new Blob([tampered.slice().buffer]))).rejects.toMatchObject({
      code: 'hash-mismatch',
    });

    const slip = zipSync({
      '../outside.json': new Uint8Array([1]),
      'manifest.json': files['manifest.json']!,
    });
    await expect(decodeArchive(new Blob([slip.slice().buffer]))).rejects.toMatchObject({
      code: 'unsafe-path',
    });
  });
});
