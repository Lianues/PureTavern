export interface ValidatedExtensionPackageFile {
  path: string;
  data: Blob;
  sha256: string;
}

export interface ValidatedExtensionPackageAsset {
  extensionId: string;
  legacyName: string;
  packageHash: string;
  files: readonly ValidatedExtensionPackageFile[];
  installedAt: string;
}

/**
 * M13-owned persistence bridge. Extension files are exposed at
 * /scripts/extensions/<legacyName>/<relative path> so the unchanged upstream loader can import them.
 */
export interface ExtensionPackageAssets {
  savePackage(asset: ValidatedExtensionPackageAsset): Promise<void>;
  removePackage(extensionId: string): Promise<void>;
  resolveAssetUrl(extensionId: string, path: string): Promise<string | null>;
}

export class MissingExtensionPackageAssets implements ExtensionPackageAssets {
  async savePackage(): Promise<void> {
    throw new Error(
      'Extension package storage is unavailable until the M13 Assets port is injected.',
    );
  }

  async removePackage(): Promise<void> {
    // No package can exist while this sentinel is active.
  }

  async resolveAssetUrl(): Promise<string | null> {
    return null;
  }
}

export class MemoryExtensionPackageAssets implements ExtensionPackageAssets {
  readonly #packages = new Map<string, ValidatedExtensionPackageAsset>();

  async savePackage(asset: ValidatedExtensionPackageAsset): Promise<void> {
    this.#packages.set(asset.extensionId, clonePackage(asset));
  }

  async removePackage(extensionId: string): Promise<void> {
    this.#packages.delete(extensionId);
  }

  async resolveAssetUrl(extensionId: string, path: string): Promise<string | null> {
    const asset = this.#packages.get(extensionId);
    const file = asset?.files.find((candidate) => candidate.path === path);
    return file ? `/scripts/extensions/${asset!.legacyName}/${path}` : null;
  }

  getPackage(extensionId: string): ValidatedExtensionPackageAsset | null {
    const asset = this.#packages.get(extensionId);
    return asset ? clonePackage(asset) : null;
  }
}

function clonePackage(asset: ValidatedExtensionPackageAsset): ValidatedExtensionPackageAsset {
  return {
    ...asset,
    files: asset.files.map((file) => ({ ...file, data: file.data.slice() })),
  };
}
