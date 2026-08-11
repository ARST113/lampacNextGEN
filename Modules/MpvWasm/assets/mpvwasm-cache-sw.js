'use strict';

var VERSION = '20260809-51-ddd-sync-final';
var CACHE_PREFIX = 'mpvwasm-runtime-';
var CACHE_NAME = CACHE_PREFIX + VERSION;
var ASSETS = [
  '/mpvwasm/assets/mpvwasm-demuxer.js?v=' + VERSION,
  '/mpvwasm/assets/mpvwasm-demuxer.wasm?v=' + VERSION,
  '/mpvwasm/assets/mpvwasm-demuxer.worker.js?v=' + VERSION,
  '/mpvwasm/assets/mpvwasm-demuxer-wrapper.js?v=' + VERSION,
  '/mpvwasm/assets/mpvwasm-demuxer-session-worker.js?v=' + VERSION,
  '/mpvwasm/assets/mpvwasm-hybrid-webcodecs.js?v=' + VERSION,
  '/mpvwasm/assets/mpvwasm-webcodecs-probe.js?v=' + VERSION,
  '/mpvwasm/assets/mpvwasm-audio-worklet.js?v=' + VERSION
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE_NAME).then(function (cache) {
    return Promise.all(ASSETS.map(function (url) {
      return cache.add(new Request(url, { cache: 'reload', credentials: 'same-origin' })).catch(function () { });
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (name) {
      return name.indexOf(CACHE_PREFIX) === 0 && name !== CACHE_NAME;
    }).map(function (name) { return caches.delete(name); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.indexOf('/mpvwasm/assets/') !== 0) return;
  if (url.searchParams.get('v') !== VERSION) return;

  event.respondWith(caches.open(CACHE_NAME).then(function (cache) {
    return cache.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        if (response && response.ok) cache.put(request, response.clone()).catch(function () { });
        return response;
      });
    });
  }));
});
