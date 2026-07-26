import { TAURI_TAVERN_DIRECTORIES, failTauriTavern } from '../domain/data-tree';

export interface TauriTavernFile {
  path: string;
  data: Uint8Array;
}

export interface TauriTavernModuleReport {
  moduleId: string;
  /** 导出时写出的文件数；导入时认领的文件数。 */
  files: number;
  records: number;
  blobs: number;
  skipped: number;
  notes: string[];
}

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder('utf-8', { fatal: false });

/**
 * SillyTavern 自己写盘用的就是 4 空格缩进。保持一致，迁移包在 git / 文本编辑器里才是可读的，
 * 用户也能直接手改一个 json 再导回来。
 */
export function encodeJson(value: unknown): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(value, null, 4)}\n`);
}

export function decodeJson(data: Uint8Array, path: string): unknown {
  let text = textDecoder.decode(data);
  // Windows 上手工编辑过的迁移包经常带 BOM，JSON.parse 会直接抛。
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    failTauriTavern(
      'invalid-json',
      `Migration file is not valid JSON: ${path} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** PureTavern 预设类型 <-> SillyTavern 预设目录。 */
export const PRESET_DIRECTORIES: Readonly<Record<string, string>> = Object.freeze({
  kobold: TAURI_TAVERN_DIRECTORIES.koboldAiSettings,
  novel: TAURI_TAVERN_DIRECTORIES.novelAiSettings,
  openai: TAURI_TAVERN_DIRECTORIES.openAiSettings,
  textgenerationwebui: TAURI_TAVERN_DIRECTORIES.textGenSettings,
  instruct: TAURI_TAVERN_DIRECTORIES.instruct,
  context: TAURI_TAVERN_DIRECTORIES.context,
  sysprompt: TAURI_TAVERN_DIRECTORIES.sysprompt,
  reasoning: TAURI_TAVERN_DIRECTORIES.reasoning,
  theme: TAURI_TAVERN_DIRECTORIES.themes,
  'moving-ui': TAURI_TAVERN_DIRECTORIES.movingUi,
  'quick-reply': TAURI_TAVERN_DIRECTORIES.quickReplies,
});

export const PRESET_TYPE_BY_DIRECTORY: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(PRESET_DIRECTORIES).map(([type, dir]) => [dir, type])),
);

/** PureTavern 资源集合 <-> SillyTavern 目录前缀（不含 `/` 开头的 legacyPath 形式）。 */
export const ASSET_DIRECTORIES: Readonly<Record<string, string>> = Object.freeze({
  backgrounds: TAURI_TAVERN_DIRECTORIES.backgrounds,
  'user-avatars': TAURI_TAVERN_DIRECTORIES.userAvatars,
  'user-images': TAURI_TAVERN_DIRECTORIES.userImages,
  attachments: TAURI_TAVERN_DIRECTORIES.userFiles,
  library: TAURI_TAVERN_DIRECTORIES.assets,
  sprites: TAURI_TAVERN_DIRECTORIES.characters,
});

export const ASSET_LIBRARY_CATEGORIES: readonly string[] = Object.freeze([
  'bgm',
  'ambient',
  'blip',
  'live2d',
  'vrm',
  'character',
  'temp',
]);

export function createModuleReport(moduleId: string): TauriTavernModuleReport {
  return { moduleId, files: 0, records: 0, blobs: 0, skipped: 0, notes: [] };
}
