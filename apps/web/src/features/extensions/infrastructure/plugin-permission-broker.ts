import {
  assertExtensionId,
  isExtensionCapability,
  type ExtensionCapability,
} from '../domain/extension';
import type { ExtensionStorageDiagnostics } from '../ports/extension-registry';
import type {
  PluginPermissionBroker,
  PluginPermissionGrant,
} from '../ports/plugin-permission-broker';
import type { ExtensionRecordStore } from './record-store';

const PERMISSIONS_COLLECTION = 'permissions';

export class RecordPluginPermissionBroker implements PluginPermissionBroker {
  readonly #records: ExtensionRecordStore;

  constructor(records: ExtensionRecordStore) {
    this.#records = records;
  }

  async check(extensionId: string, capability: ExtensionCapability): Promise<boolean> {
    return Boolean(
      await this.#records.get(PERMISSIONS_COLLECTION, permissionKey(extensionId, capability)),
    );
  }

  async list(extensionId: string): Promise<PluginPermissionGrant[]> {
    assertExtensionId(extensionId);
    return (await this.#records.list<PluginPermissionGrant>(PERMISSIONS_COLLECTION))
      .filter((record) => record.value.extensionId === extensionId)
      .map((record) => structuredClone(record.value))
      .sort((left, right) => left.capability.localeCompare(right.capability));
  }

  async grant(extensionId: string, capability: ExtensionCapability): Promise<void> {
    const grant: PluginPermissionGrant = {
      extensionId,
      capability,
      grantedAt: new Date().toISOString(),
    };
    await this.#records.put(PERMISSIONS_COLLECTION, permissionKey(extensionId, capability), grant);
  }

  async revoke(extensionId: string, capability: ExtensionCapability): Promise<void> {
    await this.#records.delete(PERMISSIONS_COLLECTION, permissionKey(extensionId, capability));
  }

  async revokeAll(extensionId: string): Promise<void> {
    const grants = await this.list(extensionId);
    await Promise.all(grants.map((grant) => this.revoke(extensionId, grant.capability)));
  }
}

export class MemoryPluginPermissionBroker implements PluginPermissionBroker {
  readonly #grants = new Map<string, PluginPermissionGrant>();

  async check(extensionId: string, capability: ExtensionCapability): Promise<boolean> {
    return this.#grants.has(permissionKey(extensionId, capability));
  }

  async list(extensionId: string): Promise<PluginPermissionGrant[]> {
    assertExtensionId(extensionId);
    return [...this.#grants.values()]
      .filter((grant) => grant.extensionId === extensionId)
      .map((grant) => structuredClone(grant))
      .sort((left, right) => left.capability.localeCompare(right.capability));
  }

  async grant(extensionId: string, capability: ExtensionCapability): Promise<void> {
    this.#grants.set(permissionKey(extensionId, capability), {
      extensionId,
      capability,
      grantedAt: new Date().toISOString(),
    });
  }

  async revoke(extensionId: string, capability: ExtensionCapability): Promise<void> {
    this.#grants.delete(permissionKey(extensionId, capability));
  }

  async revokeAll(extensionId: string): Promise<void> {
    assertExtensionId(extensionId);
    for (const [key, grant] of this.#grants) {
      if (grant.extensionId === extensionId) this.#grants.delete(key);
    }
  }

  replace(extensionId: string, grants: readonly PluginPermissionGrant[]): void {
    for (const [key, grant] of this.#grants) {
      if (grant.extensionId === extensionId) this.#grants.delete(key);
    }
    for (const grant of grants)
      this.#grants.set(permissionKey(extensionId, grant.capability), structuredClone(grant));
  }
}

export class ResilientPluginPermissionBroker implements PluginPermissionBroker {
  readonly diagnostics: ExtensionStorageDiagnostics = {
    status: 'ready',
    backend: 'records',
    message: null,
    lastSavedAt: null,
  };

  readonly #primary: PluginPermissionBroker;
  readonly #fallback: MemoryPluginPermissionBroker;

  constructor(
    primary: PluginPermissionBroker,
    fallback: MemoryPluginPermissionBroker = new MemoryPluginPermissionBroker(),
  ) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  async check(extensionId: string, capability: ExtensionCapability): Promise<boolean> {
    if (this.diagnostics.status === 'degraded')
      return this.#fallback.check(extensionId, capability);
    try {
      const allowed = await this.#primary.check(extensionId, capability);
      if (allowed) await this.#fallback.grant(extensionId, capability);
      else await this.#fallback.revoke(extensionId, capability);
      return allowed;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.check(extensionId, capability);
    }
  }

  async list(extensionId: string): Promise<PluginPermissionGrant[]> {
    if (this.diagnostics.status === 'degraded') return this.#fallback.list(extensionId);
    try {
      const grants = await this.#primary.list(extensionId);
      this.#fallback.replace(extensionId, grants);
      return grants;
    } catch (error) {
      this.#degrade(error);
      return this.#fallback.list(extensionId);
    }
  }

  async grant(extensionId: string, capability: ExtensionCapability): Promise<void> {
    await this.#fallback.grant(extensionId, capability);
    await this.#write(() => this.#primary.grant(extensionId, capability));
  }

  async revoke(extensionId: string, capability: ExtensionCapability): Promise<void> {
    await this.#fallback.revoke(extensionId, capability);
    await this.#write(() => this.#primary.revoke(extensionId, capability));
  }

  async revokeAll(extensionId: string): Promise<void> {
    await this.#fallback.revokeAll(extensionId);
    await this.#write(() => this.#primary.revokeAll(extensionId));
  }

  async #write(operation: () => Promise<void>): Promise<void> {
    if (this.diagnostics.status !== 'degraded') {
      try {
        await operation();
      } catch (error) {
        this.#degrade(error);
      }
    }
    this.diagnostics.lastSavedAt = new Date().toISOString();
  }

  #degrade(error: unknown): void {
    this.diagnostics.status = 'degraded';
    this.diagnostics.backend = 'memory';
    this.diagnostics.message = error instanceof Error ? error.message : String(error);
  }
}

function permissionKey(extensionId: string, capability: ExtensionCapability): string {
  assertExtensionId(extensionId);
  if (!isExtensionCapability(capability))
    throw new TypeError(`Unknown extension capability: ${capability}`);
  return `${extensionId}:${capability}`;
}
