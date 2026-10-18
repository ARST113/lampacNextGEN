'use strict';
// Offline check of the "instant buffer + quality warm-up" helpers from plugin.js.
//
//   node test-fast-start.js [plugin.js]
//
// The helpers are cut out of the real file and run against fake timers and a fake fetch, so this is
// the same code the client runs: warmStream dedupe/abort, warmQualityVariants order/generation,
// startBufferWindow wait-once semantics.

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const FILE = process.argv[2] || path.join(__dirname, '..', 'plugin.js');
const src = fs.readFileSync(FILE, 'utf8');

function extractFunction(source, name) {
  const marker = 'function ' + name + '(';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('function ' + name + ' not found');
  const open = source.indexOf('{', start);
  let depth = 0;
  let state = null;
  let i = open;
  for (; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (state === 'line') { if (c === '\n') state = null; continue; }
    if (state === 'block') { if (c === '*' && n === '/') { state = null; i++; } continue; }
    if (state === 'single') { if (c === '\\') { i++; continue; } if (c === "'") state = null; continue; }
    if (state === 'double') { if (c === '\\') { i++; continue; } if (c === '"') state = null; continue; }
    if (state === 'tpl') { if (c === '\\') { i++; continue; } if (c === '`') state = null; continue; }
    if (c === '/' && n === '/') { state = 'line'; i++; continue; }
    if (c === '/' && n === '*') { state = 'block'; i++; continue; }
    if (c === "'") { state = 'single'; continue; }
    if (c === '"') { state = 'double'; continue; }
    if (c === '`') { state = 'tpl'; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(start, i);
}

function extractLine(source, prefix) {
  const start = source.indexOf(prefix);
  if (start < 0) throw new Error('line ' + prefix + ' not found');
  const end = source.indexOf('\n', start);
  return source.slice(start, end);
}

// --- fake environment -----------------------------------------------------------------------------

let clock = 1000000;
let timers = [];
let nextTimerId = 1;

function fakeSetTimeout(fn, delay) {
  const id = nextTimerId++;
  timers.push({ id, at: clock + (delay || 0), fn });
  return id;
}
function fakeClearTimeout(id) {
  timers = timers.filter((timer) => timer.id !== id);
}
function advance(ms) {
  const until = clock + ms;
  let guard = 0;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const next = timers[0];
    if (!next || next.at > until) break;
    timers.shift();
    clock = next.at;
    next.fn();
    if (++guard > 10000) throw new Error('timer loop');
  }
  clock = until;
}

const fetches = [];
const aborts = [];
function FakeAbortController() {
  const self = this;
  self.aborted = false;
  self.signal = { get aborted() { return self.aborted; } };
  self.abort = function () { self.aborted = true; aborts.push(self); };
}
function fakeFetch(url, options) {
  fetches.push({ url: String(url), options: options || {} });
  return Promise.resolve({ ok: true });
}

const pieces = [
  extractLine(src, 'var warmStreams = {};'),
  extractLine(src, 'var warmStreamTtl = 4 * 60 * 1000;'),
  extractFunction(src, 'warmStream'),
  extractLine(src, 'var warmQualityTimer = null;'),
  extractFunction(src, 'warmQualityVariants'),
  extractFunction(src, 'startBufferWindow')
];

const sandbox = {
  pidtorPreloadMb: 32,
  warmStreams: {},
  warmStreamTtl: 4 * 60 * 1000,
  warmQualityTimer: null,
  playbackRequestGeneration: 1,
  fillBuffer: null,
  fetch: fakeFetch,
  AbortController: FakeAbortController,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  Date: { now: () => clock },
  Number: Number,
  String: String,
  Object: Object,
  console: console
};
vm.createContext(sandbox);
vm.runInContext('(function () {\n' + pieces.join('\n') + '\n' +
  'this.warmStream = warmStream; this.warmQualityVariants = warmQualityVariants; this.startBufferWindow = startBufferWindow;\n' +
  '})()', sandbox);

let checks = 0;
let failures = 0;
function check(label, condition, detail) {
  checks++;
  if (condition) return;
  failures++;
  console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''));
}

