import { describe, expect, it } from 'vitest';

import { PersonaService } from '../application/persona-service';
import type { JsonObject } from '../domain/persona';
import { MemoryPersonaRepository } from '../infrastructure/resilient-persona-repository';
import type { PersonaAssetRepository } from '../ports/persona-asset-repository';

class TestPersonaAssets implements PersonaAssetRepository {
  readonly avatars = new Set<string>();
  readonly ensured: string[] = [];
  readonly deleted: string[] = [];
  readonly moved: [string, string][] = [];
  canEnsure = true;

  async hasAvatar(avatarAlias: string): Promise<boolean> {
    return this.avatars.has(avatarAlias);
  }

  async ensureAvatar(avatarAlias: string): Promise<boolean> {
    this.ensured.push(avatarAlias);
    if (!this.canEnsure) return false;
    this.avatars.add(avatarAlias);
    return true;
  }

  async createAvatar(preferredAlias: string): Promise<string> {
    this.avatars.add(preferredAlias);
    return preferredAlias;
  }

  async replaceAvatar(avatarAlias: string): Promise<void> {
    this.avatars.add(avatarAlias);
  }

  async moveAvatarAlias(fromAlias: string, preferredAlias: string): Promise<string> {
    this.avatars.delete(fromAlias);
    this.avatars.add(preferredAlias);
    this.moved.push([fromAlias, preferredAlias]);
    return preferredAlias;
  }

  async deleteAvatar(avatarAlias: string): Promise<void> {
    this.avatars.delete(avatarAlias);
    this.deleted.push(avatarAlias);
  }
}

function createHarness(options: { assets?: TestPersonaAssets; prefix?: string } = {}) {
  const assets = options.assets ?? new TestPersonaAssets();
  let nextId = 0;
  const service = new PersonaService(new MemoryPersonaRepository(), assets, {
    now: () => new Date(`2026-07-24T00:00:${String(nextId).padStart(2, '0')}.000Z`),
    uuid: () => `${options.prefix ?? 'persona'}-${++nextId}`,
  });
  return { service, assets };
}

describe('PersonaService CRUD and identity', () => {
  it('keeps stable Persona ids independent from display names and avatar/file aliases', async () => {
    const { service, assets } = createHarness();
    const created = await service.createPersona({
      name: 'Alice',
      avatarAlias: 'legacy-file.png',
      descriptor: { description: 'Original', extension_payload: { nested: [1, true, 'x'] } },
      opaque: { moduleExtension: 'kept' },
    });

    expect(created.id).toBe('persona-1');
    expect(created.avatarAlias).toBe('legacy-file.png');
    expect(assets.ensured).toEqual(['legacy-file.png']);

    const updated = await service.updatePersona(created.id, {
      name: 'Renamed display only',
      avatarAlias: 'renamed-file.png',
      descriptor: { description: 'Updated' },
    });
    expect(updated).toMatchObject({
      id: 'persona-1',
      avatarAlias: 'renamed-file.png',
      name: 'Renamed display only',
      descriptor: {
        description: 'Updated',
        extension_payload: { nested: [1, true, 'x'] },
      },
      opaque: { moduleExtension: 'kept' },
    });

    await expect(service.findPersonaByAvatarAlias('legacy-file.png')).resolves.toBeNull();
    await expect(service.findPersonaByAvatarAlias('renamed-file.png')).resolves.toMatchObject({
      id: created.id,
    });
    expect(assets.moved).toEqual([['legacy-file.png', 'renamed-file.png']]);
    await service.deletePersona(created.id);
    await expect(service.listPersonas()).resolves.toEqual([]);
    expect(assets.deleted).toEqual(['renamed-file.png']);
  });

  it('serializes concurrent writes so the last invocation wins without changing the stable id', async () => {
    const { service } = createHarness();
    const persona = await service.createPersona({ name: 'Start', avatarAlias: 'serial.png' });

    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        service.updatePersona(persona.id, {
          name: `Name ${index}`,
          descriptor: { orderedWrite: index },
        }),
      ),
    );

    await expect(service.getPersona(persona.id)).resolves.toMatchObject({
      id: persona.id,
      avatarAlias: 'serial.png',
      name: 'Name 24',
      descriptor: { orderedWrite: 24 },
    });
  });
});

