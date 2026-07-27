import { describe, expect, it } from 'vitest';

import type { PortableArchiveEntry } from '../application/archive-participant-registry';
import {
  packTauriTavernArchive,
  unpackTauriTavernArchive,
} from '../tauri-tavern/application/tauri-tavern-archive';
import { toTauriTavernFiles } from '../tauri-tavern/application/tauri-tavern-export';
import type { TauriTavernFile } from '../tauri-tavern/application/tauri-tavern-format';
import {
  fromTauriTavernFiles,
  type CharacterCardReader,
} from '../tauri-tavern/application/tauri-tavern-import';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CARD = {
  name: 'Seraphina',
  spec: 'chara_card_v2',
  spec_version: '2.0',
  create_date: '2026-01-02T03:04:05.000Z',
  data: { name: 'Seraphina' },
};

const cardReader: CharacterCardReader = { readCardFromPng: () => ({ ...CARD }) };

function record(
  moduleId: string,
  collection: string,
  id: string,
  value: unknown,
): PortableArchiveEntry {
  return blob(moduleId, collection, id, encoder.encode(JSON.stringify(value)), 'record');
}

function blob(
  moduleId: string,
  collection: string,
  id: string,
  data: Uint8Array,
  kind: 'record' | 'blob' = 'blob',
): PortableArchiveEntry {
  return {
    descriptor: {
      path: `modules/${moduleId}/${kind}s/${collection}/${id}`,
      moduleId,
      kind,
      collection,
      id,
      size: data.byteLength,
      sha256: '',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
    data,
  };
}

function sampleEntries(): PortableArchiveEntry[] {
  return [
    record('characters', 'cards', 'card-1', {
      id: 'card-1',
      avatarFile: 'Seraphina.png',
      card: CARD,
      createdAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-01-02T03:04:05.000Z',
    }),
    blob('characters', 'avatars', 'Seraphina.png', encoder.encode('fake-png-bytes')),
    record('chats', 'sessions', 'session-1', {
      id: 'session-1',
      ownerId: 'card-1',
      ownerAlias: 'Seraphina.png',
      characterName: 'Seraphina',
      legacyFileName: 'First chat.jsonl',
      header: { user_name: 'User', character_name: 'Seraphina', chat_metadata: { tag: 'a' } },
      chatMetadata: { tag: 'a' },
      messageCount: 1,
      byteSize: 10,
      lastMessage: 'hi',
      lastMessageAt: '2026-02-01T00:00:00.000Z',
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    }),
    record('chats', 'messages', 'session-1', [
      { name: 'User', is_user: true, mes: 'hi', send_date: '2026-02-01T00:00:00.000Z' },
    ]),
    record('world-books', 'books', 'book-1', {
      id: 'book-1',
      legacyFileId: 'Lore',
      name: 'Lore',
      document: { name: 'Lore', entries: { 0: { key: ['x'] } } },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    record('world-books', 'aliases', 'Lore', { bookId: 'book-1' }),
    record('presets', 'documents', 'openai:preset-1', {
      id: 'preset-1',
      type: 'openai',
      name: 'My Preset',
      value: { temperature: 0.7 },
      metadata: { origin: 'user', userModified: true, createdAt: '', updatedAt: '' },
    }),
    record('presets', 'aliases', 'openai:My Preset', { presetId: 'preset-1' }),
    record('settings', 'documents', 'current', {
      theme: 'dark',
      power_user: { personas: { 'user-default.png': 'User' } },
    }),
    record('secrets', 'store', 'current', {
      secrets: { api_key_openai: [{ id: 's1', value: 'sk-x', label: 'main', active: true }] },
    }),
    record('stats', 'documents', 'current', { timestamp: 12, 'Seraphina.png': { chat_size: 3 } }),
    record('assets', 'index', 'asset-1', {
      id: 'asset-1',
      collection: 'backgrounds',
      legacyPath: '/backgrounds/forest.jpg',
      filename: 'forest.jpg',
      mimeType: 'image/jpeg',
      size: 9,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    record('assets', 'path-aliases', '/backgrounds/forest.jpg', { assetId: 'asset-1' }),
    blob('assets', 'backgrounds', 'asset-1', encoder.encode('jpeg-data')),
    record('personas', 'state', 'current', { version: 1, personas: [] }),
  ];
}

/** 带虚拟文件夹和图片元数据的资源，用来覆盖 image-metadata.json 这一路。 */
function withImageMetadata(entries: PortableArchiveEntry[]): PortableArchiveEntry[] {
  const enriched = entries.map((entry) => {
    if (entry.descriptor.collection !== 'index') return entry;
    const asset = JSON.parse(decoder.decode(entry.data)) as Record<string, unknown>;
    asset.folderIds = ['folder-1'];
    asset.imageMetadata = {
      path: '/backgrounds/forest.jpg',
      addedTimestamp: 1773888889792,
      aspectRatio: 1.7778,
      isAnimated: false,
      dominantColor: '#123456',
    };
    return record('assets', 'index', entry.descriptor.id, asset);
  });
  enriched.push(
    record('assets', 'background-folders', 'folder-1', {
      id: 'folder-1',
      name: 'Outdoors',
      thumbnailFile: 'forest.jpg',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  return enriched;
}

function fileAt(files: readonly TauriTavernFile[], path: string): TauriTavernFile {
  const file = files.find((candidate) => candidate.path === path);
  if (!file)
    throw new Error(`Missing migration file: ${path}\n${files.map((f) => f.path).join('\n')}`);
  return file;
}

function entryFor(
  entries: readonly PortableArchiveEntry[],
  moduleId: string,
  collection: string,
): PortableArchiveEntry {
  const entry = entries.find(
    (candidate) =>
      candidate.descriptor.moduleId === moduleId && candidate.descriptor.collection === collection,
  );
  if (!entry) throw new Error(`Missing entry: ${moduleId}/${collection}`);
  return entry;
}

function readRecord(entry: PortableArchiveEntry): Record<string, unknown> {
  return JSON.parse(decoder.decode(entry.data)) as Record<string, unknown>;
}

describe('TauriTavern export mapping', () => {
  it('writes every module into the SillyTavern data/default-user layout', () => {
    const { files, modules, warnings } = toTauriTavernFiles(sampleEntries());
    const paths = files.map((file) => file.path);

    expect(paths).toEqual([
      'data/default-user/backgrounds/forest.jpg',
      'data/default-user/characters/Seraphina.png',
      'data/default-user/chats/Seraphina/First chat.jsonl',
      'data/default-user/OpenAI Settings/My Preset.json',
      'data/default-user/secrets.json',
      'data/default-user/settings.json',
      'data/default-user/stats.json',
      'data/default-user/worlds/Lore.json',
    ]);
    expect(warnings).toEqual([]);

    const chat = decoder.decode(
      fileAt(files, 'data/default-user/chats/Seraphina/First chat.jsonl').data,
    );
    const lines = chat.trim().split('\n');
    expect(JSON.parse(lines[0] as string)).toMatchObject({ user_name: 'User' });
    expect(JSON.parse(lines[1] as string)).toMatchObject({ mes: 'hi' });

    // secrets.json 存的是内层 map，不是我们的 { secrets: ... } 包装。
    expect(
      JSON.parse(decoder.decode(fileAt(files, 'data/default-user/secrets.json').data)),
    ).toEqual({
      api_key_openai: [{ id: 's1', value: 'sk-x', label: 'main', active: true }],
    });

    // Persona 没有独立文件，必须显式说明而不是静默丢掉。
    expect(modules.find((module) => module.moduleId === 'personas')).toMatchObject({
      files: 0,
      skipped: 1,
    });
  });

  it('writes background folders and per-image metadata into image-metadata.json', () => {
    const { files } = toTauriTavernFiles(withImageMetadata(sampleEntries()));
    const document = JSON.parse(
      decoder.decode(fileAt(files, 'data/default-user/image-metadata.json').data),
    );

    expect(document).toMatchObject({
      version: 1,
      folders: [{ id: 'folder-1', name: 'Outdoors', thumbnailFile: 'forest.jpg' }],
    });
    // SillyTavern 的 key 是不带开头斜杠的相对路径，folderIds 嵌在元数据对象里。
    expect(document.images['backgrounds/forest.jpg']).toMatchObject({
      aspectRatio: 1.7778,
      dominantColor: '#123456',
      folderIds: ['folder-1'],
    });
  });

  it('omits image-metadata.json when there is nothing to describe', () => {
    const { files } = toTauriTavernFiles(sampleEntries());
    expect(files.some((file) => file.path.endsWith('image-metadata.json'))).toBe(false);
  });

  it('reports characters whose avatar image is missing instead of dropping them silently', () => {
    const entries = sampleEntries().filter((entry) => entry.descriptor.collection !== 'avatars');
    const { files, warnings } = toTauriTavernFiles(entries);
    expect(files.some((file) => file.path.startsWith('data/default-user/characters/'))).toBe(false);
    expect(warnings.join('\n')).toContain('Seraphina.png');
  });
});

describe('TauriTavern import mapping', () => {
  it('rebuilds module records and keeps chat ownership aligned with the character', async () => {
    const { files } = toTauriTavernFiles(sampleEntries());
    const { entries, warnings } = await fromTauriTavernFiles(files, {
      cardReader,
      now: '2026-07-26T00:00:00.000Z',
    });
    expect(warnings).toEqual([]);

    const card = readRecord(entryFor(entries, 'characters', 'cards'));
    expect(card).toMatchObject({
      avatarFile: 'Seraphina.png',
      createdAt: '2026-01-02T03:04:05.000Z',
    });

    const session = readRecord(entryFor(entries, 'chats', 'sessions'));
    expect(session).toMatchObject({
      ownerId: card.id,
      ownerAlias: 'Seraphina.png',
      characterName: 'Seraphina',
      legacyFileName: 'First chat.jsonl',
      messageCount: 1,
    });
    const alias = readRecord(entryFor(entries, 'chats', 'owner-aliases'));
    expect(alias).toMatchObject({ ownerId: card.id, avatarUrl: 'Seraphina.png' });

    const book = readRecord(entryFor(entries, 'world-books', 'books'));
    expect(book).toMatchObject({ legacyFileId: 'Lore', name: 'Lore' });
    expect(readRecord(entryFor(entries, 'world-books', 'aliases'))).toEqual({ bookId: book.id });

    const preset = readRecord(entryFor(entries, 'presets', 'documents'));
    expect(preset).toMatchObject({
      type: 'openai',
      name: 'My Preset',
      value: { temperature: 0.7 },
    });

    expect(readRecord(entryFor(entries, 'settings', 'documents'))).toMatchObject({ theme: 'dark' });
    expect(readRecord(entryFor(entries, 'secrets', 'store'))).toMatchObject({
      secrets: { api_key_openai: [{ id: 's1' }] },
    });
    expect(readRecord(entryFor(entries, 'stats', 'documents'))).toMatchObject({ timestamp: 12 });

    const asset = readRecord(entryFor(entries, 'assets', 'index'));
    expect(asset).toMatchObject({
      collection: 'backgrounds',
      legacyPath: '/backgrounds/forest.jpg',
      mimeType: 'image/jpeg',
    });
    expect(
      entries.some(
        (entry) =>
          entry.descriptor.kind === 'blob' && entry.descriptor.collection === 'backgrounds',
      ),
    ).toBe(true);
  });

  it('produces the same ids on a second import so re-importing does not duplicate data', async () => {
    const { files } = toTauriTavernFiles(sampleEntries());
    const first = await fromTauriTavernFiles(files, {
      cardReader,
      now: '2026-07-26T00:00:00.000Z',
    });
    const second = await fromTauriTavernFiles(files, {
      cardReader,
      now: '2026-08-01T00:00:00.000Z',
    });

    const ids = (result: typeof first) =>
      result.entries.map((entry) => `${entry.descriptor.collection}/${entry.descriptor.id}`).sort();
    expect(ids(second)).toEqual(ids(first));
  });

  it('claims ids that already exist locally instead of creating a second copy', async () => {
    const { files } = toTauriTavernFiles(sampleEntries());
    const { entries } = await fromTauriTavernFiles(files, {
      cardReader,
      now: '2026-07-26T00:00:00.000Z',
      identity: {
        characterIdByAvatar: (avatarFile) =>
          avatarFile === 'Seraphina.png' ? 'existing-card' : null,
        chatOwnerIdByAvatar: () => null,
        chatSessionId: () => null,
        worldBookId: (legacyFileId) => (legacyFileId === 'Lore' ? 'existing-book' : null),
        presetId: () => null,
        assetId: () => null,
      },
    });

    expect(entryFor(entries, 'characters', 'cards').descriptor.id).toBe('existing-card');
    expect(readRecord(entryFor(entries, 'chats', 'sessions')).ownerId).toBe('existing-card');
    expect(entryFor(entries, 'world-books', 'books').descriptor.id).toBe('existing-book');
  });

  it('restores background folders and per-image metadata', async () => {
    const { files } = toTauriTavernFiles(withImageMetadata(sampleEntries()));
    const { entries } = await fromTauriTavernFiles(files, {
      cardReader,
      now: '2026-07-26T00:00:00.000Z',
    });

    expect(readRecord(entryFor(entries, 'assets', 'background-folders'))).toMatchObject({
      id: 'folder-1',
      name: 'Outdoors',
      thumbnailFile: 'forest.jpg',
    });
    const asset = readRecord(entryFor(entries, 'assets', 'index'));
    expect(asset).toMatchObject({
      legacyPath: '/backgrounds/forest.jpg',
      folderIds: ['folder-1'],
      // addedTimestamp 决定背景管理器里的排序，必须沿用原始时间而不是导入时间。
      createdAt: new Date(1773888889792).toISOString(),
      imageMetadata: { aspectRatio: 1.7778, dominantColor: '#123456' },
    });
  });

  it('accounts for every file in the package, including the ones it drops', async () => {
    const packageFiles = [
      { path: 'data/extensions/third-party/my-ext/index.js', data: encoder.encode('x') },
      { path: 'data/_tauritavern/skills/a.json', data: encoder.encode('{}') },
      { path: 'data/default-user/vectors/store.bin', data: encoder.encode('x') },
      { path: 'data/default-user/thumbnails/bg/a.jpg', data: encoder.encode('x') },
      { path: 'data/default-user/backups/chat/a.jsonl', data: encoder.encode('x') },
      { path: 'data/default-user/groups/party.json', data: encoder.encode('{}') },
      { path: 'data/default-user/worlds/Lore.json', data: encoder.encode('{"entries":{}}') },
    ];
    const { modules, warnings } = await fromTauriTavernFiles(packageFiles, { cardReader });

    const byId = new Map(modules.map((module) => [module.moduleId, module]));
    expect(byId.get('extensions')).toMatchObject({ files: 1, skipped: 1 });
    // 派生数据仍然丢弃，但必须计数——否则用户看到的总数对不上包里的文件数。
    expect(byId.get('derived')).toMatchObject({ files: 3, skipped: 3 });
    expect(byId.get('unsupported')).toMatchObject({ files: 2, skipped: 2 });
    expect(byId.get('world-books')).toMatchObject({ files: 1 });

    const reported = modules.reduce((total, module) => total + module.files, 0);
    expect(reported).toBe(packageFiles.length);
    // 跳过的具体路径要能被用户看到，而不只是一个数字。
    expect(byId.get('unsupported')?.notes).toEqual([
      'data/_tauritavern/skills/a.json',
      'groups/party.json',
    ]);
    expect(warnings.join('\n')).toContain('groups/party.json');
    expect(warnings.join('\n')).toContain('extension');
  });
});

describe('TauriTavern extension interop', () => {
  const MANIFEST = JSON.stringify({
    display_name: '酒馆助手',
    version: '4.5.2',
    author: 'KAKAA',
    js: 'dist/index.js',
    homePage: 'https://github.com/N0VI028/JS-Slash-Runner',
  });
  const SOURCE = JSON.stringify({
    host: 'github.com',
    repo_path: 'N0VI028/JS-Slash-Runner',
    reference: '4.5.2',
    remote_url: 'https://github.com/N0VI028/JS-Slash-Runner',
    installed_commit: '0cac9964f3e3f6b310bf64cbdb2a82178e4dfb52',
  });

  function packageFiles(): TauriTavernFile[] {
    return [
      {
        path: 'data/extensions/third-party/JS-Slash-Runner/manifest.json',
        data: encoder.encode(MANIFEST),
      },
      {
        path: 'data/extensions/third-party/JS-Slash-Runner/dist/index.js',
        data: encoder.encode('globalThis.__jsr = 1;'),
      },
      {
        path: 'data/_tauritavern/extension-sources/global/JS-Slash-Runner.json',
        data: encoder.encode(SOURCE),
      },
    ];
  }

  /** 用扩展特性真实的校验器和 id 推导，测试里只做最小转发。 */
  const extensionMigration = {
    async buildImportedExtension(input: {
      folderName: string;
      repositoryUrl: string;
      requestedRef: string;
      revision: string;
      scope: string;
      installedAt: string;
      files: readonly { path: string; data: Blob }[];
    }) {
      const { validateLegacyExtensionPackage } =
        await import('@/features/extensions/application/package-validator');
      const validated = await validateLegacyExtensionPackage(input.files);
      const digest = await crypto.subtle.digest(
        'SHA-256',
        encoder.encode(input.repositoryUrl.toLocaleLowerCase('en-US')),
      );
      const extensionId = `legacy.${[...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 40)}`;
      const legacyName = `third-party/${input.folderName}`;
      return {
        extensionId,
        legacyName,
        files: validated.files,
        record: {
          extensionId,
          legacyName,
          folderName: input.folderName,
          trust: 'user-approved-legacy',
          scope: input.scope,
          enabled: true,
          manifest: validated.manifest,
          source: {
            kind: 'remote',
            provider: 'github',
            repositoryUrl: input.repositoryUrl,
            requestedRef: input.requestedRef,
            resolvedRef: input.requestedRef,
            revision: input.revision,
            packageHash: validated.packageHash,
            fileCount: validated.fileCount,
            totalBytes: validated.totalBytes,
          },
          installedAt: input.installedAt,
          updatedAt: input.installedAt,
        },
      };
    },
  };

  it('installs a third-party extension and stores its files as library assets', async () => {
    const { entries, modules, warnings } = await fromTauriTavernFiles(packageFiles(), {
      cardReader,
      extensionMigration,
      now: '2026-07-27T00:00:00.000Z',
    });
    expect(warnings).toEqual([]);

    const registered = readRecord(entryFor(entries, 'extensions', 'registry-v2'));
    expect(registered).toMatchObject({
      folderName: 'JS-Slash-Runner',
      legacyName: 'third-party/JS-Slash-Runner',
      trust: 'user-approved-legacy',
      enabled: true,
      manifest: { display_name: '酒馆助手', version: '4.5.2' },
      source: {
        kind: 'remote',
        repositoryUrl: 'https://github.com/N0VI028/JS-Slash-Runner',
        requestedRef: '4.5.2',
        revision: '0cac9964f3e3f6b310bf64cbdb2a82178e4dfb52',
      },
    });

    // 包文件要落成 library 资源，路径和 AssetService.saveExtensionPackage 写出来的一致，
    // 否则 Legacy 加载器按 /scripts/extensions/... 取不到文件。
    const assets = entries
      .filter((entry) => entry.descriptor.moduleId === 'assets')
      .filter((entry) => entry.descriptor.collection === 'index')
      .map((entry) => readRecord(entry));
    expect(assets.map((asset) => asset.legacyPath).sort()).toEqual([
      '/scripts/extensions/third-party/JS-Slash-Runner/dist/index.js',
      '/scripts/extensions/third-party/JS-Slash-Runner/manifest.json',
    ]);
    expect(assets[0]).toMatchObject({
      collection: 'library',
      owner: `extension-package:${registered.extensionId as string}`,
      folder: 'third-party/JS-Slash-Runner',
    });
    expect(
      entries.some(
        (entry) => entry.descriptor.kind === 'blob' && entry.descriptor.collection === 'library',
      ),
    ).toBe(true);

    // 扩展的文件算在 extensions 名下，不能在 assets 里再数一遍。
    // 2 个包文件 + 1 个来源记录，全部算在 extensions 名下。
    const byId = new Map(modules.map((module) => [module.moduleId, module]));
    expect(byId.get('extensions')).toMatchObject({ files: 3, skipped: 0 });
    expect(byId.get('assets')?.files ?? 0).toBe(0);
    expect(modules.reduce((total, module) => total + module.files, 0)).toBe(3);
  });

  it('imports every package file verbatim, including build artifacts', async () => {
    const files = [
      ...packageFiles(),
      {
        path: 'data/extensions/third-party/JS-Slash-Runner/dist/index.js.map',
        data: encoder.encode('x'.repeat(4096)),
      },
    ];
    const { entries } = await fromTauriTavernFiles(files, {
      cardReader,
      extensionMigration,
      now: '2026-07-27T00:00:00.000Z',
    });

    // 用户的扩展目录原样搬过来，不替他判断哪些文件「没用」。
    const stored = entries
      .filter((entry) => entry.descriptor.moduleId === 'assets')
      .filter((entry) => entry.descriptor.collection === 'index')
      .map((entry) => String(readRecord(entry).legacyPath));
    expect(stored.sort()).toEqual([
      '/scripts/extensions/third-party/JS-Slash-Runner/dist/index.js',
      '/scripts/extensions/third-party/JS-Slash-Runner/dist/index.js.map',
      '/scripts/extensions/third-party/JS-Slash-Runner/manifest.json',
    ]);
    expect(readRecord(entryFor(entries, 'extensions', 'registry-v2')).source).toMatchObject({
      fileCount: 3,
    });
  });

  it('skips an extension whose origin cannot be determined', async () => {
    const files = packageFiles().filter((file) => !file.path.includes('extension-sources'));
    const withoutHomePage = files.map((file) =>
      file.path.endsWith('manifest.json')
        ? {
            ...file,
            data: encoder.encode(JSON.stringify({ display_name: 'X', js: 'dist/index.js' })),
          }
        : file,
    );
    const { entries, warnings } = await fromTauriTavernFiles(withoutHomePage, {
      cardReader,
      extensionMigration,
    });

    expect(entries.some((entry) => entry.descriptor.moduleId === 'extensions')).toBe(false);
    expect(warnings.join('\n')).toContain('no recorded source repository');
  });

  it('writes extension bytes and source records back out on export', () => {
    const extensionId = 'legacy.0123456789abcdef0123456789abcdef01234567';
    const { files } = toTauriTavernFiles([
      record('extensions', 'registry-v2', extensionId, {
        extensionId,
        legacyName: 'third-party/JS-Slash-Runner',
        folderName: 'JS-Slash-Runner',
        trust: 'user-approved-legacy',
        scope: 'global',
        enabled: true,
        manifest: { display_name: '酒馆助手', version: '4.5.2' },
        source: {
          kind: 'remote',
          provider: 'github',
          repositoryUrl: 'https://github.com/N0VI028/JS-Slash-Runner',
          requestedRef: '4.5.2',
          revision: '0cac9964',
        },
      }),
      record('assets', 'index', 'pkg-1', {
        id: 'pkg-1',
        collection: 'library',
        legacyPath: '/scripts/extensions/third-party/JS-Slash-Runner/manifest.json',
        filename: 'manifest.json',
        mimeType: 'application/json',
        size: 2,
        owner: `extension-package:${extensionId}`,
        folder: 'third-party/JS-Slash-Runner',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      blob('assets', 'library', 'pkg-1', encoder.encode(MANIFEST)),
    ]);

    const paths = files.map((file) => file.path);
    // 关键：扩展包不在 default-user/ 下面，写成 default-user/scripts/... 对面是读不到的。
    expect(paths).toContain('data/extensions/third-party/JS-Slash-Runner/manifest.json');
    expect(paths.some((path) => path.includes('default-user/scripts'))).toBe(false);

    const source = JSON.parse(
      decoder.decode(
        fileAt(files, 'data/_tauritavern/extension-sources/global/JS-Slash-Runner.json').data,
      ),
    );
    expect(source).toEqual({
      host: 'github.com',
      repo_path: 'N0VI028/JS-Slash-Runner',
      reference: '4.5.2',
      remote_url: 'https://github.com/N0VI028/JS-Slash-Runner',
      installed_commit: '0cac9964',
    });
  });
});

describe('TauriTavern package layout', () => {
  it('round-trips through the ZIP container', async () => {
    const { files } = toTauriTavernFiles(sampleEntries());
    const unpacked = await unpackTauriTavernArchive(packTauriTavernArchive(files));
    expect(unpacked.map((file) => file.path)).toEqual(files.map((file) => file.path));
  });

  it('accepts packages whose reported size exceeds the former archive quota', async () => {
    const archive = packTauriTavernArchive([
      { path: 'data/default-user/worlds/A.json', data: encoder.encode('{}') },
    ]);
    Object.defineProperty(archive, 'size', { value: 65 * 1024 * 1024 * 1024 });

    await expect(unpackTauriTavernArchive(archive)).resolves.toEqual([
      { path: 'data/default-user/worlds/A.json', data: expect.any(Uint8Array) },
    ]);
  });

  it('accepts packages wrapped in an extra folder or rooted at the user directory', async () => {
    const payload = encoder.encode('{}');
    const wrapped = packTauriTavernArchive([
      { path: 'tauritavern-data-20260101/data/default-user/worlds/A.json', data: payload },
    ]);
    await expect(unpackTauriTavernArchive(wrapped)).resolves.toEqual([
      { path: 'data/default-user/worlds/A.json', data: expect.any(Uint8Array) },
    ]);

    const userRooted = packTauriTavernArchive([
      { path: 'default-user/worlds/A.json', data: payload },
    ]);
    await expect(unpackTauriTavernArchive(userRooted)).resolves.toEqual([
      { path: 'data/default-user/worlds/A.json', data: expect.any(Uint8Array) },
    ]);

    const bare = packTauriTavernArchive([{ path: 'worlds/A.json', data: payload }]);
    await expect(unpackTauriTavernArchive(bare)).resolves.toEqual([
      { path: 'data/default-user/worlds/A.json', data: expect.any(Uint8Array) },
    ]);
  });

  it('keeps file names that merely look like object members and rejects prototype pollution', async () => {
    const payload = encoder.encode('{}');
    const packed = packTauriTavernArchive([
      { path: 'data/default-user/OpenAI Settings/constructor.json', data: payload },
      { path: 'data/default-user/OpenAI Settings/prototype.json', data: payload },
    ]);
    await expect(unpackTauriTavernArchive(packed)).resolves.toHaveLength(2);

    expect(() =>
      packTauriTavernArchive([
        { path: 'data/default-user/OpenAI Settings/__proto__.json', data: payload },
        { path: 'data/default-user/__proto__/x.json', data: payload },
      ]),
    ).toThrow(/Unsafe migration path/u);
  });

  it('rejects a ZIP that is not a TauriTavern data package', async () => {
    const unrelated = packTauriTavernArchive([
      { path: 'notes/readme.txt', data: encoder.encode('hello') },
    ]);
    await expect(unpackTauriTavernArchive(unrelated)).rejects.toThrow(
      /does not look like a TauriTavern data package/u,
    );
  });
});
