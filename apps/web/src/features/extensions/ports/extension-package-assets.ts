export interface ValidatedExtensionPackageFile {
  path: string;
  data: Blob;
  sha256: string;
}

export interface ValidatedExtensionPackageAsset {
  extensionId: string;
  packageHash: string;
  files: readonly ValidatedExtensionPackageFile[];
  installedAt: string;
}

/**
 * Bridge owned by the Assets integration. Extensions never access ModuleBlobStore directly and do
 * not add an IndexedDB store/version. A central composition root may inject a durable implementation.
 */
export interface ExtensionPackageAssets {
  savePackage(asset: ValidatedExtensionPackageAsset): Promise<void>;
  removePackage(extensionId: string): Promise<void>;
  resolveAssetUrl(extensionId: string, path: string): Promise<string | null>;
}

export class MissingExtensionPackageAssets implements ExtensionPackageAssets {
  async savePackage(): Promise<void> {
    throw new Error(
      'Local extension package storage is unavailable until an Assets port is injected.',
    );
  }

  async removePackage(): Promise<void> {
    // There cannot be a durable package when this sentinel is in use.
  }

  async resolveAssetUrl(): Promise<string | null> {
    return null;
  }
}

/** Test/dev adapter only. Production persistence should be supplied by the Assets feature. */
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
    return file ? URL.createObjectURL(file.data) : null;
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
