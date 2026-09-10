/* ==========================================================================
   AirCimbar service worker

   The strategy is split, because the two halves have opposite needs:

     /vendor/*  (the ~1.9 MB wasm, plus its glue)
         cache-first. Large, content-stable, and re-downloading it on every
         load would be wasteful and slow on a phone.

     everything else (html / css / js)
         network-first, falling back to cache.
         The app is served from a machine on the LAN that is normally up, so
         "ask the server, use the cache only if it isn't there" means an edit
         lands on the very next reload. The previous cache-first policy
         silently pinned whatever was installed first, which is why every
         change needed a manual cache-version bump before the phone would
         ever see it.

   Offline still works: when the server is unreachable every request falls
   through to the cache, which is the entire point of precaching it.
   ========================================================================== */
'use strict';

/* Names the cache and drives purging of older ones. Bumping it is no longer
   required for updates to be picked up — network-first handles that — but it
   remains the cleanest way to drop everything at once. */
var VERSION = 'aircimbar-v4';

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
      /* best-effort per file: one missing optional asset must not abort the
         whole install */
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

/* Lets the page display which cached build it is actually running. Without
   this there is no way to tell "the update landed" from "I am looking at a
   stale cache" — the exact confusion this app kept causing. */
self.addEventListener('message', function (e) {
  var port = e.ports && e.ports[0];
  if (e.data && e.data.type === 'version' && port) {
    port.postMessage({ version: VERSION });
  }
});

function put(req, res) {
  if (!res || res.status !== 200 || res.type !== 'basic') return;
  var copy = res.clone();
  caches.open(VERSION).then(function (c) { c.put(req, copy); }).catch(function () { });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  if (url.pathname.indexOf('/vendor/') === 0) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) { put(req, res); return res; });
      })
    );
    return;
  }

  e.respondWith(
    fetch(req).then(function (res) {
      put(req, res);
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'offline' });
      });
    })
  );
});
