import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { AppDatabase } from '@/platform/storage/app-database';
import { ModuleRecordStore } from '@/platform/storage/app-storage';

import { PresetImportExportService } from '../application/preset-import-export-service';
import { PresetSeedService } from '../application/preset-seed-service';
import { PresetService } from '../application/preset-service';
import {
  PresetConflictError,
  PresetValidationError,
} from '../application/preset-validation';
import {
  cloneJson,
  PRESET_TYPES,
  type PresetDocument,
  type PresetSeedManifest,
} from '../domain/preset';
import { IndexedDbPresetRepository } from '../infrastructure/indexeddb-preset-repository';
import {
  MemoryPresetRepository,
  ResilientPresetRepository,
} from '../infrastructure/resilient-preset-repository';
import type { PresetStateRepository } from '../ports/preset-repository';
import type { PresetSeedLoader } from '../ports/preset-seed-loader';

const databases: AppDatabase[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.delete()));
});

describe('Preset repositories and service', () => {
  it('supports every PresetType while preserving type isolation and opaque fields', async () => {
    let nextId = 0;
    const repository = new MemoryPresetRepository(
      () => new Date('2026-07-24T00:00:00.000Z'),
      () => `preset-${++nextId}`,
    );
    const service = new PresetService(repository);

    for (const [index, type] of PRESET_TYPES.entries()) {
      await service.save(type, '共享 名称 🎭', {
        typeMarker: type,
        nested: { unknown: [`值-${index}`, { extensionField: true }] },
      });
    }

    for (const type of PRESET_TYPES) {
      const records = await service.list(type);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        type,
        name: '共享 名称 🎭',
        value: { typeMarker: type, nested: { unknown: expect.any(Array) } },
      });
    }

    await service.delete('kobold', '共享 名称 🎭');
    await expect(service.get('kobold', '共享 名称 🎭')).resolves.toBeNull();
    await expect(service.get('novel', '共享 名称 🎭')).resolves.toMatchObject({
      type: 'novel',
    });
  });

  it('uses stable document IDs, overwrites whole documents and migrates aliases on rename', async () => {
    let nextId = 0;
    const repository = new MemoryPresetRepository(undefined, () => `stable-${++nextId}`);
    const service = new PresetService(repository);

    await service.save('openai', 'Original', { old: true, removedOnOverwrite: true });
    const original = await service.get('openai', 'Original');
    await service.save('openai', 'Original', { replacement: { opaque: 42 } });
    const overwritten = await service.get('openai', 'Original');

    expect(overwritten?.id).toBe(original?.id);
    expect(overwritten?.value).toEqual({ replacement: { opaque: 42 } });

    await service.rename('openai', 'Original', 'Renamed');
    await expect(service.get('openai', 'Original')).resolves.toBeNull();
    const renamed = await service.get('openai', 'Renamed');
    expect(renamed?.id).toBe(original?.id);
    expect(renamed?.metadata).toMatchObject({ origin: 'user', userModified: true });
    await expect(repository.isTombstoned('openai', 'Original')).resolves.toBe(true);

    await service.save('openai', 'Collision', { value: 1 });
    await expect(service.rename('openai', 'Renamed', 'Collision')).rejects.toThrow(
      PresetConflictError,
    );
  });

  it('stores documents, aliases, seed state and tombstones in the shared IndexedDB records store', async () => {
    const database = new AppDatabase(`preset-test-${crypto.randomUUID()}`);
    databases.push(database);
    const records = new ModuleRecordStore(database, 'presets');
    const repository = new IndexedDbPresetRepository(
      records,
      () => new Date('2026-07-24T01:00:00.000Z'),
      () => 'indexed-stable-id',
    );

    await repository.save('context', 'Indexed', { name: 'Indexed', custom: true });
    const first = await repository.get('context', 'Indexed');
    await repository.save('context', 'Indexed', { name: 'Indexed', replaced: true });
    expect((await repository.get('context', 'Indexed'))?.id).toBe(first?.id);

    await repository.saveSeedState('context', {
      sourceHashes: { Indexed: 'hash-1' },
      synchronizedAt: '2026-07-24T01:00:00.000Z',
    });
    await repository.delete('context', 'Indexed');

    expect(await records.list('documents')).toEqual([]);
    expect(await records.list('aliases')).toEqual([]);
    expect((await records.list('seed-state')).map((record) => record.id)).toEqual(['context']);
    expect((await records.list('tombstones')).map((record) => record.id)).toEqual([
      'context:Indexed',
    ]);
  });

  it('rejects unsafe names, deep/non-JSON-safe documents and dangerous keys', async () => {
    const service = new PresetService(new MemoryPresetRepository());
    const invalidNames = [
      '',
      '..',
      '../escape',
      'folder/name',
      'folder\\name',
      'bad:name',
      'CON',
      'encoded%2fescape',
      'control\u0000name',
    ];
    for (const name of invalidNames) {
      await expect(service.save('kobold', name, { valid: true })).rejects.toThrow(
        PresetValidationError,
      );
    }

    await expect(service.save('kobold', 'Array root', [1, 2, 3])).rejects.toThrow(
      'must be a JSON object',
    );
    await expect(
      service.save('kobold', 'Dangerous', JSON.parse('{"__proto__":{"x":1}}')),
    ).rejects.toThrow('dangerous key');
    await expect(service.save('kobold', 'Non finite', { value: Number.NaN })).rejects.toThrow(
      'non-finite',
    );
    await expect(service.save('kobold', 'Date', { value: new Date() })).rejects.toThrow(
      'plain JSON',
    );

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(service.save('kobold', 'Circular', circular)).rejects.toThrow('circular');

    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let index = 0; index < 70; index += 1) {
      const child: Record<string, unknown> = {};
      deep.child = child;
      deep = child;
    }
    await expect(service.save('kobold', 'Deep', root)).rejects.toThrow('maximum JSON depth');
  });

  it('serializes concurrent writes to one type/name', async () => {
    const service = new PresetService(
      new MemoryPresetRepository(undefined, () => 'only-one-stable-id'),
    );
    const writes = Array.from({ length: 50 }, (_, index) =>
      service.save('textgenerationwebui', 'Concurrent', { index }),
    );
    await Promise.all(writes);

    const record = await service.get('textgenerationwebui', 'Concurrent');
    expect(record?.id).toBe('only-one-stable-id');
    expect(record?.value).toEqual({ index: 49 });
  });

  it('degrades to page memory and exposes diagnostics when IndexedDB is unavailable', async () => {
    const unavailable = failingRepository();
    const repository = new ResilientPresetRepository(
      unavailable,
      new MemoryPresetRepository(undefined, () => 'memory-id'),
    );
    const service = new PresetService(repository);

    await service.save('theme', 'Memory Theme', { name: 'Memory Theme', unknown: true });
    await expect(service.get('theme', 'Memory Theme')).resolves.toMatchObject({
      value: { name: 'Memory Theme', unknown: true },
    });
    expect(repository.diagnostics).toMatchObject({
      status: 'degraded',
      backend: 'memory',
      message: 'IndexedDB unavailable',
    });
  });
});