// --- warmStream: fires once, keeps a TTL, aborts the warm request after 2.5s -----------------------

fetches.length = 0;
aborts.length = 0;
sandbox.warmStream('http://host/lite/pidtor/saa?tsid=1');
check('warmStream: one request', fetches.length === 1, 'got ' + fetches.length);
check('warmStream: no-cors', fetches[0].options.mode === 'no-cors');
advance(1000);
sandbox.warmStream('http://host/lite/pidtor/saa?tsid=1');
check('warmStream: no duplicate inside TTL', fetches.length === 1, 'got ' + fetches.length);
advance(1600); // 2.6s after the first call
check('warmStream: warm request aborted after 2.5s', aborts.length === 1, 'got ' + aborts.length);
sandbox.warmStream('http://host/lite/pidtor/saa?tsid=2');
check('warmStream: other url is not deduped', fetches.length === 2, 'got ' + fetches.length);
advance(4 * 60 * 1000);
sandbox.warmStream('http://host/lite/pidtor/saa?tsid=1');
check('warmStream: refires after TTL', fetches.length === 3, 'got ' + fetches.length);

// --- warmQualityVariants: every other quality, one at a time, stops on a new playback ------------

fetches.length = 0;
aborts.length = 0;
const launch = {
  url: 'http://host/2160',
  quality: { '2160p': 'http://host/2160', '1080p': 'http://host/1080', '720p': 'http://host/720', '480p': 'http://host/480' }
};
sandbox.warmQualityVariants(launch);
check('variants: nothing before the first delay', fetches.length === 0, 'got ' + fetches.length);
advance(1300);
check('variants: first warm after 1.2s', fetches.length === 1 && fetches[0].url === 'http://host/1080', JSON.stringify(fetches.map((f) => f.url)));
advance(1500);
check('variants: one every 1.5s', fetches.length === 2 && fetches[1].url === 'http://host/720', JSON.stringify(fetches.map((f) => f.url)));
check('variants: the playing url is not warmed', fetches.every((f) => f.url !== 'http://host/2160'));
advance(1500);
check('variants: all alternatives warmed', fetches.length === 3, 'got ' + fetches.length);

// a new playback request must stop the chain (fresh urls: the warm map dedupes seen addresses)
fetches.length = 0;
const launch2 = {
  url: 'http://host/v2/2160',
  quality: { '2160p': 'http://host/v2/2160', '1080p': 'http://host/v2/1080', '720p': 'http://host/v2/720' }
};
sandbox.warmQualityVariants(launch2);
advance(1300);
check('variants: chain restarted', fetches.length === 1, 'got ' + fetches.length);
sandbox.playbackRequestGeneration = 2;
advance(1500);
check('variants: stopped on new playback', fetches.length === 1, 'got ' + fetches.length);

// --- startBufferWindow: waits once, even when the window already finished -------------------------

let bufferDone = null;
sandbox.fillBuffer = function (data, url, done) { bufferDone = done; };
const windowHandle = sandbox.startBufferWindow({ pidtor_playlist_session: 7 }, 'http://host/stream');
let calls = 0;
windowHandle.then(function () { calls++; });
check('window: not finished yet', calls === 0);
bufferDone();
check('window: waiter fired on finish', calls === 1);
windowHandle.then(function () { calls++; });
check('window: late waiter fires immediately', calls === 2);
bufferDone();
check('window: finish is idempotent', calls === 2);

// fillBuffer can finish synchronously (preload off / no Loading) before then() is registered
sandbox.fillBuffer = function (data, url, done) { done(); };
const instant = sandbox.startBufferWindow({}, 'http://host/stream');
let instantCalls = 0;
instant.then(function () { instantCalls++; });
check('window: instant finish still notifies', instantCalls === 1);

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
process.exit(failures ? 1 : 0);
