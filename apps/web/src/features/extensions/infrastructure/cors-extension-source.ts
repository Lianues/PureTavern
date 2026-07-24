import {
  DEFAULT_EXTENSION_PACKAGE_LIMITS,
  extractExtensionZip,
  sha256Hex,
  type ExtensionPackageFile,
  type ExtensionPackageLimits,
} from '../application/package-validator';
import type { RemoteExtensionSource } from '../domain/extension';
import type {
  ExtensionSourceGateway,
  ExtensionSourceRef,
  ExtensionSourceSnapshot,
} from '../ports/extension-source-gateway';

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
    limits: ExtensionPackageLimits = DEFAULT_EXTENSION_PACKAGE_LIMITS,
    signal?: AbortSignal,
  ): Promise<ExtensionSourceSnapshot> {
    const location = parseSourceLocation(rawUrl);
    const cleanRef = normalizeRef(requestedRef);
    if (location.provider === 'github') {
      return this.#fetchGitHubSnapshot(location, cleanRef, limits, signal);
    }
    if (location.provider === 'gitlab') {
      return this.#fetchGitLabSnapshot(location, cleanRef, limits, signal);
    }
    return this.#fetchDirectZipSnapshot(location, cleanRef, limits, signal);
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
    limits: ExtensionPackageLimits,
    signal?: AbortSignal,
  ): Promise<ExtensionSourceSnapshot> {
    const resolvedRef = requestedRef || 'HEAD';
    const packagePath = jsDelivrPackagePath(location.owner, location.repository, resolvedRef);
    const listingUrl = `https://data.jsdelivr.com/v1/package/gh/${packagePath}/flat`;
    const listing = await this.#fetchJson<unknown>(listingUrl, signal);
    const entries = parseJsDelivrListing(listing, limits);
    const files = await mapWithConcurrency(entries, 6, async (entry) => {
      const url = `https://cdn.jsdelivr.net/gh/${packagePath}${encodeFilePath(entry.path)}`;
      const response = await this.#request(url, signal);
      return {
        path: entry.path,
        data: await readBoundedBlob(response, limits.maxFileBytes),
      } satisfies ExtensionPackageFile;
    });
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

  async #fetchGitLabSnapshot(
    location: GitLabLocation,
    requestedRef: string,
    limits: ExtensionPackageLimits,
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
    const archive = await readBoundedBlob(response, limits.maxArchiveBytes);
    return {
      provider: 'gitlab',
      repositoryUrl: location.repositoryUrl,
      requestedRef,
      resolvedRef,
      revision,
      folderName: location.folderName,
      files: await extractExtensionZip(archive, limits),
    };
  }

  async #fetchDirectZipSnapshot(
    location: DirectZipLocation,
    requestedRef: string,
    limits: ExtensionPackageLimits,
    signal?: AbortSignal,
  ): Promise<ExtensionSourceSnapshot> {
    const response = await this.#request(location.archiveUrl, signal);
    const archive = await readBoundedBlob(response, limits.maxArchiveBytes);
    return {
      provider: 'cors-zip',
      repositoryUrl: location.repositoryUrl,
      requestedRef,
      resolvedRef: requestedRef || 'archive',
      revision: await sha256Hex(archive),
      folderName: location.folderName,
      files: await extractExtensionZip(archive, limits),
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
        `Extension source request failed: HTTP ${response.status} ${response.statusText} (${url})`,
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

function parseJsDelivrListing(
  value: unknown,
  limits: ExtensionPackageLimits,
): { path: string; hash: string; size: number }[] {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    throw new ExtensionSourceError('listing', 'jsDelivr did not return a package file listing.');
  }
  if (value.files.length === 0 || value.files.length > limits.maxFiles) {
    throw new ExtensionSourceError('file-count', 'Remote extension file count is outside limits.');
  }
  let total = 0;
  const seen = new Set<string>();
  return value.files.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      typeof entry.hash !== 'string' ||
      typeof entry.size !== 'number' ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      throw new ExtensionSourceError('listing', 'Remote extension listing contains invalid files.');
    }
    const path = entry.name.replace(/^\/+/, '');
    if (!path || path.length > limits.maxPathLength) {
      throw new ExtensionSourceError('listing', `Remote extension path is invalid: ${entry.name}`);
    }
    const key = path.normalize('NFKC').toLocaleLowerCase('en-US');
    if (seen.has(key)) {
      throw new ExtensionSourceError('listing', `Remote extension has duplicate paths: ${path}`);
    }
    seen.add(key);
    total += entry.size;
    if (entry.size > limits.maxFileBytes || total > limits.maxTotalBytes) {
      throw new ExtensionSourceError(
        'package-size',
        'Remote extension exceeds package size limits.',
      );
    }
    return { path, hash: entry.hash, size: entry.size };
  });
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

async function readBoundedBlob(response: Response, limit: number): Promise<Blob> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    throw new ExtensionSourceError('response-size', `Remote response exceeds ${limit} bytes.`);
  }
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > limit) {
      throw new ExtensionSourceError('response-size', `Remote response exceeds ${limit} bytes.`);
    }
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ExtensionSourceError('response-size', `Remote response exceeds ${limit} bytes.`);
    }
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    chunks.push(copy.buffer);
  }
  return new Blob(chunks, {
    type: response.headers.get('content-type') ?? 'application/octet-stream',
  });
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

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
