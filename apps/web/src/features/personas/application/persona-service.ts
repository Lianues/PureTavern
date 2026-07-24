import {
  cloneJson,
  clonePersona,
  clonePersonaState,
  createDefaultPersonaDescriptor,
  createEmptyPersonaState,
  DEFAULT_LOCAL_USER_IDENTITY,
  DEFAULT_PERSONA_DESCRIPTION_DEPTH,
  DEFAULT_PERSONA_DESCRIPTION_ROLE,
  getDescriptorNumber,
  getDescriptorString,
  isJsonObject,
  PERSONA_DESCRIPTION_POSITIONS,
  type JsonObject,
  type JsonValue,
  type LocalUserIdentity,
  type PersonaConnection,
  type PersonaRecord,
  type PersonaStateDocument,
} from '../domain/persona';
import type { PersonaAssetRepository } from '../ports/persona-asset-repository';
import type {
  LegacyPersonaImportResult,
  LegacyPersonaStateBridge,
  LegacyPersonaStateFragment,
} from '../ports/legacy-persona-state';
import type { PersonaRepository } from '../ports/persona-repository';
import {
  PersonaConflictError,
  PersonaNotFoundError,
  PersonaValidationError,
} from './persona-errors';

export interface PersonaServiceDiagnostics {
  lastAssetError: string | null;
  missingAvatarAliases: string[];
  lastFallbackReason: 'missing-avatar' | 'persona-deleted' | 'selection-cleared' | null;
}

export interface CreatePersonaInput {
  name: string;
  avatarAlias?: string;
  descriptor?: JsonObject;
  opaque?: JsonObject;
  avatar?: Blob;
  select?: boolean;
}

export interface UpdatePersonaInput {
  name?: string;
  avatarAlias?: string;
  descriptor?: JsonObject;
  opaque?: JsonObject;
  avatar?: Blob;
}

export interface CharacterBindingOptions {
  /** Defaults to the inverse of Legacy persona_allow_multi_connections. */
  exclusive?: boolean;
}

export interface PersonaServiceOptions {
  now?: () => Date;
  uuid?: () => string;
  defaultLocalIdentity?: LocalUserIdentity;
}

export class PersonaService implements LegacyPersonaStateBridge {
  readonly diagnostics: PersonaServiceDiagnostics = {
    lastAssetError: null,
    missingAvatarAliases: [],
    lastFallbackReason: null,
  };

