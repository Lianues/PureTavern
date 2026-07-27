import { extractExtensionZip, sha256Hex } from '../application/package-validator';
import type { RemoteExtensionSource } from '../domain/extension';
import type {
  ExtensionSourceGateway,
  ExtensionSourceRef,
  ExtensionSourceSnapshot,
} from '../ports/extension-source-gateway';

const MAX_EXTENSION_PATH_LENGTH = 300;

interface GitHubLocation {
  provider: 'github';
  owner: string;
  repository: string;
  repositoryUrl: string;
  folderName: string;
}

interface GitLabLocation {
  provider: 'gitlab';
  projectPath: string;
  repositoryUrl: string;
  folderName: string;
}

interface RemoteFileEntry {
  path: string;
  hash: string;
  size: number;
}

type RemoteLocation = GitHubLocation | GitLabLocation | DirectZipLocation;

interface DirectZipLocation {
  provider: 'cors-zip';
  repositoryUrl: string;
  archiveUrl: string;
  folderName: string;
}

export class ExtensionSourceError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExtensionSourceError';
    this.code = code;
  }
}

export class CorsExtensionSourceGateway implements ExtensionSourceGateway {
  readonly #fetch: typeof fetch;

  constructor(nativeFetch: typeof fetch) {
    this.#fetch = nativeFetch;
  }

  async fetchSnapshot(
    rawUrl: string,
    requestedRef = '',
    signal?: AbortSignal,
  ): Promise<ExtensionSourceSnapshot> {
    const location = parseSourceLocation(rawUrl);
    const cleanRef = normalizeRef(requestedRef);
    if (location.provider === 'github') {
      return this.#fetchGitHubSnapshot(location, cleanRef, signal);
    }
    if (location.provider === 'gitlab') {
      return this.#fetchGitLabSnapshot(location, cleanRef, signal);
    }
    return this.#fetchDirectZipSnapshot(location, cleanRef, signal);
  }