describe('default preset seed and upgrade semantics', () => {
  it('adds new defaults, updates untouched defaults, protects user changes and honors tombstones', async () => {
    const loader = new MutableSeedLoader({
      version: 1,
      presets: [
        seed('instruct', 'Untouched', { name: 'Untouched', version: 1 }, 'untouched-v1'),
        seed('instruct', 'Modified', { name: 'Modified', version: 1 }, 'modified-v1'),
        seed('instruct', 'Deleted', { name: 'Deleted', version: 1 }, 'deleted-v1'),
      ],
    });
    const repository = new MemoryPresetRepository(
      undefined,
      (() => {
        let index = 0;
        return () => `seed-${++index}`;
      })(),
    );
    const seeds = new PresetSeedService(
      repository,
      loader,
      () => new Date('2026-07-24T02:00:00.000Z'),
    );
    const service = new PresetService(repository, seeds);

    await service.initialize();
    expect(await service.list('instruct')).toHaveLength(3);
    await service.save('instruct', 'Modified', {
      name: 'Modified',
      version: 'user',
      pluginField: { preserved: true },
    });
    await service.delete('instruct', 'Deleted');

    loader.manifest = {
      version: 1,
      presets: [
        seed('instruct', 'Untouched', { name: 'Untouched', version: 2 }, 'untouched-v2'),
        seed('instruct', 'Modified', { name: 'Modified', version: 2 }, 'modified-v2'),
        seed('instruct', 'Deleted', { name: 'Deleted', version: 2 }, 'deleted-v2'),
        seed('instruct', 'Added', { name: 'Added', version: 1 }, 'added-v1'),
      ],
    };
    await service.synchronizeDefaults();

    await expect(service.get('instruct', 'Untouched')).resolves.toMatchObject({
      value: { name: 'Untouched', version: 2 },
      metadata: { origin: 'default', sourceHash: 'untouched-v2', userModified: false },
    });
    await expect(service.get('instruct', 'Modified')).resolves.toMatchObject({
      value: {
        name: 'Modified',
        version: 'user',
        pluginField: { preserved: true },
      },
      metadata: { origin: 'user', userModified: true },
    });
    await expect(service.get('instruct', 'Deleted')).resolves.toBeNull();
    await expect(service.get('instruct', 'Added')).resolves.toMatchObject({
      value: { name: 'Added', version: 1 },
    });
    await expect(repository.isTombstoned('instruct', 'Deleted')).resolves.toBe(true);
    await expect(repository.getSeedState('instruct')).resolves.toMatchObject({
      sourceHashes: {
        Untouched: 'untouched-v2',
        Modified: 'modified-v2',
        Deleted: 'deleted-v2',
        Added: 'added-v1',
      },
    });

    await expect(service.restore('instruct', 'Modified')).resolves.toEqual({
      isDefault: true,
      preset: { name: 'Modified', version: 2 },
    });
    await expect(service.restore('instruct', 'Deleted')).resolves.toEqual({
      isDefault: true,
      preset: { name: 'Deleted', version: 2 },
    });
    await expect(service.restore('instruct', 'Not Default')).resolves.toEqual({
      isDefault: false,
      preset: {},
    });
  });
});

