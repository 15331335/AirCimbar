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
var VERSION = 'aircimbar-v6';

/* The subset the app cannot boot without. If any of these cannot be cached the
   install must FAIL rather than leave a half-populated cache behind — and
   critically, activate() must not delete the previous (working) cache. */
var CORE = [
  './',
  './index.html',
  './css/app.css',
  './js/cimbar.js',
  './js/send.js',
  './js/recv.js',
  './js/import.js',
  './js/ui.js',
  './js/cimbar-worker.js',
  './vendor/cimbar_js.js',
  './vendor/cimbar_js.wasm',
];

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
  './apple-touch-icon.png',
  './icons/icon-192.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      return Promise.all(ASSETS.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {
          /* optional assets (sizes of icon nobody asked for) may be absent.
             A core asset failing aborts the install, which leaves the previous
             service worker and its cache untouched — far better than
             activating an empty cache and losing offline entirely. */
          if (CORE.indexOf(u) >= 0) throw new Error('core asset not cached: ' + u);
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

/** true when every core asset is present in the current cache */
function coreComplete() {
  return caches.open(VERSION).then(function (c) {
    return c.keys().then(function (keys) {
      var have = {};
      keys.forEach(function (k) { have[new URL(k.url).pathname] = true; });
      var missing = CORE.filter(function (u) {
        return !have[u.replace(/^\./, '')];
      });
      return { complete: missing.length === 0, missing: missing, cached: keys.length };
    });
  }).catch(function () {
    return { complete: false, missing: CORE, cached: 0 };
  });
}

self.addEventListener('activate', function (e) {
  e.waitUntil(
    coreComplete().then(function (state) {
      /* Only prune the old caches once we know the new one can stand alone. */
      if (!state.complete) return null;
      return caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === VERSION ? null : caches.delete(k);
        }));
      });
    }).then(function () { return self.clients.claim(); })
  );
});

/* Lets the page display which cached build it is actually running. Without
   this there is no way to tell "the update landed" from "I am looking at a
   stale cache" — the exact confusion this app kept causing. */
self.addEventListener('message', function (e) {
  var port = e.ports && e.ports[0];
  if (!port || !e.data || e.data.type !== 'version') return;
  coreComplete().then(function (state) {
    port.postMessage({
      version: VERSION,
      cached: state.cached,
      total: ASSETS.length,
      missing: state.missing,
      offlineReady: state.complete,
    });
  });
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