  async listRefs(
    source: RemoteExtensionSource,
    signal?: AbortSignal,
  ): Promise<ExtensionSourceRef[]> {
    const location = parseSourceLocation(source.repositoryUrl);
    if (location.provider === 'github') {
      try {
        const [branches, tags] = await Promise.all([
          this.#fetchJson<unknown[]>(
            `https://api.github.com/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repository)}/branches?per_page=100`,
            signal,
          ),
          this.#fetchJson<unknown[]>(
            `https://api.github.com/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repository)}/tags?per_page=100`,
            signal,
          ),
        ]);
        return normalizeRefs(
          [
            ...branches.map((entry) => githubRef(entry, 'Branch')),
            ...tags.map((entry) => githubRef(entry, 'Tag')),
          ].filter((entry): entry is ExtensionSourceRef => entry !== null),
          source.resolvedRef,
          source.revision,
        );
      } catch {
        return currentOnlyRef(source);
      }
    }
    if (location.provider === 'gitlab') {
      try {
        const project = encodeURIComponent(location.projectPath);
        const [branches, tags] = await Promise.all([
          this.#fetchJson<unknown[]>(
            `https://gitlab.com/api/v4/projects/${project}/repository/branches?per_page=100`,
            signal,
          ),
          this.#fetchJson<unknown[]>(
            `https://gitlab.com/api/v4/projects/${project}/repository/tags?per_page=100`,
            signal,
          ),
        ]);
        return normalizeRefs(
          [
            ...branches.map((entry) => gitlabRef(entry, 'Branch')),
            ...tags.map((entry) => gitlabRef(entry, 'Tag')),
          ].filter((entry): entry is ExtensionSourceRef => entry !== null),
          source.resolvedRef,
          source.revision,
        );
      } catch {
        return currentOnlyRef(source);
      }
    }
    return currentOnlyRef(source);
  }

  async #fetchGitHubSnapshot(
    location: GitHubLocation,
    requestedRef: string,
    signal?: AbortSignal,
  ): Promise<ExtensionSourceSnapshot> {
    const resolvedRef = requestedRef || 'HEAD';
    const packagePath = jsDelivrPackagePath(location.owner, location.repository, resolvedRef);
    const entries = await this.#fetchGitHubEntries(location, resolvedRef, signal);
    const files = await mapWithConcurrency(entries, 6, async (entry) => ({
      path: entry.path,
      data: await this.#fetchGitHubFile(
        location,
        resolvedRef,
        packagePath,
        entry.path,
        signal,
      ),
    }));
    const revision = await sha256Hex(
      new TextEncoder().encode(
        entries
          .map((entry) => `${entry.path}\u0000${entry.hash}`)
          .sort()
          .join('\n'),
      ),
    );
    return {
      provider: 'github',
      repositoryUrl: location.repositoryUrl,
      requestedRef,
      resolvedRef,
      revision,
      folderName: location.folderName,
      files,
    };
  }

  async #fetchGitHubEntries(
    location: GitHubLocation,
    resolvedRef: string,
    signal?: AbortSignal,
  ): Promise<RemoteFileEntry[]> {
    const packagePath = jsDelivrPackagePath(location.owner, location.repository, resolvedRef);
    try {
      const listing = await this.#fetchJson<unknown>(
        `https://data.jsdelivr.com/v1/package/gh/${packagePath}/flat`,
        signal,
      );
      return parseJsDelivrListing(listing);
    } catch (error) {
      if (!isRecoverableCatalogError(error)) throw error;
    }

    const tree = await this.#fetchJson<unknown>(
      `https://api.github.com/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repository)}/git/trees/${encodeURIComponent(resolvedRef)}?recursive=1`,
      signal,
    );
    return parseGitHubTree(tree);
  }

  async #fetchGitHubFile(
    location: GitHubLocation,
    resolvedRef: string,
    packagePath: string,
    filePath: string,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const jsDelivrUrl = `https://cdn.jsdelivr.net/gh/${packagePath}${encodeFilePath(filePath)}`;
    try {
      const response = await this.#request(jsDelivrUrl, signal);
      return await response.blob();
    } catch (error) {
      if (!isRecoverableFileError(error)) throw error;
    }

    const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repository)}/${encodeRefPath(resolvedRef)}${encodeFilePath(filePath)}`;
    const response = await this.#request(rawUrl, signal);
    return response.blob();
  }

  async #fetchGitLabSnapshot(
    location: GitLabLocation,
    requestedRef: string,
    signal?: AbortSignal,
  ): Promise<ExtensionSourceSnapshot> {
    const project = encodeURIComponent(location.projectPath);
    let resolvedRef = requestedRef;
    if (!resolvedRef) {
      const metadata = await this.#fetchJson<unknown>(
        `https://gitlab.com/api/v4/projects/${project}`,
        signal,
      );
      if (!isRecord(metadata) || typeof metadata.default_branch !== 'string') {
        throw new ExtensionSourceError('default-ref', 'GitLab did not return a default branch.');
      }
      resolvedRef = normalizeRef(metadata.default_branch);
    }
    const branch = await this.#fetchJson<unknown>(
      `https://gitlab.com/api/v4/projects/${project}/repository/commits/${encodeURIComponent(resolvedRef)}`,
      signal,
    );
    const revision = isRecord(branch) && typeof branch.id === 'string' ? branch.id : resolvedRef;
    const response = await this.#request(
      `https://gitlab.com/api/v4/projects/${project}/repository/archive.zip?sha=${encodeURIComponent(resolvedRef)}`,
      signal,
    );
    const archive = await response.blob();
    return {
      provider: 'gitlab',
      repositoryUrl: location.repositoryUrl,
      requestedRef,
      resolvedRef,
      revision,
      folderName: location.folderName,
      files: await extractExtensionZip(archive),
    };
  }

  async #fetchDirectZipSnapshot(
    location: DirectZipLocation,
    requestedRef: string,
    signal?: AbortSignal,
  ): Promise<ExtensionSourceSnapshot> {
    const response = await this.#request(location.archiveUrl, signal);
    const archive = await response.blob();
    return {
      provider: 'cors-zip',
      repositoryUrl: location.repositoryUrl,
      requestedRef,
      resolvedRef: requestedRef || 'archive',
      revision: await sha256Hex(archive),
      folderName: location.folderName,
      files: await extractExtensionZip(archive),
    };
  }

  async #fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const response = await this.#request(url, signal);
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new ExtensionSourceError(
        'invalid-json',
        `Remote source returned invalid JSON: ${url}`,
        {
          cause: error,
        },
      );
    }
  }

  async #request(url: string, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        cache: 'no-store',
        headers: { Accept: 'application/json, application/zip, application/octet-stream;q=0.9' },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new ExtensionSourceError(
        'network',
        `Unable to fetch extension source. The remote host must allow browser CORS: ${url}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new ExtensionSourceError(
        response.status === 403 || response.status === 429 ? 'rate-limit' : 'http',
        `Extension source request failed: HTTP ${response.status} ${response.statusText} (${url})${githubRateLimitHint(url, response)}`,
      );
    }
    return response;
  }
}

export function parseSourceLocation(rawUrl: string): RemoteLocation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new ExtensionSourceError('invalid-url', 'Extension URL must be an absolute URL.', {
      cause: error,
    });
  }
  if (url.username || url.password || !isAllowedProtocol(url)) {
    throw new ExtensionSourceError(
      'invalid-url',
      'Extension URL must use HTTPS, or HTTP on localhost for development, without embedded credentials.',
    );
  }
  url.hash = '';
  if (url.hostname === 'github.com') {
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 2) {
      throw new ExtensionSourceError('invalid-url', 'GitHub URL must identify owner/repository.');
    }
    const owner = segments[0]!;
    const repository = segments[1]!.replace(/\.git$/iu, '');
    return {
      provider: 'github',
      owner,
      repository,
      repositoryUrl: `https://github.com/${owner}/${repository}`,
      folderName: safeFolderName(repository),
    };
  }
  if (url.hostname === 'gitlab.com') {
    const path = (url.pathname.split('/-/')[0] ?? '')
      .replace(/^\/+|\/+$/gu, '')
      .replace(/\.git$/iu, '');
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2) {
      throw new ExtensionSourceError('invalid-url', 'GitLab URL must identify namespace/project.');
    }
    return {
      provider: 'gitlab',
      projectPath: path,
      repositoryUrl: `https://gitlab.com/${path}`,
      folderName: safeFolderName(segments.at(-1) ?? 'extension'),
    };
  }
  if (!/\.zip$/iu.test(url.pathname)) {
    throw new ExtensionSourceError(
      'unsupported-host',
      'Unsupported Git host. Use a GitHub/GitLab repository URL or a direct CORS-enabled .zip URL.',
    );
  }
  return {
    provider: 'cors-zip',
    repositoryUrl: url.href,
    archiveUrl: url.href,
    folderName: safeFolderName(
      (url.pathname.split('/').at(-1) ?? 'extension').replace(/\.zip$/iu, ''),
    ),
  };
}

