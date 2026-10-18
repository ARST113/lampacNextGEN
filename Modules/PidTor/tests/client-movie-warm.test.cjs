'use strict';
// Offline check of the movie "instant buffer" work in plugin.js.
//
//   node test-movie-warm.js [plugin.js]
//
// warmMovieChoice is cut out of the real file and run against stubs, so this is exactly the code
// the client runs. Structural checks afterwards make sure the movie launch path really opens the
// buffer window and both launch paths write the watch history the stock player writes.

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

// --- stubs -----------------------------------------------------------------------------------------

const calls = [];
function qualityOptions(data) { return data.options || []; }
function defaultQuality(options) { return options.filter((o) => o.default)[0] || options[0] || null; }
function warmStream(url) { calls.push(url); }
function account(url) { return 'http://lampac.fun' + url; }
function sourceForPlayback(source, useGst) { return source + (useGst ? '&gst=1' : ''); }

const sandbox = {
  pidtorPreloadMb: 32,
  qualityOptions: qualityOptions,
  defaultQuality: defaultQuality,
  warmStream: warmStream,
  account: account,
  sourceForPlayback: sourceForPlayback,
  parseInt: parseInt,
  Array: Array,
  String: String
};
vm.createContext(sandbox);
vm.runInContext('(function () {\n' + extractFunction(src, 'warmMovieChoice') + '\n' +
  'this.warmMovieChoice = warmMovieChoice;\n})()', sandbox);

let checks = 0;
let failures = 0;
function check(label, condition, detail) {
  checks++;
  if (condition) return;
  failures++;
  console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''));
}

function replica(url, seeders) {
  return { stream_url: url, seeders: seeders };
}

// --- warmMovieChoice: best two copies of the selected quality, warm request issued for each ---------

calls.length = 0;
const data = {
  options: [
    { key: '2160', label: '2160p', variant: { replicas: [replica('/s0000000000000000000000000000000000000000', 4)] } },
    { key: '1080', label: '1080p', default: true, variant: { replicas: [replica('/s1111111111111111111111111111111111111111', 9), replica('/s1111111111111111111111111111111111111111', 9), replica('/s2222222222222222222222222222222222222222', 12), replica('/s3333333333333333333333333333333333333333', 7), { seeders: 100 }] } }
  ]
};
sandbox.warmMovieChoice(data, {});
check('movie warm: two best copies of the default quality', calls.length === 2, JSON.stringify(calls));
check('movie warm: seed-first order', calls[0].indexOf('s2222222222222222222222222222222222222222') >= 0 && calls[1].indexOf('s1111111111111111111111111111111111111111') >= 0, JSON.stringify(calls));
check('movie warm: urls are account()ed', calls.every((u) => u.indexOf('http://lampac.fun/s') === 0), JSON.stringify(calls));
check('movie warm: no gst flag for external player', calls.every((u) => u.indexOf('gst=1') < 0));

calls.length = 0;
sandbox.warmMovieChoice(data, { pidtor_quality_key: '2160' });
check('movie warm: stored quality preference wins', calls.length === 1 && calls[0].indexOf('s0000000000000000000000000000000000000000') >= 0, JSON.stringify(calls));

calls.length = 0;
sandbox.warmMovieChoice({ options: [] }, {});
check('movie warm: nothing to warm without options', calls.length === 0, JSON.stringify(calls));

calls.length = 0;
sandbox.warmMovieChoice(null, {});
check('movie warm: null response is safe', calls.length === 0, JSON.stringify(calls));

calls.length = 0;
sandbox.pidtorPreloadMb = 0;
sandbox.warmMovieChoice(data, {});
check('movie warm: disabled with preload 0', calls.length === 0, JSON.stringify(calls));
sandbox.pidtorPreloadMb = 32;

// --- structure: the movie path really opens the buffer window and writes history -------------------

const movieAt = src.indexOf('function launchMovieDirect(');
const movie = src.slice(movieAt, src.indexOf('\n  function ', movieAt + 10) > 0 ? src.indexOf('\n  function ', movieAt + 10) : undefined);
check('structure: cache warm before the network request', movie.indexOf('warmMovieChoice(cachedApiResponse(endpoint)') > 0);
check('structure: warm after the PidTor response', movie.indexOf('warmMovieChoice(data, preferences)') > 0);
check('structure: buffer window opens for the external player', movie.indexOf('var bufferedMovie = externalPlayerTarget(item) ? startBufferWindow(item, item.url) : null;') > 0);
check('structure: playback waits for the buffer', movie.indexOf('bufferedMovie.then(play)') > 0);
const moviePlayAt = movie.indexOf('Lampa.Player.play(item);');
check('structure: movie player call goes through play()', moviePlayAt > movie.indexOf('var play = function ()') && moviePlayAt < movie.indexOf('var bufferedMovie'));
check('structure: start() waits for the buffer, not only play()', movie.indexOf('var start = function ()') > 0 && movie.indexOf('bufferedMovie.then(play)') > movie.indexOf('var start = function ()'));
check('structure: movie history add', movie.indexOf("Lampa.Favorite.add('history', movie, 100)") > 0);
check('structure: history add before the player opens', movie.indexOf("history") >= 0 && movie.indexOf("Lampa.Favorite.add('history', movie, 100)") < moviePlayAt);

const seriesAt = src.indexOf('var startPlayer = function ()');
const series = src.slice(Math.max(0, seriesAt - 400), seriesAt + 4000);
check('structure: series history add', series.indexOf("Lampa.Favorite.add('history', object.movie, 100)") > 0);
check('structure: history guard per launch', series.indexOf('var historyMarked = false;') > 0);
check('structure: series buffer window kept', series.indexOf('startBufferWindow(launchItem, launchItem.url)') > 0);

check('build: 81 marker', src.indexOf("window.pidtor_nextgen_build = '20261017-81-movie-warm'") > 0);
check('build: warmMovieChoice defined once', (src.match(/function warmMovieChoice\(/g) || []).length === 1);
check('build: warmMovieChoice called twice', (src.match(/warmMovieChoice\(/g) || []).length === 3, String((src.match(/warmMovieChoice\(/g) || []).length));

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
process.exit(failures ? 1 : 0);
