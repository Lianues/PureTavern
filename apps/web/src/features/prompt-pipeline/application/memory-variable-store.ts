import type { MacroVariableStore } from '../domain/prompt-pipeline';

export class MemoryMacroVariableStore implements MacroVariableStore {
  readonly #values = new Map<string, unknown>();

  constructor(initial?: Readonly<Record<string, unknown>>) {
    for (const [key, value] of Object.entries(initial ?? {})) {
      this.#values.set(key, value);
    }
  }

  has(name: string): boolean {
    return this.#values.has(name);
  }

  get(name: string): unknown {
    return this.#values.get(name);
  }

  set(name: string, value: unknown): void {
    this.#values.set(name, value);
  }

  delete(name: string): boolean {
    return this.#values.delete(name);
  }

  snapshot(): Readonly<Record<string, unknown>> {
    return Object.fromEntries(this.#values);
  }
}
