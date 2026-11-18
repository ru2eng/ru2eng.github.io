'use strict';

var CACHE = 'tatoeba-shell-v4';
var DATA_CACHE = 'tatoeba-data-v1';
var SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE && key !== DATA_CACHE; })
          .map(function (key) { return caches.delete(key); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

function manifestDate(text) {
  try { return (JSON.parse(text) || {}).build_date; } catch (e) { return text; }
}

function cacheFirstData(request) {
  return caches.open(DATA_CACHE).then(function (cache) {
    return cache.match(request, { ignoreSearch: false }).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        if (response && response.status === 200 && response.url.indexOf('/data/') !== -1) {
          var copy = response.clone();
          caches.open(DATA_CACHE).then(function (c) { c.put(request, copy); });
        }
        return response;
      });
    });
  });
}

function checkManifestVersion(request) {
  var plainUrl = request.url.replace(/\?.*$/, '');
  var plainReq = new Request(plainUrl);
  return caches.open(DATA_CACHE).then(function (cache) {
    return cache.match(plainReq).then(function (cached) {
      return fetch(plainReq, { cache: 'reload' }).then(function (fresh) {
        if (!fresh || fresh.status !== 200) return cached || fresh;
        var forText = fresh.clone();
        var forCache = fresh.clone();
        var cachedTextP = cached ? cached.text() : Promise.resolve('');
        var freshTextP = forText.text();
        return Promise.all([cachedTextP, freshTextP]).then(function (texts) {
          var changed = manifestDate(texts[1]) !== manifestDate(texts[0]);
          return cache.keys().then(function (keys) {
            if (!changed) return undefined;
            return Promise.all(keys.map(function (key) { return cache.delete(key); }));
          }).then(function () {
            return cache.put(plainReq, forCache);
          });
        }).then(function () {
          return cache.match(plainReq) || fresh;
        });
      }).catch(function () {
        return cache.match(plainReq) || cached;
      });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (event.request.method !== 'GET') return;

  var isData = url.pathname.indexOf('/data/') !== -1;
  if (isData) {
    if (url.pathname.indexOf('/manifest.json') !== -1 && url.search.indexOf('check=') !== -1) {
      event.respondWith(checkManifestVersion(event.request));
      return;
    }
    event.respondWith(cacheFirstData(event.request));
    return;
  }

  // shell: stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var fresh = fetch(event.request).then(function (response) {
        if (response && response.status === 200) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(event.request, copy); });
        }
        return response;
      }).catch(function () {
        return cached;
      });
      return cached || fresh;
    })
  );
});