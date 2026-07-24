import { clonePersonaState, type PersonaStateDocument } from '../domain/persona';
import type { PersonaRepository } from '../ports/persona-repository';

export interface PersonaStorageDiagnostics {
  status: 'ready' | 'degraded';
  backend: 'indexeddb' | 'memory';
  message: string | null;
  lastSavedAt: string | null;
}

export class MemoryPersonaRepository implements PersonaRepository {
  #state: PersonaStateDocument | null = null;
  #writeTail: Promise<void> = Promise.resolve();

  async load(): Promise<PersonaStateDocument | null> {
    await this.#writeTail;
    return this.#state ? clonePersonaState(this.#state) : null;
  }

  async save(state: PersonaStateDocument): Promise<void> {
    const snapshot = clonePersonaState(state);
    const result = this.#writeTail.then(
      () => {
        this.#state = snapshot;
      },
      () => {
        this.#state = snapshot;
      },
    );
    this.#writeTail = result;
    await result;
  }
}

export class ResilientPersonaRepository implements PersonaRepository {
  readonly diagnostics: PersonaStorageDiagnostics = {
    status: 'ready',
    backend: 'indexeddb',
    message: null,
    lastSavedAt: null,
  };

  readonly #primary: PersonaRepository;
  readonly #fallback: PersonaRepository;

  constructor(
    primary: PersonaRepository,
    fallback: PersonaRepository = new MemoryPersonaRepository(),
  ) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async load(): Promise<PersonaStateDocument | null> {
    if (this.#isDegraded()) return this.#fallback.load();
    try {
      const state = await this.#primary.load();
      if (state) await this.#fallback.save(state);
      return state;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.load();
    }
  }

  async save(state: PersonaStateDocument): Promise<void> {
    await this.#fallback.save(state);
    if (!this.#isDegraded()) {
      try {
        await this.#primary.save(state);
      } catch (error) {
        this.#degrade(error);
      }
    }
    this.diagnostics.lastSavedAt = new Date().toISOString();
  }

  #isDegraded(): boolean {
    return this.diagnostics.backend === 'memory';
  }

  #degrade(error: unknown): void {
    this.diagnostics.status = 'degraded';
    this.diagnostics.backend = 'memory';
    this.diagnostics.message = error instanceof Error ? error.message : String(error);
  }
}
