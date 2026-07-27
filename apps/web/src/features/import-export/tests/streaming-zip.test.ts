import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import {
  readStreamingZipDirectory,
  readZipEntryBytes,
  StreamingZipWriter,
} from '../application/streaming-zip';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class SliceOnlyBlob extends Blob {
  override arrayBuffer(): Promise<ArrayBuffer> {
    throw new Error('The complete archive must never be read with arrayBuffer().');
  }
}

function zipBlob(files: Record<string, Uint8Array>): Blob {
  const bytes = zipSync(files, { level: 6 });
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'application/zip' });
}

describe('streaming ZIP infrastructure', () => {
  it('scans through Blob slices and reads only an explicitly selected entry', async () => {
    const archive = zipBlob({
      'small/settings.json': encoder.encode('{"theme":"dark"}'),
      'large/unselected.bin': new Uint8Array(2 * 1024 * 1024).fill(7),
    });
    const sliceOnly = new SliceOnlyBlob([archive], { type: archive.type });
    const sliceSpy = vi.spyOn(sliceOnly, 'slice');

    const directory = await readStreamingZipDirectory(sliceOnly, { inputChunkSize: 1024 });
    expect(directory.entries.map((entry) => entry.path)).toEqual([
      'small/settings.json',
      'large/unselected.bin',
    ]);
    const selected = directory.entries.find((entry) => entry.path === 'small/settings.json');
    expect(selected).toBeDefined();
    expect(decoder.decode(await readZipEntryBytes(sliceOnly, selected!))).toBe('{"theme":"dark"}');
    expect(sliceSpy).toHaveBeenCalled();
    // Calling arrayBuffer() on the original archive would throw; only sliced regions are read.
  });

  it('writes entries incrementally into a valid ZIP', async () => {
    const writer = new StreamingZipWriter({ inputChunkSize: 1024 });
    await writer.add('manifest.json', encoder.encode('{"ok":true}'));
    await writer.add('modules/assets/blob.bin', new Blob([new Uint8Array(128 * 1024).fill(3)]));
    const archive = await writer.end();

    const directory = await readStreamingZipDirectory(archive);
    expect(directory.entries.map((entry) => entry.path)).toEqual([
      'manifest.json',
      'modules/assets/blob.bin',
    ]);
    const manifest = directory.entries.find((entry) => entry.path === 'manifest.json');
    expect(decoder.decode(await readZipEntryBytes(archive, manifest!))).toBe('{"ok":true}');
    const payload = directory.entries.find((entry) => entry.path === 'modules/assets/blob.bin');
    const payloadBytes = await readZipEntryBytes(archive, payload!);
    expect(payloadBytes).toHaveLength(128 * 1024);
    expect([...payloadBytes].every((value) => value === 3)).toBe(true);
  });

  it('rejects duplicate case-conflicting paths at the format layer after scanning', async () => {
    const archive = zipBlob({
      'A.json': encoder.encode('{}'),
      'a.json': encoder.encode('{}'),
    });
    const directory = await readStreamingZipDirectory(archive);
    expect(directory.entries).toHaveLength(2);
    expect(new Set(directory.entries.map((entry) => entry.path.toLowerCase())).size).toBe(1);
  });
});
