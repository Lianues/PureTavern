export interface CredentialResolver {
  resolveCredential(key: string, id?: string): Promise<string | null>;
  hasCredential(key: string): Promise<boolean>;
}