function parseJsDelivrListing(value: unknown): RemoteFileEntry[] {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    throw new ExtensionSourceError('listing', 'jsDelivr did not return a package file listing.');
  }
  const entries = value.files.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      typeof entry.hash !== 'string' ||
      typeof entry.size !== 'number'
    ) {
      throw new ExtensionSourceError('listing', 'Remote extension listing contains invalid files.');
    }
    return { path: entry.name, hash: entry.hash, size: entry.size };
  });
  return validateRemoteEntries(entries);
}

function parseGitHubTree(value: unknown): RemoteFileEntry[] {
  if (!isRecord(value) || !Array.isArray(value.tree)) {
    throw new ExtensionSourceError('listing', 'GitHub did not return a repository tree.');
  }
  if (value.truncated !== false) {
    throw new ExtensionSourceError(
      'listing-truncated',
      'GitHub returned a truncated repository tree; extension installation was stopped.',
    );
  }
  const entries: RemoteFileEntry[] = [];
  for (const entry of value.tree) {
    if (!isRecord(entry) || entry.type !== 'blob') continue;
    if (
      typeof entry.path !== 'string' ||
      typeof entry.sha !== 'string' ||
      typeof entry.size !== 'number' ||
      (entry.mode !== '100644' && entry.mode !== '100755')
    ) {
      throw new ExtensionSourceError('listing', 'GitHub repository tree contains invalid files.');
    }
    entries.push({ path: entry.path, hash: entry.sha, size: entry.size });
  }
  return validateRemoteEntries(entries);
}

function validateRemoteEntries(input: readonly RemoteFileEntry[]): RemoteFileEntry[] {
  const entries = input
    .map((entry) => ({
      ...entry,
      path: normalizeRemotePath(entry.path, MAX_EXTENSION_PATH_LENGTH),
    }))
    .filter((entry) => !isIgnoredRemoteFile(entry.path));
  if (entries.length === 0) {
    throw new ExtensionSourceError('file-count', 'Remote extension does not contain any files.');
  }


  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.hash || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new ExtensionSourceError('listing', 'Remote extension file metadata is invalid.');
    }
    const key = entry.path.normalize('NFKC').toLocaleLowerCase('en-US');
    if (seen.has(key)) {
      throw new ExtensionSourceError(
        'listing',
        `Remote extension has duplicate paths: ${entry.path}`,
      );
    }
    seen.add(key);
  }
  return entries;
}

