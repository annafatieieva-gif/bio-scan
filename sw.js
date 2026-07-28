const CACHE = 'health-vault-v8';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './ocr.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './assets/corner-vine.svg',
  './assets/header-vine.svg',
  './assets/empty-illustration.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Network-first for CDN (tesseract/pdf.js/chart.js), cache-first for app shell
  const url = new URL(e.request.url);
  if (ASSETS.some((a) => e.request.url.endsWith(a.replace('./','')))) {
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request))
    );
  }
});
