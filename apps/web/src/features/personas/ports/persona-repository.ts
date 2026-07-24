import type { PersonaStateDocument } from '../domain/persona';

/** Persists the complete Persona aggregate in this feature's generic records namespace. */
export interface PersonaRepository {
  load(): Promise<PersonaStateDocument | null>;
  save(state: PersonaStateDocument): Promise<void>;
}