function normalizeRemotePath(value: string, maxPathLength: number): string {
  const path = value.replace(/^\/+/, '');
  const segments = path.split('/');
  if (
    !path ||
    path.length > maxPathLength ||
    path.includes('\\') ||
    hasControlCharacters(path) ||
    /^[a-zA-Z]:/u.test(path) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new ExtensionSourceError('listing', `Remote extension path is invalid: ${value}`);
  }
  return path;
}

function isIgnoredRemoteFile(path: string): boolean {
  const normalized = path.toLocaleLowerCase('en-US');
  return (
    normalized.endsWith('.map') ||
    normalized === '.ds_store' ||
    normalized.endsWith('/.ds_store') ||
    normalized.startsWith('__macosx/')
  );
}

function githubRef(value: unknown, label: string): ExtensionSourceRef | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  const commit =
    isRecord(value.commit) && typeof value.commit.sha === 'string' ? value.commit.sha : '';
  return { current: false, commit, name: value.name, label: `${label}: ${value.name}` };
}

function gitlabRef(value: unknown, label: string): ExtensionSourceRef | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  const commit =
    isRecord(value.commit) && typeof value.commit.id === 'string' ? value.commit.id : '';
  return { current: false, commit, name: value.name, label: `${label}: ${value.name}` };
}

function normalizeRefs(
  refs: readonly ExtensionSourceRef[],
  currentName: string,
  currentRevision: string,
): ExtensionSourceRef[] {
  const unique = new Map<string, ExtensionSourceRef>();
  for (const ref of refs) unique.set(ref.name, { ...ref, current: ref.name === currentName });
  if (!unique.has(currentName)) {
    unique.set(currentName, {
      current: true,
      commit: currentRevision,
      name: currentName,
      label: `Current: ${currentName}`,
    });
  }
  return [...unique.values()].sort(
    (left, right) =>
      Number(right.current) - Number(left.current) || left.name.localeCompare(right.name),
  );
}

function currentOnlyRef(source: RemoteExtensionSource): ExtensionSourceRef[] {
  return [
    {
      current: true,
      commit: source.revision,
      name: source.resolvedRef,
      label: `Current: ${source.resolvedRef}`,
    },
  ];
}

function normalizeRef(value: string): string {
  const ref = value.trim();
  if (ref.length > 200 || hasControlCharacters(ref) || ref.startsWith('-')) {
    throw new ExtensionSourceError('invalid-ref', 'Extension branch/tag is invalid.');
  }
  return ref;
}

function safeFolderName(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, 100);
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new ExtensionSourceError(
      'folder-name',
      'Repository name cannot form a safe extension folder.',
    );
  }
  return normalized;
}

function isAllowedProtocol(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  );
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(values[index]!);
      }
    }),
  );
  return results;
}

function jsDelivrPackagePath(owner: string, repository: string, ref: string): string {
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repository)}@${encodeURIComponent(ref)}`;
}

function encodeFilePath(value: string): string {
  return `/${value.split('/').map(encodeURIComponent).join('/')}`;
}

function encodeRefPath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function isRecoverableCatalogError(error: unknown): boolean {
  return (
    error instanceof ExtensionSourceError &&
    ['network', 'rate-limit', 'http', 'invalid-json', 'listing'].includes(error.code)
  );
}

function isRecoverableFileError(error: unknown): boolean {
  return (
    error instanceof ExtensionSourceError && ['network', 'rate-limit', 'http'].includes(error.code)
  );
}

function githubRateLimitHint(url: string, response: Response): string {
  if (!url.startsWith('https://api.github.com/')) return '';
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = Number(response.headers.get('x-ratelimit-reset') ?? '');
  const resetDate = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null;
  const resetAt = resetDate && Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : '';
  if (remaining === null && !resetAt) return '';
  return ` GitHub REST remaining=${remaining ?? 'unknown'}${resetAt ? `, resets=${resetAt}` : ''}.`;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