  readonly #repository: PersonaRepository;
  readonly #assets: PersonaAssetRepository;
  readonly #now: () => Date;
  readonly #uuid: () => string;
  readonly #defaultLocalIdentity: LocalUserIdentity;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(
    repository: PersonaRepository,
    assets: PersonaAssetRepository,
    options: PersonaServiceOptions = {},
  ) {
    this.#repository = repository;
    this.#assets = assets;
    this.#now = options.now ?? (() => new Date());
    this.#uuid = options.uuid ?? (() => crypto.randomUUID());
    this.#defaultLocalIdentity = normalizeIdentity(
      options.defaultLocalIdentity ?? DEFAULT_LOCAL_USER_IDENTITY,
    );
  }

  async listPersonas(): Promise<PersonaRecord[]> {
    return this.#read((state) =>
      state.personas
        .map(clonePersona)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }

  async getPersona(id: string): Promise<PersonaRecord | null> {
    const normalizedId = normalizeRequiredString(id, 'Persona id');
    return this.#read((state) => {
      const persona = state.personas.find((item) => item.id === normalizedId);
      return persona ? clonePersona(persona) : null;
    });
  }

  async findPersonaByAvatarAlias(avatarAlias: string): Promise<PersonaRecord | null> {
    const alias = normalizeAvatarAlias(avatarAlias);
    return this.#read((state) => {
      const persona = state.personas.find((item) => item.avatarAlias === alias);
      return persona ? clonePersona(persona) : null;
    });
  }

  async createPersona(input: CreatePersonaInput): Promise<PersonaRecord> {
    const name = normalizePersonaName(input.name);
    const requestedId = this.#uuid();
    const id = normalizeRequiredString(requestedId, 'Generated Persona id');
    const preferredAlias = normalizeAvatarAlias(input.avatarAlias ?? `${id}.png`);
    const descriptor = createDefaultPersonaDescriptor(input.descriptor ?? {});
    const opaque = input.opaque ? cloneJsonObject(input.opaque, 'Persona opaque data') : {};

    return this.#mutate(async (state) => {
      if (state.personas.some((persona) => persona.id === id)) {
        throw new PersonaConflictError(`Persona id already exists: ${id}`);
      }
      if (state.personas.some((persona) => persona.avatarAlias === preferredAlias)) {
        throw new PersonaConflictError(`Persona avatar alias already exists: ${preferredAlias}`);
      }

      let avatarAlias = preferredAlias;
      let avatarAvailable: boolean;
      if (input.avatar) {
        avatarAlias = normalizeAvatarAlias(
          await this.#assets.createAvatar(preferredAlias, input.avatar),
        );
        if (state.personas.some((persona) => persona.avatarAlias === avatarAlias)) {
          throw new PersonaConflictError(`Persona avatar alias already exists: ${avatarAlias}`);
        }
        avatarAvailable = true;
        this.#markAvatarAvailable(avatarAlias);
      } else {
        avatarAvailable = await this.#ensureAvatar(preferredAlias);
      }

      const now = this.#now().toISOString();
      const persona: PersonaRecord = {
        id,
        avatarAlias,
        name,
        descriptor,
        opaque,
        createdAt: now,
        updatedAt: now,
      };
      state.personas.push(persona);

      if (input.select) {
        if (avatarAvailable) {
          state.selectedPersonaId = id;
          applySelectedDescriptor(state.legacyPowerUserFields, descriptor);
          this.diagnostics.lastFallbackReason = null;
        } else {
          this.#fallBackFromSelection(state, 'missing-avatar');
        }
      }

      return clonePersona(persona);
    });
  }

  async updatePersona(id: string, input: UpdatePersonaInput): Promise<PersonaRecord> {
    const normalizedId = normalizeRequiredString(id, 'Persona id');
    const name = input.name === undefined ? undefined : normalizePersonaName(input.name);
    const requestedAvatarAlias =
      input.avatarAlias === undefined ? undefined : normalizeAvatarAlias(input.avatarAlias);
    const descriptorPatch =
      input.descriptor === undefined
        ? undefined
        : cloneJsonObject(input.descriptor, 'Persona descriptor');
    const opaquePatch =
      input.opaque === undefined ? undefined : cloneJsonObject(input.opaque, 'Persona opaque data');

    return this.#mutate(async (state) => {
      const persona = requirePersona(state, normalizedId);
      if (requestedAvatarAlias !== undefined && requestedAvatarAlias !== persona.avatarAlias) {
        if (
          state.personas.some(
            (item) => item.id !== persona.id && item.avatarAlias === requestedAvatarAlias,
          )
        ) {
          throw new PersonaConflictError(
            `Persona avatar alias already exists: ${requestedAvatarAlias}`,
          );
        }
        const oldAlias = persona.avatarAlias;
        const movedAlias = normalizeAvatarAlias(
          await this.#assets.moveAvatarAlias(oldAlias, requestedAvatarAlias),
        );
        if (
          state.personas.some((item) => item.id !== persona.id && item.avatarAlias === movedAlias)
        ) {
          throw new PersonaConflictError(`Persona avatar alias already exists: ${movedAlias}`);
        }
        persona.avatarAlias = movedAlias;
        this.#markAvatarAvailable(oldAlias);
        this.#markAvatarAvailable(movedAlias);
      }
      if (input.avatar) {
        await this.#assets.replaceAvatar(persona.avatarAlias, input.avatar);
        this.#markAvatarAvailable(persona.avatarAlias);
      }
      if (name !== undefined) persona.name = name;
      if (descriptorPatch !== undefined) {
        persona.descriptor = { ...persona.descriptor, ...descriptorPatch };
      }
      if (opaquePatch !== undefined) persona.opaque = { ...persona.opaque, ...opaquePatch };
      persona.updatedAt = this.#now().toISOString();
      if (state.selectedPersonaId === persona.id) {
        applySelectedDescriptor(state.legacyPowerUserFields, persona.descriptor);
      }
      return clonePersona(persona);
    });
  }

  async deletePersona(id: string): Promise<PersonaRecord> {
    const normalizedId = normalizeRequiredString(id, 'Persona id');
    return this.#mutate(async (state) => {
      const persona = requirePersona(state, normalizedId);
      state.personas = state.personas.filter((item) => item.id !== normalizedId);
      if (state.defaultPersonaId === normalizedId) state.defaultPersonaId = null;
      if (state.selectedPersonaId === normalizedId) {
        this.#fallBackFromSelection(state, 'persona-deleted');
      }

      try {
        if (await this.#assets.hasAvatar(persona.avatarAlias)) {
          await this.#assets.deleteAvatar(persona.avatarAlias);
        }
        this.#markAvatarAvailable(persona.avatarAlias);
      } catch (error) {
        this.#recordAssetError(error);
      }
      return clonePersona(persona);
    });
  }

  async selectPersona(
    id: string | null,
  ): Promise<LocalUserIdentity & { personaId: string | null }> {
    const normalizedId = id === null ? null : normalizeRequiredString(id, 'Persona id');
    return this.#mutate(async (state) => {
      if (normalizedId === null) {
        this.#fallBackFromSelection(state, 'selection-cleared');
        return { ...state.localIdentity, personaId: null };
      }

      const persona = requirePersona(state, normalizedId);
      if (!(await this.#ensureAvatar(persona.avatarAlias))) {
        this.#fallBackFromSelection(state, 'missing-avatar');
        return { ...state.localIdentity, personaId: null };
      }

      state.selectedPersonaId = persona.id;
      applySelectedDescriptor(state.legacyPowerUserFields, persona.descriptor);
      this.diagnostics.lastFallbackReason = null;
      return { name: persona.name, avatarAlias: persona.avatarAlias, personaId: persona.id };
    });
  }

  async setDefaultPersona(id: string | null): Promise<PersonaRecord | null> {
    const normalizedId = id === null ? null : normalizeRequiredString(id, 'Persona id');
    return this.#mutate(async (state) => {
      if (normalizedId === null) {
        state.defaultPersonaId = null;
        return null;
      }
      const persona = requirePersona(state, normalizedId);
      if (!(await this.#ensureAvatar(persona.avatarAlias))) {
        state.defaultPersonaId = null;
        this.diagnostics.lastFallbackReason = 'missing-avatar';
        return null;
      }
      state.defaultPersonaId = persona.id;
      return clonePersona(persona);
    });
  }

  async bindCharacter(
    personaId: string,
    characterAvatar: string,
    options: CharacterBindingOptions = {},
  ): Promise<void> {
    const normalizedPersonaId = normalizeRequiredString(personaId, 'Persona id');
    const characterId = normalizeRequiredString(characterAvatar, 'Character avatar');
    return this.#mutate(async (state) => {
      const target = requirePersona(state, normalizedPersonaId);
      const exclusive =
        options.exclusive ?? state.legacyPowerUserFields.persona_allow_multi_connections !== true;
      const connection: PersonaConnection = { type: 'character', id: characterId };

      if (exclusive) {
        for (const persona of state.personas) {
          if (persona.id === target.id) continue;
          if (removeConnection(persona.descriptor, connection)) {
            persona.updatedAt = this.#now().toISOString();
          }
        }
      }

      const current = Array.isArray(target.descriptor.connections)
        ? cloneJson(target.descriptor.connections)
        : [];
      if (!current.some((value) => connectionMatches(value, connection))) {
        current.push(connection);
        target.descriptor.connections = current;
        target.updatedAt = this.#now().toISOString();
      }
    });
  }

  async unbindCharacter(personaId: string, characterAvatar: string): Promise<void> {
    const normalizedPersonaId = normalizeRequiredString(personaId, 'Persona id');
    const characterId = normalizeRequiredString(characterAvatar, 'Character avatar');
    return this.#mutate(async (state) => {
      const persona = requirePersona(state, normalizedPersonaId);
      if (removeConnection(persona.descriptor, { type: 'character', id: characterId })) {
        persona.updatedAt = this.#now().toISOString();
      }
    });
  }

  async getPersonasBoundToCharacter(characterAvatar: string): Promise<PersonaRecord[]> {
    const characterId = normalizeRequiredString(characterAvatar, 'Character avatar');
    return this.#read((state) =>
      state.personas
        .filter((persona) =>
          Array.isArray(persona.descriptor.connections)
            ? persona.descriptor.connections.some((value) =>
                connectionMatches(value, { type: 'character', id: characterId }),
              )
            : false,
        )
        .map(clonePersona),
    );
  }

  async setLegacyPersonaPreference(key: string, value: JsonValue): Promise<void> {
    if (!key.startsWith('persona_') || key === 'persona_descriptions') {
      throw new PersonaValidationError('Legacy Persona preference keys must begin with persona_.');
    }
    const snapshot = cloneJson(value);
    return this.#mutate(async (state) => {
      state.legacyPowerUserFields[key] = snapshot;
    });
  }

  async importLegacyPersonaState(settings: unknown): Promise<LegacyPersonaImportResult> {
    const incoming = cloneSettingsObject(settings);
    const powerUser = isJsonObject(incoming.power_user) ? incoming.power_user : {};
    const legacyPersonas = isJsonObject(powerUser.personas) ? powerUser.personas : {};
    const legacyDescriptions = isJsonObject(powerUser.persona_descriptions)
      ? powerUser.persona_descriptions
      : {};

    return this.#mutate(async (state) => {
      this.diagnostics.missingAvatarAliases = [];
      this.diagnostics.lastAssetError = null;
      const previousByAlias = new Map(
        state.personas.map((persona) => [persona.avatarAlias, persona] as const),
      );
      const now = this.#now().toISOString();
      const personas: PersonaRecord[] = [];
      let reusedStableIds = 0;

      for (const [avatarAliasInput, nameValue] of Object.entries(legacyPersonas)) {
        const avatarAlias = normalizeAvatarAlias(avatarAliasInput);
        const previous = previousByAlias.get(avatarAlias);
        if (previous) reusedStableIds += 1;
        const descriptorValue = legacyDescriptions[avatarAlias];
        const descriptor = isJsonObject(descriptorValue) ? cloneJson(descriptorValue) : {};
        personas.push({
          id: previous?.id ?? normalizeRequiredString(this.#uuid(), 'Generated Persona id'),
          avatarAlias,
          name: typeof nameValue === 'string' ? nameValue : String(nameValue ?? ''),
          descriptor,
          opaque: previous ? cloneJson(previous.opaque) : {},
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        });
      }

      assertUniquePersonas(personas);
      const aliases = new Set(personas.map((persona) => persona.avatarAlias));
      const orphanDescriptions = Object.fromEntries(
        Object.entries(legacyDescriptions)
          .filter(([avatarAlias]) => !aliases.has(avatarAlias))
          .map(([avatarAlias, descriptor]) => [avatarAlias, cloneJson(descriptor)]),
      ) as JsonObject;
      const legacyPowerUserFields = Object.fromEntries(
        Object.entries(powerUser)
          .filter(([key]) => key.startsWith('persona_') && key !== 'persona_descriptions')
          .map(([key, value]) => [key, cloneJson(value)]),
      ) as JsonObject;

      const availableIds = new Set<string>();
      for (const persona of personas) {
        if (await this.#ensureAvatar(persona.avatarAlias)) availableIds.add(persona.id);
      }

      const requestedAvatar =
        typeof incoming.user_avatar === 'string'
          ? incoming.user_avatar
          : state.localIdentity.avatarAlias;
      const requestedSelected = personas.find((persona) => persona.avatarAlias === requestedAvatar);
      const requestedDefaultAlias =
        typeof powerUser.default_persona === 'string' ? powerUser.default_persona : null;
      const requestedDefault = personas.find(
        (persona) => persona.avatarAlias === requestedDefaultAlias,
      );

      let localIdentity = state.localIdentity;
      if (!requestedSelected) {
        localIdentity = normalizeIdentity({
          name:
            typeof incoming.username === 'string' ? incoming.username : state.localIdentity.name,
          avatarAlias: requestedAvatar || state.localIdentity.avatarAlias,
        });
      }

      state.personas = personas;
      state.localIdentity = localIdentity;
      state.legacyPowerUserFields = legacyPowerUserFields;
      state.orphanDescriptions = orphanDescriptions;
      state.selectedPersonaId =
        requestedSelected && availableIds.has(requestedSelected.id) ? requestedSelected.id : null;
      state.defaultPersonaId =
        requestedDefault && availableIds.has(requestedDefault.id) ? requestedDefault.id : null;

      if (state.selectedPersonaId) {
        applySelectedDescriptor(
          state.legacyPowerUserFields,
          requirePersona(state, state.selectedPersonaId).descriptor,
        );
        this.diagnostics.lastFallbackReason = null;
      } else if (requestedSelected) {
        this.#fallBackFromSelection(state, 'missing-avatar');
      }

      return {
        imported: personas.length,
        reusedStableIds,
        missingAvatarAliases: [...this.diagnostics.missingAvatarAliases],
        selectedPersonaId: state.selectedPersonaId,
        defaultPersonaId: state.defaultPersonaId,
      };
    });
  }

  async composeLegacyPersonaState(settings: unknown): Promise<JsonObject> {
    const base = cloneSettingsObject(settings);
    return this.#read((state) => composeLegacySettings(base, state));
  }

  async getLegacyPersonaState(): Promise<LegacyPersonaStateFragment> {
    return (await this.composeLegacyPersonaState({})) as LegacyPersonaStateFragment;
  }

  async getActiveLocalIdentity(): Promise<
    LocalUserIdentity & { personaId: string | null; fallback: boolean }
  > {
    return this.#read((state) => {
      const persona = state.selectedPersonaId
        ? state.personas.find((item) => item.id === state.selectedPersonaId)
        : null;
      return persona
        ? {
            name: persona.name,
            avatarAlias: persona.avatarAlias,
            personaId: persona.id,
            fallback: false,
          }
        : { ...state.localIdentity, personaId: null, fallback: true };
    });
  }

  async #read<T>(operation: (state: PersonaStateDocument) => T | Promise<T>): Promise<T> {
    await this.#writeTail;
    const state = await this.#loadState();
    return operation(clonePersonaState(state));
  }

  #mutate<T>(operation: (state: PersonaStateDocument) => T | Promise<T>): Promise<T> {
    return this.#write(async () => {
      const state = await this.#loadState();
      const result = await operation(state);
      await this.#repository.save(state);
      return result;
    });
  }

  #write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeTail.then(operation, operation);
    this.#writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #loadState(): Promise<PersonaStateDocument> {
    return (await this.#repository.load()) ?? createEmptyPersonaState(this.#defaultLocalIdentity);
  }

  async #ensureAvatar(avatarAlias: string): Promise<boolean> {
    try {
      if (await this.#assets.hasAvatar(avatarAlias)) {
        this.#markAvatarAvailable(avatarAlias);
        return true;
      }
      if (await this.#assets.ensureAvatar(avatarAlias)) {
        this.#markAvatarAvailable(avatarAlias);
        return true;
      }
    } catch (error) {
      this.#recordAssetError(error);
    }
    this.#markAvatarMissing(avatarAlias);
    return false;
  }

  #fallBackFromSelection(
    state: PersonaStateDocument,
    reason: Exclude<PersonaServiceDiagnostics['lastFallbackReason'], null>,
  ): void {
    state.selectedPersonaId = null;
    resetSelectedDescriptor(state.legacyPowerUserFields);
    this.diagnostics.lastFallbackReason = reason;
  }

  #recordAssetError(error: unknown): void {
    this.diagnostics.lastAssetError = error instanceof Error ? error.message : String(error);
  }

  #markAvatarMissing(avatarAlias: string): void {
    if (!this.diagnostics.missingAvatarAliases.includes(avatarAlias)) {
      this.diagnostics.missingAvatarAliases.push(avatarAlias);
      this.diagnostics.missingAvatarAliases.sort();
    }
  }

  #markAvatarAvailable(avatarAlias: string): void {
    this.diagnostics.missingAvatarAliases = this.diagnostics.missingAvatarAliases.filter(
      (alias) => alias !== avatarAlias,
    );
  }
}