describe('PresetImportExportService', () => {
  it('round-trips single documents and per-type bundles without internal metadata', async () => {
    const service = new PresetService(
      new MemoryPresetRepository(
        undefined,
        (() => {
          let index = 0;
          return () => `import-${++index}`;
        })(),
      ),
    );
    const codec = new PresetImportExportService(service);
    const original = {
      name: 'Opaque Prompt',
      prompt: '你好 {{char}}',
      extensionData: { futureField: [1, true, null] },
    };

    await expect(
      codec.importSingle('sysprompt', 'Opaque Prompt', JSON.stringify(original), 'overwrite'),
    ).resolves.toBe('Opaque Prompt');
    await expect(codec.exportSingle('sysprompt', 'Opaque Prompt')).resolves.toEqual(original);

    await expect(
      codec.importSingle('sysprompt', 'Opaque Prompt', { replacement: true }, 'unique'),
    ).resolves.toBe('Opaque Prompt (2)');
    const bundle = await codec.exportBundle('sysprompt');
    expect(bundle).toEqual({
      version: 1,
      type: 'sysprompt',
      presets: [
        { name: 'Opaque Prompt', preset: original },
        { name: 'Opaque Prompt (2)', preset: { replacement: true } },
      ],
    });
    expect(JSON.stringify(bundle)).not.toContain('userModified');
    expect(JSON.stringify(bundle)).not.toContain('sourceHash');

    let bundleId = 0;
    const target = new PresetImportExportService(
      new PresetService(new MemoryPresetRepository(undefined, () => `bundle-${++bundleId}`)),
    );
    await expect(
      target.importBundle('sysprompt', JSON.stringify(bundle), 'overwrite'),
    ).resolves.toEqual(['Opaque Prompt', 'Opaque Prompt (2)']);
    await expect(target.exportBundle('sysprompt')).resolves.toEqual(bundle);
  });

  it('requires an explicit conflict strategy and rejects malformed or wrong-type bundles', async () => {
    const codec = new PresetImportExportService(new PresetService(new MemoryPresetRepository()));
    await expect(codec.importSingle('theme', 'Theme', {}, undefined as never)).rejects.toThrow(
      'explicitly set',
    );
    await expect(codec.importSingle('theme', 'Theme', '{', 'overwrite')).rejects.toThrow(
      'valid JSON',
    );
    await expect(
      codec.importBundle('theme', { version: 1, type: 'quick-reply', presets: [] }, 'overwrite'),
    ).rejects.toThrow('does not match');
  });
});

class MutableSeedLoader implements PresetSeedLoader {
  manifest: PresetSeedManifest<PresetDocument>;

  constructor(manifest: PresetSeedManifest<PresetDocument>) {
    this.manifest = manifest;
  }

  async load(): Promise<PresetSeedManifest<PresetDocument>> {
    return cloneJson(this.manifest);
  }
}

function seed(
  type: PresetSeedManifest<PresetDocument>['presets'][number]['type'],
  name: string,
  value: PresetDocument,
  sourceHash: string,
) {
  return { type, name, value, sourceHash };
}

function failingRepository(): PresetStateRepository<PresetDocument> {
  const fail = async (): Promise<never> => {
    throw new Error('IndexedDB unavailable');
  };
  return {
    list: fail,
    get: fail,
    save: fail,
    delete: fail,
    rename: fail,
    isTombstoned: fail,
    getSeedState: fail,
    saveSeedState: fail,
  };
}
