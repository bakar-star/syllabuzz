var CACHE = 'syllabuzz-v9';
var FILES = [
  './',
  'index.html',
  'manifest.json',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      /* add each file on its own so one missing file can't break the install */
      return Promise.all(FILES.map(function (u) {
        return c.add(u).catch(function () {});
      }));
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;

  var isPage = req.mode === 'navigate' || req.destination === 'document' ||
    /(^|\/)(index\.html)?$/.test(url.pathname);

  if (isPage) {
    /* network first */
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req, { ignoreSearch: true })
          .then(function (r) { return r || caches.match('index.html') || caches.match('./'); });
      })
    );
    return;
  }

  /* cache first, refresh in the background */
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