function composeLegacySettings(base: JsonObject, state: PersonaStateDocument): JsonObject {
  const output = cloneJson(base);
  const powerUser = isJsonObject(output.power_user) ? cloneJson(output.power_user) : {};
  for (const [key, value] of Object.entries(state.legacyPowerUserFields)) {
    powerUser[key] = cloneJson(value);
  }

  powerUser.personas = Object.fromEntries(
    state.personas.map((persona) => [persona.avatarAlias, persona.name]),
  ) as JsonObject;
  powerUser.persona_descriptions = {
    ...cloneJson(state.orphanDescriptions),
    ...Object.fromEntries(
      state.personas.map((persona) => [persona.avatarAlias, cloneJson(persona.descriptor)]),
    ),
  } as JsonObject;
  const defaultPersona = state.defaultPersonaId
    ? state.personas.find((persona) => persona.id === state.defaultPersonaId)
    : null;
  powerUser.default_persona = defaultPersona?.avatarAlias ?? null;

  const selectedPersona = state.selectedPersonaId
    ? state.personas.find((persona) => persona.id === state.selectedPersonaId)
    : null;
  if (selectedPersona) {
    output.username = selectedPersona.name;
    output.user_avatar = selectedPersona.avatarAlias;
    applySelectedDescriptor(powerUser, selectedPersona.descriptor);
  } else {
    output.username = state.localIdentity.name;
    output.user_avatar = state.localIdentity.avatarAlias;
  }
  output.power_user = powerUser;
  return output;
}

