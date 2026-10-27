const CACHE = 'billie-local-shell-v5';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './offline.html',
  './modules/storage.js',
  './modules/library.js',
  './modules/lyrics.js',
  './modules/video.js',
  './modules/media.js',
  './modules/ui.js',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  './icons/icon-maskable.svg'
];
const SHELL_PATHS = new Set(SHELL.map((asset) => new URL(asset, self.location.href).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('billie-local-shell-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.toLowerCase().startsWith('/billie/')) {
    event.respondWith(fetch(request));
    return;
  }

  if (url.pathname === '/songs.json') return;

  if (url.pathname.startsWith('/api/cover/') || url.pathname.startsWith('/covers/')) {
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch((error) => console.warn('Could not cache cover artwork.', error));
        }
        return response;
      }).catch(async () => (await caches.match(request)) || Response.error())
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/lyrics' || url.pathname === '/api/video') {
      event.respondWith(fetch(request).catch(() => new Response(
        JSON.stringify({ error: 'offline', message: 'Connect to the internet to see lyrics or video.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      )));
    }
    return;
  }

  if (!SHELL_PATHS.has(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match('./offline.html')) || Response.error())
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch((error) => console.warn('Could not cache app asset.', error));
        }
        return response;
      });
    })
  );
});
