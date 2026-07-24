export interface AssetOwnerResolver {
  resolveOwner(ownerAlias: string): Promise<string | null> | string | null;
}
