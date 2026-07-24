import type { JsonObject, LocalUserIdentity } from '../domain/persona';

export interface LegacyPersonaImportResult {
  imported: number;
  reusedStableIds: number;
  missingAvatarAliases: string[];
  selectedPersonaId: string | null;
  defaultPersonaId: string | null;
}

export interface LegacyPersonaStateFragment extends JsonObject {
  username: string;
  user_avatar: string;
  power_user: JsonObject;
}

/** Supplies the Persona-owned portion of a complete Legacy Settings document. */
export interface LegacyPersonaStateProvider {
  getLegacyPersonaState(): Promise<LegacyPersonaStateFragment>;
  getActiveLocalIdentity(): Promise<
    LocalUserIdentity & { personaId: string | null; fallback: boolean }
  >;
}

/**
 * Full-document bridge for the Settings owner. Both operations preserve unrelated Settings fields.
 * The Settings integration must invoke these from its own serialized save/get pipeline.
 */
export interface LegacyPersonaStateComposer {
  importLegacyPersonaState(settings: unknown): Promise<LegacyPersonaImportResult>;
  composeLegacyPersonaState(settings: unknown): Promise<JsonObject>;
}

export interface LegacyPersonaStateBridge
  extends LegacyPersonaStateProvider, LegacyPersonaStateComposer {}

/** Optional composition hook injected by the future Settings integration. */
export interface LegacyPersonaStateAdapter {
  attach(provider: LegacyPersonaStateProvider, composer: LegacyPersonaStateComposer): void;
}