describe('Persona selection, defaults, and character binding', () => {
  it('selects/defaults independently and mirrors the selected descriptor into Legacy Settings', async () => {
    const { service } = createHarness();
    const alice = await service.createPersona({
      name: 'Alice',
      avatarAlias: 'alice.png',
      descriptor: {
        description: 'Alice description',
        position: 4,
        depth: 7,
        role: 2,
        lorebook: 'Alice lore',
      },
    });
    const bob = await service.createPersona({ name: 'Bob', avatarAlias: 'bob.png' });

    await service.selectPersona(alice.id);
    await service.setDefaultPersona(bob.id);
    const settings = await service.composeLegacyPersonaState({ unrelated: { kept: true } });

    expect(settings).toMatchObject({
      unrelated: { kept: true },
      username: 'Alice',
      user_avatar: 'alice.png',
      power_user: {
        default_persona: 'bob.png',
        persona_description: 'Alice description',
        persona_description_position: 4,
        persona_description_depth: 7,
        persona_description_role: 2,
        persona_description_lorebook: 'Alice lore',
      },
    });
    await expect(service.getActiveLocalIdentity()).resolves.toEqual({
      name: 'Alice',
      avatarAlias: 'alice.png',
      personaId: alice.id,
      fallback: false,
    });

    await service.setDefaultPersona(null);
    await service.selectPersona(null);
    await expect(service.getLegacyPersonaState()).resolves.toMatchObject({
      username: 'User',
      user_avatar: 'user-default.png',
      power_user: { default_persona: null, persona_description: '' },
    });
  });

  it('binds/unbinds character avatar keys and honors Legacy multi-connection preference', async () => {
    const { service } = createHarness();
    const alice = await service.createPersona({ name: 'Alice', avatarAlias: 'alice.png' });
    const bob = await service.createPersona({ name: 'Bob', avatarAlias: 'bob.png' });

    await service.bindCharacter(alice.id, 'character.png');
    await service.bindCharacter(bob.id, 'character.png');
    await expect(service.getPersonasBoundToCharacter('character.png')).resolves.toMatchObject([
      { id: bob.id },
    ]);

    await service.setLegacyPersonaPreference('persona_allow_multi_connections', true);
    await service.bindCharacter(alice.id, 'character.png');
    await expect(service.getPersonasBoundToCharacter('character.png')).resolves.toMatchObject([
      { id: alice.id },
      { id: bob.id },
    ]);

    await service.unbindCharacter(bob.id, 'character.png');
    await expect(service.getPersonasBoundToCharacter('character.png')).resolves.toMatchObject([
      { id: alice.id },
    ]);
  });
});

describe('Legacy Persona Settings bridge', () => {
  it('round-trips complete Settings while preserving opaque descriptors, future fields, and roots', async () => {
    const assets = new TestPersonaAssets();
    assets.avatars.add('alice.png');
    const { service } = createHarness({ assets });
    const settings: JsonObject = {
      root_extension: { survives: ['yes', 42] },
      username: 'Alice',
      user_avatar: 'alice.png',
      power_user: {
        unrelated_power_user: { untouched: true },
        personas: { 'alice.png': 'Alice' },
        default_persona: 'alice.png',
        persona_descriptions: {
          'alice.png': {
            description: 'Persona text',
            position: 4,
            depth: 3,
            role: 1,
            lorebook: 'Lore',
            title: 'Display only',
            connections: [{ type: 'character', id: 'char.png', connection_extension: 'preserved' }],
            plugin_extension: { nested: { value: true } },
          },
          'orphan.png': { future_orphan: 'preserved' },
        },
        persona_description: 'Persona text',
        persona_description_position: 4,
        persona_description_depth: 3,
        persona_description_role: 1,
        persona_description_lorebook: 'Lore',
        persona_show_notifications: false,
        persona_sort_order: 'desc',
        persona_allow_multi_connections: true,
        persona_auto_lock: true,
        persona_future_setting: { opaque: ['future'] },
      },
    };

    const firstImport = await service.importLegacyPersonaState(settings);
    const firstRecord = (await service.listPersonas())[0]!;
    expect(firstImport).toMatchObject({ imported: 1, reusedStableIds: 0 });
    expect(firstRecord.descriptor).toMatchObject({
      plugin_extension: { nested: { value: true } },
      connections: [{ connection_extension: 'preserved' }],
    });
    await expect(service.composeLegacyPersonaState(settings)).resolves.toEqual(settings);

    const secondImport = await service.importLegacyPersonaState(settings);
    const secondRecord = (await service.listPersonas())[0]!;
    expect(secondImport.reusedStableIds).toBe(1);
    expect(secondRecord.id).toBe(firstRecord.id);
    expect(secondRecord.avatarAlias).toBe('alice.png');
  });

  it('asks Assets for missing avatars and falls back when the selected/default alias stays missing', async () => {
    const assets = new TestPersonaAssets();
    assets.canEnsure = false;
    const { service } = createHarness({ assets });

    const result = await service.importLegacyPersonaState({
      username: 'Missing Persona',
      user_avatar: 'missing.png',
      power_user: {
        personas: { 'missing.png': 'Missing Persona' },
        default_persona: 'missing.png',
        persona_descriptions: { 'missing.png': { description: 'Unavailable' } },
      },
    });

    expect(result).toMatchObject({
      imported: 1,
      selectedPersonaId: null,
      defaultPersonaId: null,
      missingAvatarAliases: ['missing.png'],
    });
    expect(assets.ensured).toEqual(['missing.png']);
    expect(service.diagnostics).toMatchObject({
      missingAvatarAliases: ['missing.png'],
      lastFallbackReason: 'missing-avatar',
    });
    await expect(service.getLegacyPersonaState()).resolves.toMatchObject({
      username: 'User',
      user_avatar: 'user-default.png',
      power_user: { default_persona: null, persona_description: '' },
    });
  });

  it('falls back to the local identity and clears default state after deleting the active Persona', async () => {
    const { service, assets } = createHarness();
    const persona = await service.createPersona({
      name: 'Temporary',
      avatarAlias: 'temporary.png',
      select: true,
    });
    await service.setDefaultPersona(persona.id);

    await service.deletePersona(persona.id);

    expect(assets.deleted).toContain('temporary.png');
    expect(service.diagnostics.lastFallbackReason).toBe('persona-deleted');
    await expect(service.getActiveLocalIdentity()).resolves.toEqual({
      name: 'User',
      avatarAlias: 'user-default.png',
      personaId: null,
      fallback: true,
    });
    await expect(service.getLegacyPersonaState()).resolves.toMatchObject({
      username: 'User',
      user_avatar: 'user-default.png',
      power_user: {
        personas: {},
        persona_descriptions: {},
        default_persona: null,
      },
    });
  });
});
