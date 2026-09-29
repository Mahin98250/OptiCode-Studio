const CACHE = 'opticode-studio-v5';
const BASE = '/OptiCode-Studio/';
const BUILD_MANIFEST = BASE + 'manifest.json';

const SHELL = [
  BASE,
  BASE + 'manifest.webmanifest',
  BASE + 'icon-192.svg',
  BASE + 'icon-512.svg',
  BASE + 'favicon.svg',
  BUILD_MANIFEST,
];

function resolveAsset(path) {
  return new URL(path, self.location.origin + BASE).toString();
}

async function getPrecacheUrls() {
  const response = await fetch(resolveAsset('manifest.json'), { cache: 'no-store' });
  if (!response.ok) throw new Error('Build manifest unavailable');

  const manifest = await response.json();
  const urls = new Set(SHELL);

  for (const entry of Object.values(manifest)) {
    if (!entry || typeof entry !== 'object') continue;

    for (const field of ['file', 'css', 'assets']) {
      const values = Array.isArray(entry[field]) ? entry[field] : [entry[field]];
      for (const value of values) {
        if (typeof value === 'string' && value) {
          urls.add(resolveAsset(value));
        }
      }
    }
  }

  return [...urls];
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    getPrecacheUrls()
      .then((urls) => caches.open(CACHE).then((cache) => cache.addAll(urls)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('opticode-studio-') && key !== CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const copy = response.clone();
      const cache = await caches.open(CACHE);
      await cache.put(request, copy);
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;

    const fallback = await caches.match(BASE);
    if (fallback && request.mode === 'navigate') return fallback;

    throw new Error('Offline and resource is not cached');
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const copy = response.clone();
      const cache = await caches.open(CACHE);
      await cache.put(request, copy);
    }
    return response;
  } catch {
    throw new Error('Offline and resource is not cached');
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;

  // Always try the latest app shell first; fall back to the cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  // Generated JS/CSS/worker files are content-hashed by Vite, so cached-first
  // gives instant startup without sacrificing updates.
  event.respondWith(cacheFirst(request));
});
