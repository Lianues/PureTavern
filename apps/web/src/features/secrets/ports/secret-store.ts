import type { SecretDocument } from '../domain/secret';

export interface SecretStore {
  load(): Promise<SecretDocument | null>;
  save(document: SecretDocument): Promise<void>;
}