function applySelectedDescriptor(powerUser: JsonObject, descriptor: JsonObject): void {
  powerUser.persona_description = getDescriptorString(descriptor, 'description');
  powerUser.persona_description_position = getDescriptorNumber(
    descriptor,
    'position',
    PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT,
  );
  powerUser.persona_description_depth = getDescriptorNumber(
    descriptor,
    'depth',
    DEFAULT_PERSONA_DESCRIPTION_DEPTH,
  );
  powerUser.persona_description_role = getDescriptorNumber(
    descriptor,
    'role',
    DEFAULT_PERSONA_DESCRIPTION_ROLE,
  );
  powerUser.persona_description_lorebook = getDescriptorString(descriptor, 'lorebook');
}

function resetSelectedDescriptor(powerUser: JsonObject): void {
  applySelectedDescriptor(powerUser, {});
}

function removeConnection(descriptor: JsonObject, target: PersonaConnection): boolean {
  if (!Array.isArray(descriptor.connections)) return false;
  const filtered = descriptor.connections.filter((value) => !connectionMatches(value, target));
  if (filtered.length === descriptor.connections.length) return false;
  descriptor.connections = filtered;
  return true;
}

function connectionMatches(value: JsonValue, target: PersonaConnection): boolean {
  return isJsonObject(value) && value.type === target.type && value.id === target.id;
}

