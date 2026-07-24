import {
  assertSecretId,
  assertSecretKey,
  assertSecretLabel,
  assertSecretValue,
  createEmptySecretDocument,
  LEGACY_SECRET_KEYS,
  maskSecretValue,
  type LegacySecretStateMap,
  type SecretDocument,
  type SecretValue,
} from '../domain/secret';
import type { CredentialResolver } from '../ports/credential-resolver';
import type { SecretStore } from '../ports/secret-store';

export interface SecretServiceOptions {
  createId?: () => string;
}

export class SecretService implements CredentialResolver {
  readonly #store: SecretStore;
  readonly #createId: () => string;
  #serial: Promise<void> = Promise.resolve();

  constructor(store: SecretStore, options: SecretServiceOptions = {}) {
    this.#store = store;
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  async writeSecret(key: string, value: string, label = 'Unlabeled'): Promise<string> {
    assertSecretKey(key);
    assertSecretValue(value);
    assertSecretLabel(label);

    return this.#mutate(async (document) => {
      const values = document.secrets[key] ?? [];
      for (const secret of values) secret.active = false;
      const id = this.#uniqueId(document);
      values.push({ id, value, label, active: true });
      document.secrets[key] = values;
      return id;
    });
  }

  async deleteSecret(key: string, id?: string): Promise<boolean> {
    assertSecretKey(key);
    if (id !== undefined) assertSecretId(id);

    return this.#mutate(async (document) => {
      const values = document.secrets[key];
      if (!values) return false;
      const index = values.findIndex((secret) =>
        id === undefined ? secret.active : secret.id === id,
      );
      if (index < 0) return false;
      values.splice(index, 1);
      if (values.length === 0) {
        delete document.secrets[key];
      } else if (!values.some((secret) => secret.active)) {
        values[0]!.active = true;
      }
      return true;
    });
  }

  async rotateSecret(key: string, id: string): Promise<boolean> {
    assertSecretKey(key);
    assertSecretId(id);

    return this.#mutate(async (document) => {
      const values = document.secrets[key];
      const target = values?.find((secret) => secret.id === id);
      if (!values || !target) return false;
      for (const secret of values) secret.active = secret.id === id;
      return true;
    });
  }

  async renameSecret(key: string, id: string, label: string): Promise<boolean> {
    assertSecretKey(key);
    assertSecretId(id);
    assertSecretLabel(label);

    return this.#mutate(async (document) => {
      const target = document.secrets[key]?.find((secret) => secret.id === id);
      if (!target) return false;
      target.label = label;
      return true;
    });
  }

  async resolveCredential(key: string, id?: string): Promise<string | null> {
    assertSecretKey(key);
    if (id !== undefined) assertSecretId(id);
    const document = await this.#readDocument();
    const value = this.#find(document, key, id);
    return value?.value ?? null;
  }

  async hasCredential(key: string): Promise<boolean> {
    return (await this.resolveCredential(key)) !== null;
  }

  async getLegacyState(): Promise<LegacySecretStateMap> {
    const document = await this.#readDocument();
    const state: LegacySecretStateMap = {};
    for (const key of LEGACY_SECRET_KEYS) state[key] = null;
    for (const [key, values] of Object.entries(document.secrets)) {
      state[key] = values.map((secret) => ({
        id: secret.id,
        value: maskSecretValue(secret.value),
        label: secret.label,
        active: secret.active,
      }));
    }
    return state;
  }

  async viewActiveSecrets(): Promise<Record<string, string>> {
    const document = await this.#readDocument();
    const result: Record<string, string> = {};
    for (const [key, values] of Object.entries(document.secrets)) {
      const active = values.find((secret) => secret.active);
      if (active) result[key] = active.value;
    }
    return result;
  }

  async #readDocument(): Promise<SecretDocument> {
    await this.#serial;
    return (await this.#store.load()) ?? createEmptySecretDocument();
  }

  #find(document: SecretDocument, key: string, id?: string): SecretValue | undefined {
    return document.secrets[key]?.find((secret) =>
      id === undefined ? secret.active : secret.id === id,
    );
  }

  #uniqueId(document: SecretDocument): string {
    const existing = new Set(
      Object.values(document.secrets)
        .flat()
        .map((secret) => secret.id),
    );
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = this.#createId();
      assertSecretId(id);
      if (!existing.has(id)) return id;
    }
    throw new Error('Could not allocate a unique credential ID.');
  }

  #mutate<T>(operation: (document: SecretDocument) => Promise<T> | T): Promise<T> {
    const result = this.#serial.then(async () => {
      const document = (await this.#store.load()) ?? createEmptySecretDocument();
      const value = await operation(document);
      await this.#store.save(document);
      return value;
    });
    this.#serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
