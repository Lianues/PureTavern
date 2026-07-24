import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '@/platform/features/capability-registry';
import { CompatibilityRouter } from '@/platform/legacy/compatibility-router';
import { AppDatabase } from '@/platform/storage/app-database';
import { AppStorage, ModuleRecordStore } from '@/platform/storage/app-storage';
import { initializeStorage } from '@/platform/storage/initialize-storage';

import { PersonaService } from '../application/persona-service';
import { createEmptyPersonaState } from '../domain/persona';
import { IndexedDbPersonaRepository } from '../infrastructure/indexeddb-persona-repository';
import {
  MemoryPersonaRepository,
  ResilientPersonaRepository,
} from '../infrastructure/resilient-persona-repository';
import { createPersonasFeature } from '../module';
import type {
  LegacyPersonaStateComposer,
  LegacyPersonaStateProvider,
} from '../ports/legacy-persona-state';
import type { PersonaAssetRepository } from '../ports/persona-asset-repository';
import type { PersonaRepository } from '../ports/persona-repository';

const databases: AppDatabase[] = [];

class MetadataOnlyTestAssets implements PersonaAssetRepository {
  readonly avatars = new Set<string>();

  async hasAvatar(alias: string): Promise<boolean> {
    return this.avatars.has(alias);
  }

  async ensureAvatar(alias: string): Promise<boolean> {
    this.avatars.add(alias);
    return true;
  }

  async createAvatar(alias: string): Promise<string> {
    this.avatars.add(alias);
    return alias;
  }

  async replaceAvatar(alias: string): Promise<void> {
    this.avatars.add(alias);
  }

  async moveAvatarAlias(fromAlias: string, preferredAlias: string): Promise<string> {
    this.avatars.delete(fromAlias);
    this.avatars.add(preferredAlias);
    return preferredAlias;
  }

  async deleteAvatar(alias: string): Promise<void> {
    this.avatars.delete(alias);
  }
}

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('Persona repositories', () => {
  it('stores the aggregate in the module records namespace without a new database store', async () => {
    const database = new AppDatabase(`persona-test-${crypto.randomUUID()}`);
    databases.push(database);
    const storage = new AppStorage(database);
    await initializeStorage(storage);
    const records = storage.records.forModule('personas');
    const repository = new IndexedDbPersonaRepository(records);
    const state = createEmptyPersonaState();
    state.personas.push({
      id: 'stable-id',
      avatarAlias: 'alias.png',
      name: 'Stored',
      descriptor: { opaque: { retained: true } },
      opaque: {},
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
    });

    await repository.save(state);
    state.personas[0]!.name = 'Caller mutation';

    await expect(repository.load()).resolves.toMatchObject({
      personas: [{ id: 'stable-id', name: 'Stored', avatarAlias: 'alias.png' }],
    });
    expect((await records.list('state')).map((record) => record.id)).toEqual(['current']);
    expect(database.tables.map((table) => table.name).sort()).toEqual(['blobs', 'records']);
  });

  it('degrades to page memory with diagnostics when IndexedDB operations fail', async () => {
    const unavailable: PersonaRepository = {
      async load() {
        throw new Error('IndexedDB unavailable');
      },
      async save() {
        throw new Error('IndexedDB unavailable');
      },
    };
    const repository = new ResilientPersonaRepository(unavailable, new MemoryPersonaRepository());
    const service = new PersonaService(repository, new MetadataOnlyTestAssets(), {
      uuid: () => 'memory-persona-id',
    });

    const created = await service.createPersona({ name: 'Memory', avatarAlias: 'memory.png' });
    await expect(service.getPersona(created.id)).resolves.toMatchObject({
      id: 'memory-persona-id',
      avatarAlias: 'memory.png',
    });
    expect(repository.diagnostics).toMatchObject({
      status: 'degraded',
      backend: 'memory',
      message: 'IndexedDB unavailable',
      lastSavedAt: expect.any(String),
    });
  });
});

describe('Personas module assembly', () => {
  it('injects Assets and attaches Settings provider/composer without registering routes', async () => {
    const database = new AppDatabase(`persona-module-test-${crypto.randomUUID()}`);
    databases.push(database);
    const storage = new AppStorage(database);
    await initializeStorage(storage);
    const assets = new MetadataOnlyTestAssets();
    let provider: LegacyPersonaStateProvider | null = null;
    let composer: LegacyPersonaStateComposer | null = null;
    let installedService: PersonaService | null = null;
    const feature = createPersonasFeature({
      createAssetRepository: () => assets,
      legacyStateAdapter: {
        attach(nextProvider, nextComposer) {
          provider = nextProvider;
          composer = nextComposer;
        },
      },
      onInstall(runtime) {
        installedService = runtime.service;
      },
    });
    const router = new CompatibilityRouter();
    const result = feature.install({
      router,
      nativeFetch: fetch,
      records: new ModuleRecordStore(database, 'personas'),
      blobs: storage.blobs.forModule('personas'),
      capabilities: new CapabilityRegistry(),
    });

    expect(provider).toBe(installedService);
    expect(composer).toBe(installedService);
    expect(result.diagnostics).toMatchObject({ assets: { status: 'configured' } });
    expect(router.diagnostics.requests).toEqual([]);

    await installedService!.createPersona({ name: 'Attached', avatarAlias: 'attached.png' });
    await expect(provider!.getLegacyPersonaState()).resolves.toMatchObject({
      power_user: { personas: { 'attached.png': 'Attached' } },
    });
  });
});