function requirePersona(state: PersonaStateDocument, id: string): PersonaRecord {
  const persona = state.personas.find((item) => item.id === id);
  if (!persona) throw new PersonaNotFoundError(`Persona not found: ${id}`);
  return persona;
}

function assertUniquePersonas(personas: PersonaRecord[]): void {
  const ids = new Set<string>();
  const aliases = new Set<string>();
  for (const persona of personas) {
    if (ids.has(persona.id)) throw new PersonaConflictError(`Duplicate Persona id: ${persona.id}`);
    if (aliases.has(persona.avatarAlias)) {
      throw new PersonaConflictError(`Duplicate Persona avatar alias: ${persona.avatarAlias}`);
    }
    ids.add(persona.id);
    aliases.add(persona.avatarAlias);
  }
}

function cloneSettingsObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    throw new PersonaValidationError('Legacy Settings payload must be a JSON object.');
  }
  try {
    return cloneJson(value);
  } catch (error) {
    throw new PersonaValidationError('Legacy Settings payload must be JSON-serializable.', {
      cause: error,
    });
  }
}

function cloneJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new PersonaValidationError(`${label} must be a JSON object.`);
  try {
    return cloneJson(value);
  } catch (error) {
    throw new PersonaValidationError(`${label} must be JSON-serializable.`, { cause: error });
  }
}

function normalizePersonaName(value: unknown): string {
  const name = normalizeRequiredString(value, 'Persona name').trim();
  if (!name) throw new PersonaValidationError('Persona name is required.');
  return name;
}

function normalizeAvatarAlias(value: unknown): string {
  const alias = normalizeRequiredString(value, 'Persona avatar alias').trim();
  if (!alias) throw new PersonaValidationError('Persona avatar alias is required.');
  const hasControlCharacter = [...alias].some((character) => character.charCodeAt(0) <= 31);
  if (
    alias.includes('/') ||
    alias.includes('\\') ||
    hasControlCharacter ||
    alias === '.' ||
    alias === '..'
  ) {
    throw new PersonaValidationError(`Invalid Persona avatar alias: ${alias}`);
  }
  return alias;
}

function normalizeRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PersonaValidationError(`${label} must be a non-empty string.`);
  }
  return value;
}

function normalizeIdentity(value: LocalUserIdentity): LocalUserIdentity {
  return {
    name: normalizeRequiredString(value.name, 'Local user name'),
    avatarAlias: normalizeAvatarAlias(value.avatarAlias),
  };
}
