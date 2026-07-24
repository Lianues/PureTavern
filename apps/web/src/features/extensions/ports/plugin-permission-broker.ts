import type { ExtensionCapability } from '../domain/extension';

export interface PluginPermissionGrant {
  extensionId: string;
  capability: ExtensionCapability;
  grantedAt: string;
}

/** Missing records are denial. There are no implicit grants, including for secrets, DOM, or network. */
export interface PluginPermissionBroker {
  check(extensionId: string, capability: ExtensionCapability): Promise<boolean>;
  list(extensionId: string): Promise<PluginPermissionGrant[]>;
  grant(extensionId: string, capability: ExtensionCapability): Promise<void>;
  revoke(extensionId: string, capability: ExtensionCapability): Promise<void>;
  revokeAll(extensionId: string): Promise<void>;
}
