/**
 * TauriTavern 的迁移包就是 SillyTavern 的 data 目录原样打包（见 TauriTavern 的
 * scripts/export-sillytavern-migration.*），所以下面这些目录名必须和 SillyTavern 的
 * USER_DIRECTORY_TEMPLATE 逐字一致——包括空格和大小写，改一个字对方就读不出数据。
 */
export const TAURI_TAVERN_DATA_ROOT = 'data';
export const TAURI_TAVERN_USER_HANDLE = 'default-user';
export const TAURI_TAVERN_USER_ROOT = `${TAURI_TAVERN_DATA_ROOT}/${TAURI_TAVERN_USER_HANDLE}`;
export const TAURI_TAVERN_THIRD_PARTY_ROOT = `${TAURI_TAVERN_DATA_ROOT}/extensions/third-party`;
/**
 * TauriTavern 在这里记下每个扩展的来源仓库（host / repo_path / reference / remote_url /
 * installed_commit）。有了它，迁移进来的扩展 id 才能和正常安装算出来的一致，更新检查也不会断。
 */
export const TAURI_TAVERN_EXTENSION_SOURCES_ROOT = `${TAURI_TAVERN_DATA_ROOT}/_tauritavern/extension-sources`;
/** 扩展包在 PureTavern 里以 library 资源存放，legacyPath 用的就是这个前缀。 */
export const EXTENSION_PACKAGE_PATH_PREFIX = '/scripts/extensions/third-party/';

export const TAURI_TAVERN_DIRECTORIES = Object.freeze({
  worlds: 'worlds',
  userAvatars: 'User Avatars',
  userImages: 'user/images',
  userFiles: 'user/files',
  comfyWorkflows: 'user/workflows',
  groups: 'groups',
  groupChats: 'group chats',
  chats: 'chats',
  characters: 'characters',
  backgrounds: 'backgrounds',
  novelAiSettings: 'NovelAI Settings',
  koboldAiSettings: 'KoboldAI Settings',
  openAiSettings: 'OpenAI Settings',
  textGenSettings: 'TextGen Settings',
  themes: 'themes',
  movingUi: 'movingUI',
  instruct: 'instruct',
  context: 'context',
  sysprompt: 'sysprompt',
  reasoning: 'reasoning',
  quickReplies: 'QuickReplies',
  assets: 'assets',
  backups: 'backups',
  thumbnails: 'thumbnails',
  vectors: 'vectors',
});

export const TAURI_TAVERN_SETTINGS_FILE = 'settings.json';
export const TAURI_TAVERN_SECRETS_FILE = 'secrets.json';
export const TAURI_TAVERN_STATS_FILE = 'stats.json';
/** SillyTavern 的图片索引：虚拟文件夹 + 每张图的尺寸/主色调等元数据。 */
export const TAURI_TAVERN_IMAGE_METADATA_FILE = 'image-metadata.json';

/**
 * 打包/解包时忽略的目录：全是 SillyTavern 可以随时重建的派生数据。
 * 把它们带上只会让迁移包大一倍，还会在导入端产生一堆无主文件。
 */
export const TAURI_TAVERN_DERIVED_DIRECTORIES: readonly string[] = Object.freeze([
  TAURI_TAVERN_DIRECTORIES.thumbnails,
  TAURI_TAVERN_DIRECTORIES.backups,
  TAURI_TAVERN_DIRECTORIES.vectors,
]);

export class TauriTavernFormatError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TauriTavernFormatError';
    this.code = code;
  }
}

export function failTauriTavern(code: string, message: string): never {
  throw new TauriTavernFormatError(code, message);
}

/** 拼出迁移包内的绝对路径，例如 `data/default-user/characters/Seraphina.png`。 */
export function userPath(...segments: readonly string[]): string {
  return [TAURI_TAVERN_USER_ROOT, ...segments].join('/');
}

/** 迁移包路径 -> `default-user` 下的相对路径；不属于该用户目录时返回 null。 */
export function readUserPath(path: string): string | null {
  const prefix = `${TAURI_TAVERN_USER_ROOT}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** 相对路径是否位于某个目录之下，返回目录内的剩余部分。 */
export function readDirectory(relativePath: string, directory: string): string | null {
  const prefix = `${directory}/`;
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : null;
}

export function isDerivedPath(relativePath: string): boolean {
  return TAURI_TAVERN_DERIVED_DIRECTORIES.some(
    (directory) => relativePath === directory || relativePath.startsWith(`${directory}/`),
  );
}

// `constructor` / `prototype` 是合法的文件名（用户完全可能起这种预设名），只有 `__proto__`
// 在被当作对象 key 时会污染原型，所以只拦它。
const UNSAFE_SEGMENTS = new Set(['', '.', '..', '__proto__']);

/**
 * 迁移包来自用户的文件系统，路径可能带 `..`、盘符或控制字符。
 * 这里在解包阶段就拒绝，避免把它们变成 IndexedDB 的 key。
 */
export function assertSafeMigrationPath(path: string, maxLength = 500): void {
  if (!path || path.length > maxLength) {
    failTauriTavern('unsafe-path', `Unsafe migration path: ${path}`);
  }
  if (path.includes('\\') || path.startsWith('/') || /^[a-z]:/iu.test(path)) {
    failTauriTavern('unsafe-path', `Unsafe migration path: ${path}`);
  }
  for (const segment of path.split('/')) {
    if (UNSAFE_SEGMENTS.has(segment)) {
      failTauriTavern('unsafe-path', `Unsafe migration path: ${path}`);
    }
  }
  for (const character of path) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      failTauriTavern('unsafe-path', `Unsafe migration path: ${path}`);
    }
  }
}

/**
 * 由自然键推导出稳定 id（RFC 9562 的 version 8 自定义 UUID）。
 * 同一个迁移包重复导入必须命中同一条记录，否则每导入一次就多一份角色和聊天。
 */
export async function deterministicId(namespace: string, name: string): Promise<string> {
  const encoded = new TextEncoder().encode(`pure-tavern/tauri-tavern/${namespace}\u001f${name}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  apng: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  json: 'application/json',
  jsonl: 'application/jsonl',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  pdf: 'application/pdf',
  zip: 'application/zip',
  vrm: 'model/gltf-binary',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
};

export function fileExtension(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index > 0 && index < filename.length - 1 ? filename.slice(index + 1).toLowerCase() : '';
}

export function withoutExtension(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index > 0 ? filename.slice(0, index) : filename;
}

export function mimeTypeForFile(filename: string): string {
  return MIME_BY_EXTENSION[fileExtension(filename)] ?? 'application/octet-stream';
}
