import type {
  ExtensionSourceGateway,
  ExtensionSourceRef,
  ExtensionSourceSnapshot,
} from '../ports/extension-source-gateway';
import type { ExtensionPackageFile } from '../application/package-validator';

export function makeLegacyPackage(version = '1.0.0', marker = 'initial'): ExtensionPackageFile[] {
  const manifest = {
    display_name: 'Cocktail Test',
    loading_order: 0,
    requires: [],
    optional: [],
    dependencies: ['regex'],
    js: 'index.js',
    css: 'style.css',
    author: 'Limerence',
    version,
    future_manifest_field: { kept: true },
  };
  return [
    {
      path: 'manifest.json',
      data: new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
    },
    {
      path: 'index.js',
      data: new Blob([`globalThis.__cocktailMarker = ${JSON.stringify(marker)};`], {
        type: 'text/javascript',
      }),
    },
    {
      path: 'style.css',
      data: new Blob(['.cocktail-test { color: lime; }'], { type: 'text/css' }),
    },
  ];
}

export class FakeExtensionSourceGateway implements ExtensionSourceGateway {
  readonly snapshots = new Map<string, ExtensionSourceSnapshot>();
  refs: ExtensionSourceRef[] = [];

  constructor() {
    this.set('main', '1.0.0', 'initial');
    this.refs = [
      { current: true, commit: 'main-revision', name: 'main', label: 'Branch: main' },
      { current: false, commit: 'next-revision', name: 'next', label: 'Branch: next' },
    ];
  }

  set(ref: string, version: string, marker: string): void {
    this.snapshots.set(ref, {
      provider: 'cors-zip',
      repositoryUrl: 'https://example.test/cocktail.zip',
      requestedRef: ref === 'main' ? '' : ref,
      resolvedRef: ref,
      revision: `${ref}-${version}-${marker}`,
      folderName: 'cocktail',
      files: makeLegacyPackage(version, marker),
    });
  }

  async fetchSnapshot(_url: string, ref = ''): Promise<ExtensionSourceSnapshot> {
    const key = ref || 'main';
    const snapshot = this.snapshots.get(key);
    if (!snapshot) throw new Error(`Unknown fake ref: ${key}`);
    return structuredCloneSnapshot(snapshot);
  }

  async listRefs(): Promise<ExtensionSourceRef[]> {
    return structuredClone(this.refs);
  }
}

function structuredCloneSnapshot(snapshot: ExtensionSourceSnapshot): ExtensionSourceSnapshot {
  return {
    ...snapshot,
    files: snapshot.files.map((file) => ({ path: file.path, data: file.data.slice() })),
  };
}
