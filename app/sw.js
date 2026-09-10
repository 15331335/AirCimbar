/* ==========================================================================
   AirCimbar service worker
   The whole point of this app is working with no network, so precache the
   engine (including the ~1.9 MB wasm) and serve cache-first.
   ========================================================================== */
'use strict';

var VERSION = 'aircimbar-v1';
var ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/cimbar.js',
  './js/send.js',
  './js/recv.js',
  './js/import.js',
  './js/ui.js',
  './js/cimbar-worker.js',
  './vendor/cimbar_js.js',
  './vendor/cimbar_js.wasm',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      /* addAll is all-or-nothing; tolerate a single missing optional asset */
      return Promise.all(ASSETS.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () { });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === VERSION ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'offline' });
      });
    })
  );
});
