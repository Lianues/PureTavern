declare const capabilityContract: unique symbol;

export interface CapabilityToken<T> {
  readonly id: string;
  readonly [capabilityContract]?: (capability: T) => T;
}

export function defineCapability<T>(id: string): CapabilityToken<T> {
  if (!id.trim()) throw new TypeError('Capability id must be non-empty.');
  return Object.freeze({ id });
}

export class CapabilityRegistry {
  readonly #capabilities = new Map<string, unknown>();

  register<T>(token: CapabilityToken<T>, capability: T): void {
    if (this.#capabilities.has(token.id)) {
      throw new Error(`Capability is registered more than once: ${token.id}`);
    }
    this.#capabilities.set(token.id, capability);
  }

  get<T>(token: CapabilityToken<T>): T | null {
    return (this.#capabilities.get(token.id) as T | undefined) ?? null;
  }

  has<T>(token: CapabilityToken<T>): boolean {
    return this.#capabilities.has(token.id);
  }
}
