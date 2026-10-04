// service-worker.js — アプリ本体をキャッシュしてオフラインでも起動できるようにする
//
// ★ ファイルを更新して GitHub に上げ直したら、下の VERSION の数字を変えること。
//   （変えなくても次回起動時に裏で新しいファイルを取りに行くが、変えると確実に切り替わる）

const VERSION = 'kiritoru-v4';
const FILES = [
  './',
  './index.html',
  './manifest.json',
  './style.css',
  './app.js',
  './utils.js',
  './state.js',
  './storage.js',
  './video.js',
  './frames.js',
  './timeline.js',
  './audio.js',
  './scoring.js',
  './sceneAnalyzer.js',
  './recommend.js',
  './export.js',
  './vtuber.js',
  './vtuber.css',
  './avatarRenderer.js',
  './stageRecorder.js',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// キャッシュがあればすぐ返し、裏で最新を取りに行って次回に備える
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const fresh = fetch(req)
        .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
