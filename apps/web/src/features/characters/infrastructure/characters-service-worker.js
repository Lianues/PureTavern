/* global self, URL, Response, fetch, Headers, console, indexedDB */

const DATABASE_NAME = 'pure-frontend-tavern-modular-dev';
const KEY_SEPARATOR = '\u001f';
const MODULE_ID = 'characters';
const AVATAR_COLLECTION = 'avatars';
const FALLBACK_AVATAR = '/img/ai4.png';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const avatarFile = getAvatarFile(url);
  if (!avatarFile) return;

  event.respondWith(respondWithAvatar(avatarFile));
});

function getAvatarFile(url) {
  if (url.pathname === '/thumbnail' && url.searchParams.get('type') === 'avatar') {
    return url.searchParams.get('file') || '';
  }
  if (url.pathname.startsWith('/characters/')) {
    try {
      return decodeURIComponent(url.pathname.slice('/characters/'.length));
    } catch {
      return '';
    }
  }
  return '';
}

function isSafeAvatarFile(file) {
  return (
    typeof file === 'string' &&
    file.length > 4 &&
    file.toLowerCase().endsWith('.png') &&
    !file.includes('..') &&
    !file.split('').some(isUnsafeFileCharacter)
  );
}

function isUnsafeFileCharacter(char) {
  const code = char.charCodeAt(0);
  return code <= 31 || /[\\/:*?"<>|]/.test(char);
}

async function respondWithAvatar(avatarFile) {
  if (!isSafeAvatarFile(avatarFile)) {
    return new Response('Invalid avatar file', { status: 400 });
  }

  try {
    const record = await readAvatarRecord(avatarFile);
    if (!record?.data) return fetch(FALLBACK_AVATAR, { cache: 'reload' });
    const headers = new Headers({
      'Content-Type': String(record.metadata?.contentType || record.data.type || 'image/png'),
      'Cache-Control': 'no-store',
      'X-Pure-Tavern-Asset': 'characters/avatar',
    });
    return new Response(record.data, { status: 200, headers });
  } catch (error) {
    console.warn('[PureTavern Characters SW] Avatar lookup failed:', error);
    return fetch(FALLBACK_AVATAR, { cache: 'reload' });
  }
}

async function readAvatarRecord(avatarFile) {
  const db = await openDatabase();
  const key = [MODULE_ID, AVATAR_COLLECTION, avatarFile].join(KEY_SEPARATOR);
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readonly');
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('IndexedDB transaction failed.'));
    };
    const request = tx.objectStore('blobs').get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('IndexedDB read failed.'));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    // Dexie maps its logical version(1) to native IndexedDB version 10.
    // The Service Worker must open the existing database without declaring a
    // version; schema creation and upgrades belong exclusively to AppDatabase.
    const request = indexedDB.open(DATABASE_NAME);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      reject(new Error('Characters storage has not been initialized by the application.'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('blobs')) {
        db.close();
        reject(new Error('Characters storage is missing the blobs object store.'));
        return;
      }
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed.'));
    request.onblocked = () => reject(new Error('IndexedDB open is blocked.'));
  });
}
