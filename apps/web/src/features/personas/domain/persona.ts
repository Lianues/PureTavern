export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type PersonaConnectionType = 'character' | 'group';

export interface PersonaConnection extends JsonObject {
  type: PersonaConnectionType;
  id: string;
}

export interface LocalUserIdentity {
  name: string;
  avatarAlias: string;
}

export interface PersonaRecord {
  /** Stable browser-local identity. It is never derived from a mutable avatar filename. */
  id: string;
  /** Legacy user-avatar filename, used as the key in power_user.personas. */
  avatarAlias: string;
  name: string;
  /** Complete Legacy descriptor, including fields unknown to this module. */
  descriptor: JsonObject;
  /** Module-level extension fields that are not represented by Legacy settings. */
  opaque: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaStateDocument {
  version: 1;
  personas: PersonaRecord[];
  selectedPersonaId: string | null;
  defaultPersonaId: string | null;
  localIdentity: LocalUserIdentity;
  /**
   * All imported power_user keys beginning with persona_, except persona_descriptions.
   * This retains current-description preferences and future Legacy fields losslessly.
   */
  legacyPowerUserFields: JsonObject;
  /** Descriptor entries without a matching power_user.personas alias. */
  orphanDescriptions: JsonObject;
}

export const DEFAULT_LOCAL_USER_IDENTITY: Readonly<LocalUserIdentity> = Object.freeze({
  name: 'User',
  avatarAlias: 'user-default.png',
});

export const PERSONA_DESCRIPTION_POSITIONS = Object.freeze({
  IN_PROMPT: 0,
  AFTER_CHAR: 1,
  TOP_AN: 2,
  BOTTOM_AN: 3,
  AT_DEPTH: 4,
  NONE: 9,
});

export const DEFAULT_PERSONA_DESCRIPTION_DEPTH = 2;
export const DEFAULT_PERSONA_DESCRIPTION_ROLE = 0;

export function createEmptyPersonaState(
  localIdentity: LocalUserIdentity = DEFAULT_LOCAL_USER_IDENTITY,
): PersonaStateDocument {
  return {
    version: 1,
    personas: [],
    selectedPersonaId: null,
    defaultPersonaId: null,
    localIdentity: { ...localIdentity },
    legacyPowerUserFields: {},
    orphanDescriptions: {},
  };
}

export function createDefaultPersonaDescriptor(input: JsonObject = {}): JsonObject {
  return {
    description: '',
    position: PERSONA_DESCRIPTION_POSITIONS.IN_PROMPT,
    depth: DEFAULT_PERSONA_DESCRIPTION_DEPTH,
    role: DEFAULT_PERSONA_DESCRIPTION_ROLE,
    lorebook: '',
    connections: [],
    title: '',
    ...cloneJson(input),
  };
}

export function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Persona data must be JSON-serializable.');
  return JSON.parse(serialized) as T;
}

export function clonePersona(record: PersonaRecord): PersonaRecord {
  return cloneJson(record);
}

export function clonePersonaState(state: PersonaStateDocument): PersonaStateDocument {
  return cloneJson(state);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function toJsonObject(value: unknown): JsonObject {
  return isJsonObject(value) ? cloneJson(value) : {};
}

export function getPersonaConnections(descriptor: JsonObject): PersonaConnection[] {
  const connections = descriptor.connections;
  if (!Array.isArray(connections)) return [];
  return connections
    .filter(
      (value): value is JsonObject =>
        isJsonObject(value) &&
        (value.type === 'character' || value.type === 'group') &&
        typeof value.id === 'string' &&
        value.id.length > 0,
    )
    .map((value) => cloneJson(value) as PersonaConnection);
}

export function getDescriptorString(
  descriptor: JsonObject,
  key: 'description' | 'lorebook' | 'title',
  fallback = '',
): string {
  return typeof descriptor[key] === 'string' ? descriptor[key] : fallback;
}

export function getDescriptorNumber(
  descriptor: JsonObject,
  key: 'position' | 'depth' | 'role',
  fallback: number,
): number {
  return typeof descriptor[key] === 'number' && Number.isFinite(descriptor[key])
    ? descriptor[key]
    : fallback;
}
