/* global self, URL, Response, fetch, Headers, console, indexedDB */

const DATABASE_NAME = 'pure-tavern-modular-dev';
const KEY_SEPARATOR = '\u001f';
const ASSETS_MODULE = 'assets';
const CHARACTERS_MODULE = 'characters';
const ASSET_MARKER_HEADER = 'X-Pure-Tavern-Asset';
const WORKER_VERSION = '2';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const lookup = resolveLookup(url);
  if (!lookup) return;
  event.respondWith(respondWithAsset(event.request, lookup));
});

function resolveLookup(url) {
  if (url.pathname === '/thumbnail') {
    const type = url.searchParams.get('type');
    const file = url.searchParams.get('file') || '';
    if (!isSafeRelativePath(file)) return { kind: 'invalid' };
    if (type === 'avatar') {
      return {
        kind: 'character-avatar',
        id: file,
        fallback: '/img/ai4.png',
        marker: 'characters/avatar',
      };
    }
    if (type === 'bg') {
      return {
        kind: 'asset-alias',
        path: `/backgrounds/${file}`,
        fallback: `/backgrounds/${encodePath(file)}`,
        marker: 'assets/backgrounds',
      };
    }
    if (type === 'persona') {
      return {
        kind: 'asset-alias',
        path: `/User Avatars/${file}`,
        fallback:
          file === 'user-default.png'
            ? '/User%20Avatars/user-default.png'
            : '/img/user-default.png',
        marker: 'assets/user-avatars',
      };
    }
    return null;
  }

  const pathname = decodePathname(url.pathname);
  if (!pathname || !isSupportedAssetPath(pathname)) return null;

  if (pathname.startsWith('/characters/')) {
    const relative = pathname.slice('/characters/'.length);
    if (!relative.includes('/') && relative.toLowerCase().endsWith('.png')) {
      return {
        kind: 'character-avatar-or-alias',
        id: relative,
        path: pathname,
        fallback: '/img/ai4.png',
        marker: 'characters/avatar',
      };
    }
  }

  return {
    kind: 'asset-alias',
    path: pathname,
    fallback: url.pathname + url.search,
    marker: markerForPath(pathname),
  };
}

async function respondWithAsset(request, lookup) {
  if (lookup.kind === 'invalid') return new Response('Invalid asset path', { status: 400 });

  try {
    let stored = null;
    if (lookup.kind === 'character-avatar' || lookup.kind === 'character-avatar-or-alias') {
      stored = await readCharacterAvatar(lookup.id);
    }
    if (!stored && (lookup.kind === 'asset-alias' || lookup.kind === 'character-avatar-or-alias')) {
      stored = await readIndexedAsset(lookup.path);
    }
    if (stored?.data) {
      return makeBlobResponse(request, stored.data, stored.contentType, lookup.marker);
    }
  } catch (error) {
    console.warn('[PureTavern Assets SW] Asset lookup failed:', error);
  }

  return fetch(lookup.fallback, { cache: 'no-store' });
}

async function readCharacterAvatar(avatarFile) {
  if (!isSafeRelativePath(avatarFile) || avatarFile.includes('/')) return null;
  const db = await openDatabase();
  try {
    const key = [CHARACTERS_MODULE, 'avatars', avatarFile].join(KEY_SEPARATOR);
    const record = await getRecord(db, 'blobs', key);
    if (!record?.data) return null;
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
  const db = await openDatabase();
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
    if (!record?.data) return null;
    return {
      data: record.data,
      contentType: String(index.value.mimeType || record.data.type || 'application/octet-stream'),
    };
  } finally {
    db.close();
  }
}

function makeBlobResponse(request, blob, contentType, marker) {
  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    [ASSET_MARKER_HEADER]: marker,
    'X-Pure-Tavern-Asset-Worker': WORKER_VERSION,
  });
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(blob.size));
    return new Response(null, { status: 200, headers });
  }

  const range = parseRange(request.headers.get('Range'), blob.size);
  if (range) {
    const body = blob.slice(range.start, range.end + 1, contentType);
    headers.set('Content-Length', String(body.size));
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${blob.size}`);
    return new Response(body, { status: 206, headers });
  }

  headers.set('Content-Length', String(blob.size));
  return new Response(blob, { status: 200, headers });
}

function parseRange(value, size) {
  if (!value || !value.startsWith('bytes=') || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    return null;
  }
  if (start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    // Dexie logical version(1) maps to native IndexedDB version 10. The
    // Service Worker opens the existing version and never owns schema upgrades.
    const request = indexedDB.open(DATABASE_NAME);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      reject(new Error('Application storage has not been initialized.'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('records') || !db.objectStoreNames.contains('blobs')) {
        db.close();
        reject(new Error('Application storage is missing required object stores.'));
        return;
      }
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed.'));
    request.onblocked = () => reject(new Error('IndexedDB open is blocked.'));
  });
}

function getRecord(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('IndexedDB read failed.'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
  });
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

function encodePath(value) {
  return value.split('/').map(encodeURIComponent).join('/');
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
