(() => {
  'use strict';

  const DATABASE_NAME = 'pure-tavern-modular-dev';
  const KEY_SEPARATOR = '\u001f';
  const ASSETS_MODULE = 'assets';
  const CHARACTERS_MODULE = 'characters';
  const ACTIVE_BLOB_TTL_MS = 5 * 60 * 1000;
  const MAX_ACTIVE_BLOBS = 1024;
  const MAX_CHUNK_BYTES = 1024 * 1024;
  const activeBlobs = new Map();
  let nextToken = 1;

  function resolveLookup(url) {
    if (url.pathname === '/thumbnail') {
      const type = url.searchParams.get('type');
      const file = url.searchParams.get('file') || '';
      if (!isSafeRelativePath(file)) return { kind: 'invalid' };
      if (type === 'avatar') {
        if (file.includes('/')) return { kind: 'invalid' };
        return {
          kind: 'character-avatar',
          id: file,
          fallback: '/img/ai4.png',
          marker: 'characters/avatar',
          responsePath: `/characters/${file}`,
        };
      }
      if (type === 'bg') {
        return {
          kind: 'asset-alias',
          path: `/backgrounds/${file}`,
          fallback: `/backgrounds/${file}`,
          marker: 'assets/backgrounds',
          responsePath: `/backgrounds/${file}`,
        };
      }
      if (type === 'persona') {
        return {
          kind: 'asset-alias',
          path: `/User Avatars/${file}`,
          fallback:
            file === 'user-default.png'
              ? '/User Avatars/user-default.png'
              : '/img/user-default.png',
          marker: 'assets/user-avatars',
          responsePath: `/User Avatars/${file}`,
        };
      }
      return { kind: 'unmanaged' };
    }

    const pathname = decodePathname(url.pathname);
    if (!pathname || !isSupportedAssetPath(pathname)) return { kind: 'unmanaged' };
    if (!isSafeLegacyPath(pathname)) return { kind: 'invalid' };

    if (pathname.startsWith('/characters/')) {
      const relative = pathname.slice('/characters/'.length);
      if (!relative.includes('/') && relative.toLowerCase().endsWith('.png')) {
        return {
          kind: 'character-avatar-or-alias',
          id: relative,
          path: pathname,
          fallback: '/img/ai4.png',
          marker: 'characters/avatar',
          responsePath: pathname,
        };
      }
    }

    return {
      kind: 'asset-alias',
      path: pathname,
      fallback: pathname,
      marker: markerForPath(pathname),
      responsePath: pathname,
    };
  }

  async function openAsset(urlString) {
    let url;
    try {
      url = new URL(urlString);
    } catch {
      return { kind: 'invalid' };
    }

    const lookup = resolveLookup(url);
    if (lookup.kind === 'unmanaged' || lookup.kind === 'invalid') return lookup;

    let stored = null;
    try {
      if (lookup.kind === 'character-avatar' || lookup.kind === 'character-avatar-or-alias') {
        stored = await readCharacterAvatar(lookup.id);
      }
      if (
        !stored &&
        (lookup.kind === 'asset-alias' || lookup.kind === 'character-avatar-or-alias')
      ) {
        stored = await readIndexedAsset(lookup.path);
      }
    } catch (error) {
      console.warn('[PureTavern iOS Assets] IndexedDB lookup failed:', error);
    }

    if (!stored?.data) {
      return {
        kind: 'fallback',
        path: lookup.fallback,
        marker: lookup.marker,
      };
    }

    pruneActiveBlobs();
    if (activeBlobs.size >= MAX_ACTIVE_BLOBS) {
      throw new Error('The iOS asset bridge has too many active resources.');
    }
    const token = `asset-${Date.now().toString(36)}-${(nextToken++).toString(36)}`;
    const entry = { blob: stored.data, touchedAt: Date.now(), expiryTimer: null };
    activeBlobs.set(token, entry);
    scheduleExpiry(token, entry);
    return {
      kind: 'asset',
      token,
      size: stored.data.size,
      contentType: stored.contentType,
      marker: lookup.marker,
      responsePath: lookup.responsePath,
    };
  }

  async function readChunk(token, offset, length) {
    const entry = activeBlobs.get(token);
    if (!entry) throw new Error('Unknown iOS asset bridge token.');
    if (Date.now() - entry.touchedAt >= ACTIVE_BLOB_TTL_MS) {
      releaseAsset(token);
      throw new Error('Expired iOS asset bridge token.');
    }
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length <= 0 ||
      length > MAX_CHUNK_BYTES ||
      offset + length > entry.blob.size
    ) {
      throw new Error('Invalid iOS asset bridge chunk range.');
    }
    entry.touchedAt = Date.now();
    scheduleExpiry(token, entry);
    const bytes = new Uint8Array(await entry.blob.slice(offset, offset + length).arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  function releaseAsset(token) {
    const entry = activeBlobs.get(token);
    if (entry?.expiryTimer != null) clearTimeout(entry.expiryTimer);
    activeBlobs.delete(token);
    return true;
  }

  async function readCharacterAvatar(avatarFile) {
    if (!isSafeRelativePath(avatarFile) || avatarFile.includes('/')) return null;
    const db = await openExistingDatabase();
    if (!db) return null;
    try {
      const key = [CHARACTERS_MODULE, 'avatars', avatarFile].join(KEY_SEPARATOR);
      const record = await getRecord(db, 'blobs', key);
      if (!(record?.data instanceof Blob)) return null;
      return {
        data: record.data,
        contentType: String(record.metadata?.contentType || record.data.type || 'image/png'),
      };
    } finally {
      db.close();
    }
  }

  async function readIndexedAsset(legacyPath) {
    if (!isSafeLegacyPath(legacyPath)) return null;
    const db = await openExistingDatabase();
    if (!db) return null;
    try {
      const aliasKey = [ASSETS_MODULE, 'path-aliases', legacyPath].join(KEY_SEPARATOR);
      const alias = await getRecord(db, 'records', aliasKey);
      const assetId = alias?.value?.assetId;
      if (typeof assetId !== 'string' || !assetId) return null;

      const indexKey = [ASSETS_MODULE, 'index', assetId].join(KEY_SEPARATOR);
      const index = await getRecord(db, 'records', indexKey);
      const collection = index?.value?.collection;
      if (typeof collection !== 'string' || !collection) return null;

      const blobKey = [ASSETS_MODULE, collection, assetId].join(KEY_SEPARATOR);
      const record = await getRecord(db, 'blobs', blobKey);
      if (!(record?.data instanceof Blob)) return null;
      return {
        data: record.data,
        contentType: storedAssetContentType(legacyPath, index.value.mimeType, record.data.type),
      };
    } finally {
      db.close();
    }
  }

  async function openExistingDatabase() {
    if (typeof indexedDB.databases === 'function') {
      const databases = await indexedDB.databases();
      if (!databases.some((database) => database.name === DATABASE_NAME)) return null;
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME);
      let created = false;
      request.onupgradeneeded = () => {
        created = true;
        request.transaction?.abort();
      };
      request.onsuccess = () => {
        const db = request.result;
        if (
          created ||
          !db.objectStoreNames.contains('records') ||
          !db.objectStoreNames.contains('blobs')
        ) {
          db.close();
          resolve(null);
          return;
        }
        resolve(db);
      };
      request.onerror = () => {
        if (created || request.error?.name === 'AbortError') resolve(null);
        else reject(request.error || new Error('Failed to open the PureTavern database.'));
      };
      request.onblocked = () => reject(new Error('PureTavern database access was blocked.'));
    });
  }

  function getRecord(db, storeName, key) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error(`Failed to read ${storeName}.`));
      transaction.onabort = () =>
        reject(transaction.error || new Error(`${storeName} read aborted.`));
    });
  }

  function storedAssetContentType(legacyPath, indexedType, blobType) {
    if (legacyPath.startsWith('/scripts/extensions/third-party/')) return '';
    for (const candidate of [indexedType, blobType]) {
      const normalized = typeof candidate === 'string' ? candidate.trim() : '';
      if (normalized) return normalized;
    }
    return 'application/octet-stream';
  }

  function scheduleExpiry(token, entry) {
    if (entry.expiryTimer !== null) clearTimeout(entry.expiryTimer);
    const delay = Math.max(1, entry.touchedAt + ACTIVE_BLOB_TTL_MS - Date.now());
    entry.expiryTimer = setTimeout(() => {
      const current = activeBlobs.get(token);
      if (current !== entry) return;
      if (Date.now() - entry.touchedAt >= ACTIVE_BLOB_TTL_MS) releaseAsset(token);
      else scheduleExpiry(token, entry);
    }, delay);
    entry.expiryTimer?.unref?.();
  }

  function pruneActiveBlobs() {
    const expiresBefore = Date.now() - ACTIVE_BLOB_TTL_MS;
    for (const [token, entry] of activeBlobs) {
      if (entry.touchedAt <= expiresBefore) releaseAsset(token);
    }
  }

  function decodePathname(pathname) {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return null;
    }
  }

  function isSupportedAssetPath(pathname) {
    return [
      '/backgrounds/',
      '/User Avatars/',
      '/user/files/',
      '/user/images/',
      '/characters/',
      '/assets/',
      '/scripts/extensions/third-party/',
    ].some((prefix) => pathname.startsWith(prefix));
  }

  function isSafeLegacyPath(pathname) {
    return pathname.startsWith('/') && isSafeRelativePath(pathname.slice(1));
  }

  function isSafeRelativePath(value) {
    if (typeof value !== 'string' || !value || value.includes('\\')) return false;
    const segments = value.split('/');
    return !segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        [...segment].some((character) => {
          const code = character.codePointAt(0) || 0;
          return code <= 31 || code === 127;
        }),
    );
  }

  function markerForPath(pathname) {
    if (pathname.startsWith('/backgrounds/')) return 'assets/backgrounds';
    if (pathname.startsWith('/User Avatars/')) return 'assets/user-avatars';
    if (pathname.startsWith('/user/files/')) return 'assets/attachments';
    if (pathname.startsWith('/user/images/')) return 'assets/user-images';
    if (pathname.startsWith('/characters/')) return 'assets/sprites';
    if (pathname.startsWith('/scripts/extensions/third-party/')) return 'assets/extensions';
    return 'assets/library';
  }

  globalThis.__PURE_TAVERN_IOS_ASSET_BRIDGE__ = Object.freeze({
    openAsset,
    readChunk,
    releaseAsset,
  });
})();
