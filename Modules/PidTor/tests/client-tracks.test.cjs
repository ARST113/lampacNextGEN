'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const pluginPath = path.join(__dirname, '..', 'plugin.js');
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(40);
const source = (hash, index = 1) => `http://parser.test/lite/pidtor/s${hash}?tsid=${index}&direct=true`;
const audio = (title, index = 1, codec = 'ac3', channels = 6) => ({
  stream_index: index, title, language: 'rus', codec, channels
});
const streams = (title = 'AVO Gavrilov', index = 1) => [
  { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
  { index, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'rus', title } },
  { index: 8, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'rus', title: 'Forced' }, disposition: { forced: 1 } }
];
function variant(id, hash, quality = '1080p', tracks = [], serial = true) {
  return {
    id, probe_required: true, video: { quality, codec: 'h264' }, audio: tracks, subtitles: [],
    replicas: [{ infohash: hash, seeders: 50, trackers: 'tr=udp%3A%2F%2Ftracker.test%3A80%2Fannounce',
      episodes_url: serial ? `http://parser.test/episodes/${hash}` : null,
      stream_url: serial ? null : source(hash) }]
  };
}
const plain = value => JSON.parse(JSON.stringify(value));
let testEnvironments = [];

// AST extraction executes the actual client functions, without plugin startup or a browser.
function environment({ serial = true, data, probe, episodes, deferProbes = false, deferEpisodes = false, deferV2 = false, gst = false } = {}) {
  const text = fs.readFileSync(pluginPath, 'utf8');
  const ast = ts.createSourceFile(pluginPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(ast.parseDiagnostics.length, 0, 'plugin must parse');
  let body;
  function visit(node) {
    if (!body && ts.isFunctionExpression(node) && node.body.statements.some(x => ts.isFunctionDeclaration(x) && x.name?.text === 'qualityOptions')) body = node.body;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const statements = body.statements.filter(x => ts.isFunctionDeclaration(x) || ts.isVariableStatement(x));
  const exposed = statements.filter(ts.isFunctionDeclaration).map(x => x.name.text);
  const code = statements.map(node => {
    if (ts.isFunctionDeclaration(node) && node.name.text === 'PidTorComponent') {
      const end = node.body.end - 1;
      return text.slice(node.getStart(ast), end) + '\nthis.test = { resolveOption, optionResolvers, trackResolvers, playerItem, launch, playEpisode, warmEpisode, draw };\n' + text.slice(end, node.end);
    }
    return node.getText(ast);
  }).join('\n');
  const calls = [], pending = [], played = [], notices = [], callbackErrors = [], timers = new Map();
  let now = 1000, timerId = 0, activeProbes = 0, maxProbes = 0, playlist = [];
  const ui = new Proxy({ length: 0 }, { get(target, key) { return key in target ? target[key] : () => ui; } });
  const defaults = data || { variants: [variant('a', HASH_A)], gst };
  const movie = { id: 42, title: 'Fixture', media_type: serial ? 'tv' : 'movie', number_of_seasons: serial ? 1 : 0 };
  const ctx = vm.createContext({
    URL, URLSearchParams, console, window: {}, document: { createElement: () => ({ canPlayType: () => 'probably' }) },
    CustomEvent: function (name, options) { this.detail = options.detail; },
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return ++timerId; }, clearInterval() {},
    $: () => ui,
    Lampa: {
      Storage: { get: (name, fallback) => ({ account_email: 'fixture@example.test', lampac_unic_id: 'fixture-uid' })[name] ?? fallback, field: () => gst },
      Utils: { addUrlComponent: (url, query) => url + (url.includes('?') ? '&' : '?') + query,
        hash: value => value, putScriptAsync: (_, complete) => complete() },
      Reguest: function () {
        this.timeout = value => { this.timeoutMs = value; };
        this.clear = () => { this.cleared = true; };
        this.native = (url, complete, error) => {
          const call = { url, complete, error, timeout: this.timeoutMs };
          calls.push(call);
          if (url.includes('/probe/')) {
            activeProbes++; maxProbes = Math.max(maxProbes, activeProbes);
            call.finish = (response) => { activeProbes--; complete(response); };
            if (deferProbes) pending.push(call);
            else queueMicrotask(() => { try { call.finish(probe ? probe(new URL(url)) : { streams: streams() }); } catch (failure) { callbackErrors.push(failure.message); try { error(failure); } catch (nested) { callbackErrors.push(nested.message); } } });
          } else if (url.includes('/episodes/')) {
            if (deferEpisodes) return;
            queueMicrotask(() => {
              try {
              if (episodes === false) error({ statusText: 'missing' });
              else complete({ data: episodes ? episodes(new URL(url)) : [
                { e: 1, s: 1, name: 'one.mkv', url: source(HASH_A, 1) },
                { e: 2, s: 1, name: 'two.mkv', url: source(HASH_A, 2) }
              ] });
              } catch (failure) { callbackErrors.push(failure.message); try { error(failure); } catch (nested) { callbackErrors.push(nested.message); } }
            });
          } else if (url.includes('/v2?')) {
            if (deferV2) return;
            queueMicrotask(() => { try { complete(defaults); } catch (failure) { callbackErrors.push(failure.message); } });
          }
          else throw new Error('Unexpected local request: ' + url);
        };
      },
      Explorer: function () { return ui; }, Filter: function () { return ui; }, Scroll: function () { return ui; },
      Timeline: { view: () => ({ time: 0 }), render: () => ui }, TMDB: { image: value => value },
      Noty: { show: text => notices.push(text) },
      Player: { play: item => { played.push(item); ctx.activeControlsData = item; ctx.playbackRequestGeneration++; }, playlist: items => { playlist = items; }, loading() {} },
      PlayerPanel: { setLevels() {}, quality() {}, setTranslate() {}, setTracks() {}, setSubs() {} },
      PlayerPlaylist: { get: () => playlist },
      PlayerVideo: { video: () => null },
      Layer: { visible() {} }, Controller: { enable() {} }, Template: { get: () => ui },
      Activity: { active: () => ({}), backward() {}, mixState() {} }
    }
  });
  vm.runInContext("'use strict';\n" + code + "\nAPI = 'http://parser.test'; TOKEN = 'fixture-token';\nwindow.dispatchEvent = function () {};\nthis.client = { " + exposed.join(',') + ' };', ctx);
  const component = new ctx.client.PidTorComponent({ movie });
  component.activity = { loader() {} };
  ctx.warmDirectSource = () => {};
  ctx.warmGstSource = () => { throw new Error('Background warm must not prepare GST/probe'); };
  const result = { ctx, client: ctx.client, component: component.test, movie, data: defaults, calls, pending, played, notices, callbackErrors,
    probes: () => calls.filter(x => x.url.includes('/probe/')), maxProbes: () => maxProbes,
    activate: item => { ctx.activeControlsData = item; },
    advance: ms => { now += ms; },
    flushTimers: (maxDelay = 1000) => { const current = [...timers.entries()].filter(([, timer]) => timer.delay <= maxDelay); current.forEach(([id, timer]) => { timers.delete(id); timer.fn(); }); }
  };
  testEnvironments.push(result);
  return result;
}
async function drain() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
function resolve(resolver) { return new Promise((complete, error) => resolver.resolve(complete, error)); }
const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('season catalog uses a new cache namespace after release-selection changes', () => {
  const controller = fs.readFileSync(path.join(__dirname, '..', 'Controller.cs'), 'utf8');
  assert.ok(controller.includes('pidtor:v2:20:'), 'persisted old season catalog must not survive this update');
});

test('release studio label survives exact-file hydration of a single unnamed UND track', async () => {
  const response = streams(); response[1].tags = { language: 'und' };
  const v = variant('time-media', HASH_A); v.release_voice = 'Тайм Медиа Групп';
  const env = environment({ data: { variants: [v] }, probe: () => ({ streams: response }) });
  env.component.launch(env.data, { number: 2 }); await drain();
  const choices = env.played[0].pidtor_audio_options;
  assert.equal(choices.length, 1);
  assert.equal(choices[0].title, 'Тайм Медиа Групп');
  assert.equal(choices[0].track.stream_index, 1);
  assert.equal(response[1].tags.title, undefined, 'original ffprobe must stay unchanged');
  assert.equal(env.played[0].ffprobe[1].tags.language, 'und');
});

test('generic SoundHandler does not hide the single UND release voice', () => {
  const env = environment(), v = variant('credit', HASH_A);
  v.release_voice = 'Тайм Медиа Групп';
  const response = streams(); response[1].tags = { language: 'und', handler_name: 'SoundHandler' };
  env.client.applyProbe(v, response);
  assert.equal(v.audio[0].title, 'Тайм Медиа Групп');
  assert.equal(response[1].tags.handler_name, 'SoundHandler');
});

test('release credit does not replace verified titles or label original-language audio', () => {
  const env = environment();
  for (const [tags, expected] of [[{ language: 'und', title: 'Verified voice' }, 'Verified voice'],
    [{ language: 'und', handler_name: 'Verified handler' }, 'Verified handler'], [{ language: 'eng' }, '']]) {
    const v = variant('credit', HASH_A); v.release_voice = 'Тайм Медиа Групп';
    const response = streams(); response[1].tags = tags;
    env.client.applyProbe(v, response);
    assert.equal(v.audio[0].title, expected);
  }
});

test('release credit cannot fabricate audio or label multiple unnamed tracks', () => {
  const env = environment();
  for (const count of [0, 2]) {
    const v = variant('credit', HASH_A); v.release_voice = 'Тайм Медиа Групп';
    const response = [streams()[0], ...Array.from({ length: count }, (_, i) =>
      ({ index: i + 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'und' } }))];
    env.client.applyProbe(v, response);
    assert.equal(v.audio.length, count);
    assert.ok(v.audio.every(a => a.title === ''));
  }
});

test('missing language and whitespace-only tags use the single release credit', () => {
  const env = environment(), v = variant('credit', HASH_A);
  v.release_voice = 'Тайм Медиа Групп';
  const response = streams(); response[1].tags = { title: '  ', handler_name: ' ' };
  env.client.applyProbe(v, response);
  assert.equal(v.audio[0].title, 'Тайм Медиа Групп');
});

test('direct series launch does not wait for a cold exact-file probe', async () => {
  const env = environment({ gst: true, deferProbes: true });
  env.component.launch(env.data, { number: 1 }); await drain();
  assert.equal(env.played.length, 1);
  assert.equal(env.played[0].pidtor_use_gst, false);
  assert.equal(env.played[0].pidtor_gst_bypass, true);
  assert.equal(new URL(env.played[0].url).searchParams.get('direct'), 'true');
  assert.equal(env.played[0].pidtor_audio_options.length, 0);
  assert.equal(env.pending.length, 1);
  env.pending.shift().finish({ streams: streams('Verified voice') }); await drain();
  assert.equal(env.played[0].pidtor_audio_options[0].title, 'Verified voice');
  assert.equal(env.played.length, 1, 'metadata must not restart the player');
});

test('direct movie launch bypasses GS even when old server and device settings enable it', async () => {
  const env = environment({ serial: false, gst: true, deferProbes: true,
    data: { gst: true, variants: [variant('movie', HASH_A, '1080p', [], false)] } });
  env.client.launchMovieDirect({ movie: env.movie }); await drain();
  assert.equal(env.played.length, 1);
  assert.equal(env.played[0].pidtor_gst_bypass, true);
  assert.equal(env.played[0].pidtor_use_gst, false);
  assert.ok(!env.calls.some(call => call.url.includes('/gst/')));
});

test('first series copy starts without waiting for another copy and late voices remain available', async () => {
  const env = environment({ data: { variants: [variant('a', HASH_A), variant('b', HASH_B)], gst: false },
    deferEpisodes: true, deferProbes: true });
  env.component.launch(env.data, { number: 1 }); await drain();
  const copies = env.calls.filter(call => call.url.includes('/episodes/'));
  copies[0].complete({ data: [{ e: 1, s: 1, name: 'one.mkv', url: source(HASH_A) }] }); await drain();
  assert.equal(env.played.length, 1, 'a stalled replica must not block the first real file');
  env.pending.shift().finish({ streams: streams('AVO Gavrilov') }); await drain();
  copies[1].complete({ data: [{ e: 1, s: 1, name: 'one.mkv', url: source(HASH_B) }] }); await drain();
  env.pending.shift().finish({ streams: streams('AVO Gaevsky') }); await drain();
  assert.deepEqual(plain(env.played[0].pidtor_audio_options.map(x => x.title)), ['AVO Gavrilov', 'AVO Gaevsky']);
  assert.equal(env.played.length, 1);
});

test('late full-season copy expands an already playing two-episode playlist', async () => {
  const env = environment({ data: { variants: [variant('a', HASH_A), variant('b', HASH_B)] }, deferEpisodes: true, deferProbes: true });
  env.component.launch(env.data, { number: 2 }); await drain();
  const copies = env.calls.filter(call => call.url.includes('/episodes/'));
  copies[0].complete({ data: [1, 2].map(e => ({ e, s: 1, name: `S01E${e}.mkv`, url: source(HASH_A, e) })) }); await drain();
  const active = env.played[0];
  assert.equal(env.ctx.Lampa.PlayerPlaylist.get().length, 2);
  copies[1].complete({ data: Array.from({ length: 20 }, (_, i) => ({ e: i + 1, s: 1, name: `S01E${i + 1}.mkv`, url: source(HASH_B, i + 1) })) }); await drain();
  assert.equal(env.ctx.Lampa.PlayerPlaylist.get().length, 20);
  assert.equal(env.played.length, 1, 'expanding a season must not restart playback');
  assert.equal(env.ctx.activeControlsData, active);
  assert.equal(active.episode, 2);
});

test('full season from another verified quality adds missing episodes without changing active quality', async () => {
  const env = environment({ data: { variants: [variant('a', HASH_A), variant('b', HASH_B, '720p')] }, deferEpisodes: true, deferProbes: true });
  env.component.launch(env.data, { number: 2 }); await drain();
  env.calls.find(call => call.url.includes('/episodes/')).complete({ data: [1, 2].map(e => ({ e, s: 1, url: source(HASH_A, e) })) }); await drain();
  env.flushTimers(0); await drain();
  env.calls.find(call => call.url.includes('/episodes/' + HASH_B)).complete({ data: Array.from({ length: 20 }, (_, i) => ({ e: i + 1, s: 1, url: source(HASH_B, i + 1) })) }); await drain();
  const playlist = env.ctx.Lampa.PlayerPlaylist.get();
  assert.equal(playlist.length, 20);
  assert.equal(env.played[0].pidtor_quality_key, '1080p');
  assert.equal(playlist.find(item => item.episode === 3).pidtor_quality_key, '720p');
  assert.equal(env.played.length, 1);
});

test('late season expansion survives next episode but never affects another playback session', async () => {
  const env = environment({ data: { variants: [variant('a', HASH_A), variant('b', HASH_B)] }, deferEpisodes: true, deferProbes: true });
  env.component.launch(env.data, { number: 1 }); await drain();
  const copies = env.calls.filter(call => call.url.includes('/episodes/'));
  copies[0].complete({ data: [1, 2].map(e => ({ e, s: 1, url: source(HASH_A, e) })) }); await drain();
  const second = env.ctx.Lampa.PlayerPlaylist.get()[1];
  env.activate(second);
  copies[1].complete({ data: Array.from({ length: 20 }, (_, i) => ({ e: i + 1, s: 1, url: source(HASH_B, i + 1) })) }); await drain();
  assert.equal(env.ctx.Lampa.PlayerPlaylist.get().length, 20);
  assert.equal(env.ctx.activeControlsData, second);

  const other = environment({ data: env.data, deferEpisodes: true, deferProbes: true });
  other.component.launch(other.data, { number: 1 }); await drain();
  const oldCopies = other.calls.filter(call => call.url.includes('/episodes/'));
  oldCopies[0].complete({ data: [1, 2].map(e => ({ e, s: 1, url: source(HASH_A, e) })) }); await drain();
  other.activate({ ...other.played[0], pidtor_playlist_session: -1 });
  oldCopies[1].complete({ data: Array.from({ length: 20 }, (_, i) => ({ e: i + 1, s: 1, url: source(HASH_B, i + 1) })) }); await drain();
  assert.equal(other.ctx.Lampa.PlayerPlaylist.get().length, 2);
});

test('background quality keeps expanding after its first partial episode list', async () => {
  const hashD = 'd'.repeat(40);
  const env = environment({ data: { variants: [variant('a', HASH_A), variant('c', HASH_C, '720p'), variant('d', hashD, '720p')] }, deferEpisodes: true, deferProbes: true });
  env.component.launch(env.data, { number: 1 }); await drain();
  env.calls.find(call => call.url.includes('/episodes/' + HASH_A)).complete({ data: [1, 2].map(e => ({ e, s: 1, url: source(HASH_A, e) })) }); await drain();
  env.flushTimers(0); await drain();
  env.calls.find(call => call.url.includes('/episodes/' + HASH_C)).complete({ data: [1, 2].map(e => ({ e, s: 1, url: source(HASH_C, e) })) }); await drain();
  env.activate(env.ctx.Lampa.PlayerPlaylist.get()[1]);
  env.calls.find(call => call.url.includes('/episodes/' + hashD)).complete({ data: Array.from({ length: 20 }, (_, i) => ({ e: i + 1, s: 1, url: source(hashD, i + 1) })) }); await drain();
  assert.equal(env.ctx.Lampa.PlayerPlaylist.get().length, 20);
});

test('late full selected quality becomes selectable on episodes first found in another quality', async () => {
  const env = environment({ data: { variants: [variant('a', HASH_A), variant('b', HASH_B), variant('c', HASH_C, '720p')] }, deferEpisodes: true, deferProbes: true });
  env.component.launch(env.data, { number: 1 }); await drain();
  env.calls.find(call => call.url.includes('/episodes/' + HASH_A)).complete({ data: [1, 2].map(e => ({ e, s: 1, url: source(HASH_A, e) })) }); await drain();
  env.flushTimers(0); await drain();
  const full = hash => Array.from({ length: 20 }, (_, i) => ({ e: i + 1, s: 1, url: source(hash, i + 1) }));
  env.calls.find(call => call.url.includes('/episodes/' + HASH_C)).complete({ data: full(HASH_C) }); await drain();
  env.calls.find(call => call.url.includes('/episodes/' + HASH_B)).complete({ data: full(HASH_B) }); await drain();
  const third = env.ctx.Lampa.PlayerPlaylist.get().find(item => item.episode === 3);
  assert.deepEqual(plain(third.pidtor_quality_options.map(option => option.key).sort()), ['1080p', '720p']);
});

test('native audio switch does not claim success when the browser cannot select tracks', () => {
  const env = environment();
  env.ctx.installPlayerControls = () => {};
  const v = { id: 'a', source_file_key: HASH_A + ':1' };
  const item = { pidtor_nextgen: true, pidtor_variant: v, pidtor_audio_key: 'old',
    pidtor_audio_options: [{ key: 'new', title: 'LostFilm', order: 1, track: audio('LostFilm', 2), variant: v }] };
  env.activate(item);
  env.client.buildAudioItems(item)[0].enabled = true;
  assert.equal(item.pidtor_audio_key, 'old');
  assert.equal(env.notices.length, 1, 'offer an external player instead of a silent failed switch');
});

test('direct playback also bypasses GS for a legacy URL without direct=true', () => {
  const env = environment();
  const url = env.client.sourceForPlayback('http://parser.test/lite/pidtor/s' + HASH_A + '?tsid=2&.m3u8', false);
  assert.equal(new URL(url).searchParams.get('direct'), 'true');
  assert.ok(!url.includes('.m3u8'));
  assert.equal(new URL(url).searchParams.has('raw'), false);
});

test('direct series does not display season-owned audio before exact-file verification', async () => {
  const env = environment({ deferProbes: true,
    data: { gst: false, variants: [variant('a', HASH_A, '1080p', [audio('Other episode', 99)])] } });
  env.component.launch(env.data, { number: 1 }); await drain();
  assert.equal(env.played[0].pidtor_audio_options.length, 0);
  env.pending.shift().finish({ streams: streams('This episode', 2) }); await drain();
  assert.equal(env.played[0].pidtor_audio_options[0].title, 'This episode');
  assert.equal(env.played[0].pidtor_audio_ffprobe_index, 2);
});

test('different named Russian AVO/DVO labels remain distinct', () => {
  const env = environment();
  const v = variant('a', HASH_A, '1080p', [audio('AVO Gavrilov'), audio('AVO Gaevsky', 2), audio('DVO BBC Saint-Petersburg', 3)]);
  const choices = env.client.mergedTrackChoices({ variant: v }, 'audio');
  assert.deepEqual(plain(choices.map(x => x.title)), ['AVO Gavrilov', 'AVO Gaevsky', 'DVO BBC Saint-Petersburg']);
});

test('duplicate physical tracks remain selectable with independent resume identities', () => {
  const env = environment();
  const v = variant('a', HASH_A, '1080p', [audio('Dub', 1), audio('Dub', 2, 'dts', 8), audio('Dub', 3)]);
  const choices = env.client.mergedTrackChoices({ variant: v }, 'audio');
  assert.equal(choices.length, 3);
  assert.equal(new Set(choices.map(env.client.choiceIdentity)).size, 3);
  const options = env.component.trackResolvers({ key: '1080p', variant: v }, 1, 'audio');
  assert.equal(env.client.preferredStoredChoice(options, options[2].key, options[0], true).track.stream_index, 3);
  assert.equal(env.client.preferredChoice(options, options[2], true).track.stream_index, 3);
});

test('matching choices share serial/movie resume identity and normalize language aliases', () => {
  const env = environment();
  const v = variant('a', HASH_A, '1080p', [audio('LostFilm')]);
  const c = env.client.mergedTrackChoices({ variant: v }, 'audio')[0];
  const serial = env.component.trackResolvers({ key: '1080p', variant: v }, 1, 'audio')[0];
  assert.equal(serial.key, '1080p|audio|' + env.client.choiceIdentity(c));
  const alias = { ...c, track: { ...c.track, language: 'ru' } };
  assert.equal(env.client.choiceIdentity(alias), env.client.choiceIdentity(c));
});

test('mixed known and probe_required variants stay visible in qualityOptions', () => {
  const env = environment();
  const known = variant('a', HASH_A); known.probe_required = false;
  const unknown = variant('b', HASH_B, '2160p');
  assert.deepEqual(plain(env.client.qualityOptions({ variants: [known, unknown] }).map(x => x.key)), ['2160p', '1080p']);
});

test('serial launch hydrates all available selected-quality files before building controls', async () => {
  const variants = [variant('a', HASH_A), variant('b', HASH_B), variant('c', HASH_C, '720p')];
  const env = environment({ data: { variants, gst: false }, episodes: url => [{ e: 1, s: 1, name: 'one.mkv', url: source(url.pathname.split('/').pop()) }] });
  const original = JSON.stringify(env.data);
  env.component.launch(env.data, { number: 1, s: 1, e: 1 });
  await drain();
  assert.equal(env.probes().length, 2);
  assert.ok(env.probes().every(x => !x.url.includes(HASH_C)));
  assert.equal(env.played.length, 1);
  assert.equal(env.played[0].pidtor_audio_options.length, 2, 'different hashes are not proven equivalent');
  assert.equal(env.played[0].pidtor_subtitle_options.length, 2);
  assert.equal(env.played[0].ffprobe.filter(x => x.codec_type === 'audio').length, 1);
  assert.equal(JSON.stringify(env.data), original);
  for (const call of env.probes()) {
    const url = new URL(call.url);
    assert.equal(url.searchParams.get('index'), '1');
    assert.equal(url.searchParams.get('tr'), 'udp://tracker.test:80/announce');
    assert.equal(url.searchParams.get('account_email'), 'fixture@example.test');
    assert.equal(url.searchParams.get('uid'), 'fixture-uid');
    assert.equal(url.searchParams.get('token'), 'fixture-token');
    assert.ok(call.timeout >= 90000, 'allow backend queue and cold /ffp timeout');
  }
});

test('exact-file probes cache and remain isolated across episodes and repeated launches', async () => {
  const env = environment({ probe: url => ({ streams: streams(url.searchParams.get('index') === '1' ? 'AVO Gavrilov' : 'AVO Gaevsky', url.searchParams.get('index') === '1' ? 1 : 4) }) });
  env.component.launch(env.data, { number: 1, s: 1, e: 1 }); await drain();
  env.component.launch(env.data, { number: 2, s: 1, e: 2 }); await drain();
  env.component.launch(env.data, { number: 1, s: 1, e: 1 }); await drain();
  assert.equal(env.probes().length, 2);
  assert.deepEqual(env.played.map(x => x.pidtor_audio_options[0]?.track.stream_index), [1, 4, 1]);
  assert.deepEqual(env.played.map(x => x.pidtor_audio_options[0]?.title), ['AVO Gavrilov', 'AVO Gaevsky', 'AVO Gavrilov']);
  assert.equal(env.data.variants[0].audio.length, 0);
  env.played[0].pidtor_variant.audio[0].title = 'modified only one item';
  assert.equal(env.played[2].pidtor_variant.audio[0].title, 'AVO Gavrilov');
});

test('failed resolution and background episode/card warming do not probe or prepare GST', async () => {
  const failed = environment({ episodes: false });
  failed.component.launch(failed.data, { number: 1 }); await drain();
  assert.equal(failed.probes().length, 0); assert.equal(failed.played.length, 0);
  const warm = environment({ gst: true });
  warm.component.warmEpisode(1, 0); warm.flushTimers(); await drain();
  warm.component.draw([{ e: 1 }]); await drain();
  warm.client.scheduleCardWarm({ id: 43, title: 'Movie', media_type: 'movie' }); warm.flushTimers(); await drain();
  assert.equal(warm.probes().length, 0); assert.equal(warm.played.length, 0);
});

test('cold episode resolution has time to return real files', async () => {
  const env = environment();
  const options = env.client.qualityOptions(env.data);
  env.component.resolveOption(options[0], 1, () => {}, () => {}); await drain();
  assert.ok(env.calls[0].timeout >= 30000);
});

test('movie launch probes the selected actual file before controls and preserves API cache', async () => {
  const v = variant('movie', HASH_A, '1080p', [audio('stale another file', 99)], false);
  v.source_file_key = HASH_A + ':9';
  const env = environment({ serial: false, data: { variants: [v], gst: false } });
  env.client.launchMovieDirect({ movie: env.movie }); await drain();
  assert.equal(env.probes().length, 1);
  assert.equal(env.played.length, 1);
  assert.equal(env.played[0].pidtor_audio_options[0].title, 'AVO Gavrilov');
  assert.equal(env.played[0].pidtor_audio_ffprobe_index, 1);
  assert.equal(env.data.variants[0].audio[0].stream_index, 99);
});

test('explicit quality change hydrates that quality and rebuilds tracks after resolution', async () => {
  const env = environment({ data: { variants: [variant('a', HASH_A), variant('b', HASH_B, '720p')], gst: false },
    episodes: url => [{ e: 1, s: 1, url: source(url.pathname.split('/').pop()) }],
    probe: url => ({ streams: streams(url.pathname.includes(HASH_A) ? 'AVO Gavrilov' : 'AVO Gaevsky') }) });
  const options = env.client.qualityOptions(env.data);
  const resolvers = env.component.optionResolvers(options, 1, options[0]);
  await resolve(resolvers[1]); await drain();
  assert.equal(env.probes().length, 1);
  assert.ok(env.probes()[0].url.includes(HASH_B));
  assert.equal(resolvers[1].audio_options[0]?.title, 'AVO Gaevsky');
});

test('probe concurrency is at most two and in-flight same-file requests are shared', async () => {
  const env = environment({ data: { variants: [variant('a', HASH_A), variant('b', HASH_B), variant('c', HASH_C)], gst: false },
    deferProbes: true, episodes: url => [{ e: 1, s: 1, url: source(url.pathname.split('/').pop()) }] });
  env.component.launch(env.data, { number: 1 }); env.component.launch(env.data, { number: 1 }); await drain();
  assert.equal(env.pending.length, 2);
  assert.equal(env.played.length, 1, 'only the latest launch starts, without waiting for shared metadata');
  env.pending.shift().finish({ streams: streams() }); await drain();
  assert.equal(env.pending.length, 2);
  while (env.pending.length) { env.pending.shift().finish({ streams: streams() }); await drain(); }
  assert.equal(env.probes().length, 3);
  assert.equal(env.maxProbes(), 2);
  assert.equal(env.played.length, 1);
});

test('failed series probe does not borrow season-owned audio from JacRed', async () => {
  const env = environment({ probe: () => ({ error: 'probe_failed' }) });
  env.component.launch(env.data, { number: 1 }); await drain();
  assert.equal(env.probes().length, 1); assert.equal(env.played.length, 1);
  assert.equal(env.played[0].pidtor_audio_options.length, 0);
  assert.equal(env.played[0].pidtor_subtitle_options.length, 0);
  const existing = environment({ data: { variants: [variant('a', HASH_A, '1080p', [audio('AVO Gavrilov')])], gst: false }, probe: () => ({ error: 'probe_failed' }) });
  existing.component.launch(existing.data, { number: 1 }); await drain();
  assert.equal(existing.played[0].pidtor_audio_options.length, 0);
});

test('unclassified playable variants remain visible as SD alongside known qualities', () => {
  const env = environment();
  const unknown = variant('b', HASH_B); unknown.video = {};
  assert.deepEqual(plain(env.client.qualityOptions({ variants: [variant('a', HASH_A), unknown] }).map(x => x.key)), ['1080p', 'SD']);
});

test('probe cache expires and evicts old exact files', async () => {
  const env = environment({ serial: false });
  function hydrate(index) {
    const v = variant('a', HASH_A, '1080p', [], false);
    return new Promise(done => env.client.hydrateResolved({ url: source(HASH_A, index), source_records: [{ url: source(HASH_A, index), variant: v }], episodes: [] }, done));
  }
  await hydrate(1); await hydrate(1);
  assert.equal(env.probes().length, 1);
  env.advance(5 * 60 * 1000 + 1); await hydrate(1);
  assert.equal(env.probes().length, 2);
  for (let index = 2; index <= 102; index++) await hydrate(index);
  await hydrate(1);
  assert.equal(env.probes().length, 104);
});

test('foreign and malformed file URLs cannot issue probes', async () => {
  const env = environment();
  const v = variant('a', HASH_A);
  const urls = [source(HASH_A).replace('parser.test', 'foreign.test'), source(HASH_A, 0), source(HASH_A, -1), source(HASH_A, '2bad')];
  for (const url of urls) await new Promise(done => env.client.hydrateResolved({ url, source_records: [{ url, variant: v }], episodes: [] }, done));
  assert.equal(env.probes().length, 0);
});

test('file records preserve structured replica trackers and contain no season-owned metadata', async () => {
  const env = environment();
  let resolved;
  env.component.resolveOption(env.client.qualityOptions(env.data)[0], 1, value => { resolved = value; }, () => {});
  await drain();
  assert.deepEqual(env.callbackErrors, []);
  assert.ok(resolved);
  const record = resolved.source_records[0];
  assert.equal(record.replica.trackers, 'tr=udp%3A%2F%2Ftracker.test%3A80%2Fannounce');
  assert.notEqual(record.variant, env.data.variants[0]);
  assert.notEqual(resolved.episodes[1].pidtor_variant, env.data.variants[0]);
});

test('playlist user launch hydrates the new exact episode before showing tracks', async () => {
  const env = environment({ probe: url => ({ streams: streams('Episode ' + url.searchParams.get('index'), Number(url.searchParams.get('index'))) }) });
  env.component.launch(env.data, { number: 1 }); await drain();
  const second = env.ctx.Lampa.PlayerPlaylist.get()[1];
  assert.equal(env.probes().length, 1);
  assert.equal(second.pidtor_audio_options.length, 0);
  env.ctx.closePlayerSelect = () => {};
  env.ctx.startPlaybackMonitor = () => {};
  env.ctx.installPlayerControls = () => {};
  env.ctx.replaceSource = (data, resolved, v) => { data.pidtor_variant = v; data.pidtor_source_url = resolved.url; };
  env.client.schedulePlayerControls(second); env.flushTimers(0); await drain();
  assert.equal(env.probes().length, 2);
  assert.equal(second.pidtor_audio_options[0].title, 'Episode 2');
  assert.equal(second.pidtor_audio_ffprobe_index, 2);
});

test('track change to another file with same variant id cannot select native track on old file', () => {
  const env = environment();
  const old = { id: 'shared', source_file_key: HASH_A + ':1' };
  const target = { id: 'shared', source_file_key: HASH_A + ':2' };
  let resolved = false, replaced = false;
  const choice = { title: 'Dub', key: 'second', track: audio('Dub', 4), order: 1, variant: target,
    resolve: done => { resolved = true; done({ url: source(HASH_A, 2), variant: target }); } };
  const item = { pidtor_nextgen: true, pidtor_variant: old, pidtor_audio_options: [choice] };
  env.ctx.replaceSource = () => { replaced = true; };
  env.ctx.installPlayerControls = () => {};
  env.activate(item);
  env.client.buildAudioItems(item)[0].enabled = true;
  assert.equal(resolved, true); assert.equal(replaced, true);
});

test('failed exact-file probe never exposes stale other-file video or audio', async () => {
  const v = variant('movie', HASH_A, '1080p', [audio('wrong file', 99)], false);
  v.source_file_key = HASH_A + ':9'; v.video.stream_index = 98; v.video.codec = 'hevc';
  const env = environment({ serial: false, data: { variants: [v], gst: false }, probe: () => ({ error: 'probe_failed', streams: [] }) });
  env.client.launchMovieDirect({ movie: env.movie }); await drain();
  assert.equal(env.played.length, 1);
  assert.equal(env.played[0].pidtor_audio_options.length, 0);
  assert.ok(!env.played[0].ffprobe.some(x => x.index === 98 || x.index === 99));
});

test('subtitles with known handler titles and forced disposition remain accurate', async () => {
  const env = environment({ probe: () => ({ streams: [
    ...streams().slice(0, 2),
    { index: 8, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'rus', handler_name: 'Russian' }, disposition: { forced: 1 } },
    { index: 9, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'rus', title: 'Full' } }
  ] }) });
  env.component.launch(env.data, { number: 1 }); await drain();
  assert.deepEqual(plain(env.played[0].pidtor_subtitle_options.map(x => x.title)), ['Forced', 'Full']);
});

test('playlist source updates cannot copy current file audio index onto another episode', async () => {
  const env = environment();
  env.component.launch(env.data, { number: 1 }); await drain();
  const first = env.played[0];
  const resolver = first.pidtor_quality_options[0];
  const resolved = await resolve(resolver);
  env.client.updatePlaylistSources(first, resolved);
  const second = env.ctx.Lampa.PlayerPlaylist.get()[1];
  assert.equal(new URL(second.url).searchParams.has('audio'), false);
  assert.equal(second.pidtor_audio_stream_index, -1);
  assert.equal(second.pidtor_variant.source_file_key, HASH_A + ':2');
});

test('background verified-quality resolvers target each playlist episode without probing', async () => {
  const env = environment({ data: { variants: [variant('a', HASH_A), variant('b', HASH_B, '720p')], gst: false },
    episodes: url => [1, 2].map(e => ({ e, s: 1, url: source(url.pathname.split('/').pop(), e) })) });
  env.component.launch(env.data, { number: 1 }); await drain();
  env.flushTimers(); await drain();
  assert.equal(env.probes().length, 1);
  const second = env.ctx.Lampa.PlayerPlaylist.get()[1];
  const quality = second.pidtor_quality_options.find(x => x.key === '720p');
  assert.ok(quality);
  const resolved = await resolve(quality);
  assert.equal(new URL(resolved.url).searchParams.get('tsid'), '2');
  assert.equal(new URL(env.probes()[1].url).searchParams.get('index'), '2');
});

test('direct launch does not enter the old GST source verifier', async () => {
  const env = environment({ gst: true, data: { variants: [variant('a', HASH_A), variant('b', HASH_B)], gst: true },
    episodes: url => [{ e: 1, s: 1, name: 'one.mkv', url: source(url.pathname.split('/').pop()) }] });
  env.ctx.window.lampac_pidtor_gst_ready = true;
  const verified = [];
  env.ctx.prepareGstReplica = (sources, _, __, done) => {
    verified.push(sources[0]);
    if (sources[0].includes(HASH_A)) done(null, '', sources);
    else done({ id: 'healthy', hls: 'http://parser.test/gst/1/hls.m3u8' }, sources[0], sources);
  };
  env.component.launch(env.data, { number: 1 }); await drain();
  assert.equal(verified.length, 0);
  assert.equal(env.played.length, 1);
  assert.equal(env.played[0].pidtor_variant.source_file_key, HASH_A + ':1');
  assert.equal(env.probes().length, 2, 'fallback reuses hydrated file probes');
});

test('dead-source verifier rejects failed replicas before accepting healthy one', () => {
  const env = environment();
  const requests = [];
  env.ctx.warmGstSource = (source, _, done) => { requests.push(source); done(source === 'healthy' ? { id: 'ready' } : null); };
  let result;
  env.client.prepareGstReplica(['dead', 'healthy'], 0, 0, (json, selected) => { result = { json, selected }; });
  assert.deepEqual(requests, ['dead', 'healthy']);
  assert.equal(result.selected, 'healthy'); assert.equal(result.json.id, 'ready');
});

test('fast active file starts playback while remaining user-requested files update track choices', async () => {
  const env = environment({ data: { variants: [variant('a', HASH_A), variant('b', HASH_B), variant('c', HASH_C)], gst: false },
    deferProbes: true, episodes: url => [{ e: 1, s: 1, url: source(url.pathname.split('/').pop()) }] });
  env.component.launch(env.data, { number: 1 }); await drain();
  assert.equal(env.pending.length, 2);
  env.pending.shift().finish({ streams: streams('AVO Gavrilov') }); await drain();
  assert.equal(env.played.length, 1, 'do not wait for the full selected-quality batch');
  assert.equal(env.played[0].pidtor_audio_options.length, 1, 'pending files cannot invent choices');
  const initialKey = env.played[0].pidtor_audio_key;
  env.pending.shift().finish({ streams: streams('AVO Gaevsky') }); await drain();
  assert.equal(env.played[0].pidtor_audio_options.length, 2);
  assert.equal(env.played[0].pidtor_audio_key, initialKey);
  assert.equal(env.played[0].pidtor_variant.source_file_key, HASH_A + ':1');
});

test('chooser deadline bounds stalled batch and prevents late queued probes and metadata', async () => {
  const env = environment({ data: { variants: [variant('a', HASH_A), variant('b', HASH_B), variant('c', HASH_C)], gst: false },
    deferProbes: true, episodes: url => [{ e: 1, s: 1, url: source(url.pathname.split('/').pop()) }] });
  env.component.launch(env.data, { number: 1 }); await drain();
  env.advance(90001); env.flushTimers(90000); await drain();
  assert.equal(env.played.length, 1, 'deadline permits nonfabricated fallback');
  assert.equal(env.played[0].pidtor_audio_options.length, 0);
  while (env.pending.length) { env.pending.shift().finish({ streams: streams() }); await drain(); }
  assert.equal(env.probes().length, 2, 'do not start queued late files');
  assert.equal(env.played[0].pidtor_audio_options.length, 0, 'late response cannot change this chooser');
});

test('player transport metadata remains JSON serializable after progressive subscriptions', async () => {
  const env = environment(); env.component.launch(env.data, { number: 1 }); await drain();
  assert.doesNotThrow(() => JSON.stringify(env.played[0]));
});

test('resume prefers the stored exact source before progressive choices become available', async () => {
  const env = environment({ data: { variants: [variant('a', HASH_A), variant('b', HASH_B)], gst: false },
    episodes: url => [{ e: 1, s: 1, url: source(url.pathname.split('/').pop()) }] });
  env.component.launch(env.data, { number: 1 }); await drain();
  const stored = env.played[0].pidtor_audio_options.find(x => x.variant.source_file_key === HASH_B + ':1').key;
  env.component.launch(env.data, { number: 1 }, { pidtor_audio_key: stored }); await drain();
  assert.equal(env.played[1].pidtor_audio_key, stored);
  assert.equal(env.played[1].pidtor_variant.source_file_key, HASH_B + ':1');
  assert.equal(env.probes().length, 2);
});

test('queued probes use the remaining chooser deadline instead of a fresh 90 seconds', async () => {
  const env = environment({ data: { variants: [variant('a', HASH_A), variant('b', HASH_B), variant('c', HASH_C)], gst: false },
    deferProbes: true, episodes: url => [{ e: 1, s: 1, url: source(url.pathname.split('/').pop()) }] });
  env.component.launch(env.data, { number: 1 }); await drain();
  env.advance(80000); env.pending.shift().finish({ streams: streams() }); await drain();
  assert.equal(env.probes().length, 3);
  assert.ok(env.probes()[2].timeout <= 10000);
});

test('Russian named AVO labels survive normalization', () => {
  const env = environment();
  const titles = ['AVO \u0413\u0430\u0432\u0440\u0438\u043b\u043e\u0432', 'AVO \u0413\u0430\u0435\u0432\u0441\u043a\u0438\u0439'];
  const v = variant('a', HASH_A, '1080p', titles.map((title, i) => audio(title, i + 1)));
  assert.deepEqual(plain(env.client.mergedTrackChoices({ variant: v }, 'audio').map(x => x.title)), titles);
});

test('real track resolver switches native playback to the file owning that physical track', async () => {
  const env = environment({ data: { variants: [variant('a', HASH_A), variant('b', HASH_B)], gst: false },
    episodes: url => [{ e: 1, s: 1, url: source(url.pathname.split('/').pop()) }],
    probe: url => ({ streams: streams(url.pathname.includes(HASH_A) ? 'AVO Gavrilov' : 'AVO Gaevsky', url.pathname.includes(HASH_A) ? 1 : 3) }) });
  env.component.launch(env.data, { number: 1 }); await drain();
  const item = env.played[0];
  env.ctx.Lampa.PlayerVideo.destroy = () => {};
  env.ctx.Lampa.PlayerVideo.url = () => {};
  env.ctx.restorePosition = (_, done) => done();
  env.ctx.installPlayerControls = () => {};
  const track = item.pidtor_audio_options.findIndex(x => x.variant.source_file_key === HASH_B + ':1');
  env.client.buildAudioItems(item)[track].enabled = true;
  assert.equal(item.pidtor_variant.source_file_key, HASH_B + ':1');
  assert.equal(item.pidtor_audio_ffprobe_index, 3);
  assert.equal(new URL(item.pidtor_source_url).searchParams.get('audio'), '3');
  assert.equal(item.ffprobe.find(x => x.codec_type === 'audio').index, 3);
  assert.equal(env.probes().length, 2);
});

test('empty error streams preserve existing JacRed tracks during movie launch', async () => {
  const v = variant('movie', HASH_A, '1080p', [audio('AVO Gavrilov', 3)], false);
  const env = environment({ serial: false, data: { variants: [v], gst: false }, probe: () => ({ streams: [], error: 'probe_failed' }) });
  env.client.launchMovieDirect({ movie: env.movie }); await drain();
  assert.equal(env.played[0].pidtor_audio_options[0].track.stream_index, 3);
  assert.equal(env.played[0].pidtor_audio_options[0].title, 'AVO Gavrilov');
});

test('empty exact-file track choices clear previous player menus', () => {
  const env = environment();
  let audioMenu = ['old audio'], subtitleMenu = ['old subtitle'];
  env.ctx.Lampa.PlayerPanel = { setLevels() {}, setTracks: items => { audioMenu = items; }, setSubs: items => { subtitleMenu = items; } };
  const data = { pidtor_nextgen: true, pidtor_audio_options: [], pidtor_subtitle_options: [] };
  env.activate(data); env.client.installPlayerControls(data);
  assert.equal(audioMenu.length, 0); assert.equal(subtitleMenu.length, 0);
});

test('quality change selects subtitle identity from the same actual file as chosen audio', async () => {
  const env = environment();
  const a = variant('a', HASH_A), b = variant('b', HASH_B);
  let hydrated;
  await new Promise(done => env.client.hydrateResolved({ url: source(HASH_A), source_records: [
    { url: source(HASH_A), variant: a }, { url: source(HASH_B), variant: b }
  ], episodes: [] }, value => { hydrated = value; done(); }, value => { hydrated = value; }));
  await drain();
  const option = { key: '1080p', variant: hydrated.variant, resolve: done => done(hydrated) };
  option.audio_options = env.client.resolvedTrackChoices(option, hydrated, 'audio');
  option.subtitle_options = env.client.resolvedTrackChoices(option, hydrated, 'subtitles');
  const previous = option.audio_options.find(x => x.variant.source_file_key === HASH_B + ':1');
  const data = { pidtor_nextgen: true, pidtor_quality_key: '720p', pidtor_quality_options: [option],
    pidtor_audio_options: [previous], pidtor_audio_key: previous.key, pidtor_subtitle_options: [] };
  env.activate(data);
  env.ctx.replaceSource = () => {};
  env.client.buildQualityItems(data)[0].enabled = true;
  assert.equal(data.pidtor_audio_key, previous.key);
  assert.equal(data.pidtor_subtitle_key, option.subtitle_options.find(x => x.variant.source_file_key === HASH_B + ':1').key);
});

test('valid base32 btih roundtrips through exact-file probe and movie resume', async () => {
  const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const expectedFile = 'abcdefghijklmnopqrstuvwxyz234567:2';
  const v = variant('base32', base32, '1080p', [], false);
  v.replicas[0].stream_url = source(base32, 2);
  const env = environment({ serial: false, data: { variants: [variant('hex', HASH_A, '1080p', [], false), v], gst: false } });
  const file = env.client.sourceFile({ url: source(base32, 2), variant: v });
  assert.ok(file, 'base32 letters beyond f are legal btih');
  assert.equal(file.hash, 'abcdefghijklmnopqrstuvwxyz234567');
  assert.equal(file.key, expectedFile);
  assert.equal(file.replica.infohash, base32);
  env.client.launchMovieDirect({ movie: env.movie }); await drain();
  const choice = env.played[0].pidtor_audio_options.find(x => x.variant.source_file_key === expectedFile);
  assert.ok(choice);
  assert.equal(env.client.resumeSourceKey(choice.key), expectedFile);
  assert.equal(env.client.resumeSourceKey(choice.key.replace('abcdefghijklmnopqrstuvwxyz234567', base32)), expectedFile);
  env.client.launchMovieDirect({ movie: env.movie }, { pidtor_audio_key: choice.key }); await drain();
  assert.equal(env.played[1].pidtor_variant.source_file_key, expectedFile);
  assert.equal(env.played[1].pidtor_audio_key, choice.key);
  assert.equal(new URL(env.played[1].pidtor_source_url).searchParams.get('tsid'), '2');
  assert.equal(env.probes().length, 2, 'same exact base32 file reuses its cached probe');
  const probe = env.probes().find(x => x.url.includes('/probe/abcdefghijklmnopqrstuvwxyz234567'));
  assert.ok(probe);
  assert.equal(new URL(probe.url).searchParams.get('index'), '2');
  assert.equal(new URL(probe.url).searchParams.get('tr'), 'udp://tracker.test:80/announce');
});

test('malformed 32-character hashes cannot map source files or issue probes', async () => {
  const env = environment();
  const invalid = [
    '0123456789abcdef0123456789abcdef',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ234560',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ234561',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ234568',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ234569',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456_'
  ];
  for (const hash of invalid) {
    const url = source(hash, 2), v = variant('invalid', hash);
    assert.equal(env.client.sourceFile({ url, variant: v }), null, hash);
    await new Promise(done => env.client.hydrateResolved({ url, source_records: [{ url, variant: v }], episodes: [] }, done));
  }
  assert.equal(env.probes().length, 0);
});

test('resume source validation accepts only 40-hex or 32-base32 btih identities', () => {
  const env = environment();
  const key = hash => '1080p|audio|dub|ru|' + hash + ':2|1|ac3|6|dub|';
  assert.equal(env.client.resumeSourceKey(key(HASH_A)), HASH_A + ':2');
  assert.equal(env.client.resumeSourceKey(key('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')), 'abcdefghijklmnopqrstuvwxyz234567:2');
  for (const hash of ['0'.repeat(32), 'a'.repeat(33), 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), 'Z'.repeat(31) + '8']) {
    assert.equal(env.client.resumeSourceKey(key(hash)), '', hash);
  }
});

function realLampaQualityPanel() {
  const filename = path.join(__dirname, 'fixtures', 'lampa-panel.js');
  const text = fs.readFileSync(filename, 'utf8');
  const ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const code = ast.statements.filter(x => ts.isFunctionDeclaration(x) && ['setLevels', 'setQualitys'].includes(x.name.text))
    .map(x => x.getText(ast)).join('\n');
  const elem = { text() {}, toggleClass() {} };
  const panel = vm.createContext({ qualitys: false, Html: { elem: () => elem }, Utils: { qualityToText: x => x } });
  vm.runInContext(code, panel);
  return panel;
}

test('new anime player replaces real Lampa quality items belonging to the previous movie', () => {
  const env = environment(), panel = realLampaQualityPanel();
  env.ctx.Lampa.PlayerPanel = { setLevels: panel.setLevels, quality: panel.setQualitys, setTranslate() {}, setTracks() {}, setSubs() {} };
  const old = { pidtor_nextgen: true, pidtor_quality_key: '2160p', pidtor_quality_options: [
    { key: '2160p', variant: { id: 'movie' } }, { key: '1080p', variant: { id: 'movie' } }
  ] };
  const current = { pidtor_nextgen: true, pidtor_quality_key: '1080p', pidtor_quality_options: [
    { key: '1080p', variant: { id: 'anime' } }
  ] };
  env.activate(old); env.client.installPlayerControls(old);
  env.activate(current); env.client.installPlayerControls(current);
  assert.deepEqual(plain(panel.qualitys.map(x => x.title)), ['1080p']);
});

test('late old-movie quality resolution cannot replace the new anime video', () => {
  const env = environment(); let delayed; const urls = [];
  env.ctx.Lampa.PlayerVideo.destroy = () => {};
  env.ctx.Lampa.PlayerVideo.url = url => urls.push(url);
  env.ctx.restorePosition = (_, done) => done(); env.ctx.installPlayerControls = () => {};
  const old = { pidtor_nextgen: true, pidtor_quality_key: '1080p', pidtor_quality_options: [{
    key: '2160p', variant: { id: 'movie' }, audio_options: [], subtitle_options: [], resolve: done => { delayed = done; }
  }] };
  env.activate(old); env.client.buildQualityItems(old)[0].enabled = true;
  env.activate({ pidtor_nextgen: true, pidtor_quality_key: '1080p', card: { id: 209077 } });
  delayed({ url: source(HASH_A), sources: [source(HASH_A)], source_records: [], episodes: [], variant: { id: 'movie' } });
  assert.deepEqual(urls, [], 'late movie callback must not touch the current video element');
});

test('old controls cannot replace the active anime audio menu', () => {
  const env = environment(); let menu;
  env.ctx.Lampa.PlayerPanel.setTracks = value => { menu = value; };
  const current = { pidtor_nextgen: true, pidtor_audio_options: [{ key: 'anime', title: 'AniLibria', track: audio('AniLibria'), variant: {}, order: 0 }] };
  env.activate(current); env.client.installPlayerControls(current);
  env.client.installPlayerControls({ pidtor_nextgen: true, pidtor_audio_options: [] });
  assert.deepEqual(plain(menu.map(x => x.label)), ['AniLibria']);
});

test('native empty tracks event does not erase PidTor verified AniLibria choices', () => {
  const env = environment(); let menu;
  env.ctx.Lampa.PlayerPanel.setTracks = value => { menu = value; };
  const current = { pidtor_nextgen: true, pidtor_audio_options: [{ key: 'anime', title: 'AniLibria', track: audio('AniLibria'), variant: {}, order: 0 }] };
  env.activate(current); env.client.installPlayerControls(current);
  const filename = path.join(__dirname, 'fixtures', 'lampa-player.js');
  const text = fs.readFileSync(filename, 'utf8');
  const ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS); let handler;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'Video.listener.follow'
        && node.arguments[0]?.text === 'tracks') handler = node.arguments[1].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(handler, 'extract the actual native tracks handler');
  vm.runInNewContext('(' + handler + ')({tracks: []})', { work: current, Panel: env.ctx.Lampa.PlayerPanel });
  assert.deepEqual(plain(menu.map(x => x.label)), ['AniLibria']);
});

test('playlist source updates never rewrite a different title with the same episode number', () => {
  const env = environment();
  const other = { pidtor_nextgen: true, card: { id: 209077, media_type: 'tv', title: 'Undead Unluck' }, season: 1, episode: 2, url: source(HASH_B, 2) };
  env.ctx.Lampa.Player.playlist([other]);
  const old = { pidtor_nextgen: true, card: { id: 247718, media_type: 'tv', title: 'MobLand' }, season: 1, episode: 2, url: source(HASH_A, 2) };
  env.client.updatePlaylistSources(old, { episodes: [{ e: 2, url: source(HASH_A, 2) }] });
  assert.equal(other.url, source(HASH_B, 2));
});

test('default direct copy prefers known Russian audio over a higher-seeded raw copy with the same codec', () => {
  const raw = variant('raw', HASH_A, '1080p', [{ ...audio('Japanese'), language: 'jpn' }]); raw.replicas[0].seeders = 40;
  const dub = variant('dub', HASH_B, '1080p', [audio('AniLibria')]); dub.replicas[0].seeders = 18;
  const env = environment({ data: { variants: [raw, dub] } });
  assert.equal(env.client.defaultQuality(env.client.qualityOptions(env.data)).variant.id, 'dub');
});

test('ffprobe AniLibira typo retains the canonical AniLibria menu label', () => {
  const env = environment();
  const v = variant('a', HASH_A, '1080p', [audio('AniLibira.TV')]);
  assert.equal(env.client.mergedTrackChoices({ variant: v }, 'audio')[0].title, 'AniLibria');
});

test('old loadeddata restoration cannot seek the next playback', () => {
  const env = environment(); let loaded; const seeks = [];
  const old = { pidtor_nextgen: true }; env.activate(old);
  const video = { currentSrc: 'old', readyState: 0, duration: NaN, currentTime: 0 };
  env.ctx.Lampa.PlayerVideo.video = () => video;
  env.ctx.Lampa.PlayerVideo.to = seconds => seeks.push(seconds);
  env.ctx.Lampa.PlayerVideo.listener = { follow: (_, fn) => { loaded = fn; }, remove() {} };
  let completed = false;
  env.client.restorePosition(5000, () => { completed = true; }, 'old', old);
  env.activate({ pidtor_nextgen: true });
  Object.assign(video, { currentSrc: 'anime', readyState: 4, duration: 1435, currentTime: 12 });
  loaded();
  assert.equal(video.currentTime, 12);
  assert.deepEqual(seeks, []);
  assert.equal(completed, false);
});

test('late movie catalog response cannot replace the newly requested episode', async () => {
  const env = environment({ deferV2: true, deferEpisodes: true });
  env.client.launchMovieDirect({ movie: { id: 100, title: 'Old movie', media_type: 'movie' } });
  const movieRequest = env.calls.find(x => x.url.includes('/v2?'));
  env.component.launch(env.data, { number: 2 });
  env.calls.find(x => x.url.includes('/episodes/')).complete({ data: [{ e: 2, s: 1, name: 'anime.mkv', url: source(HASH_B, 2) }] });
  await drain();
  movieRequest.complete({ variants: [variant('movie', HASH_A, '1080p', [], false)] });
  await drain();
  assert.equal(env.played.length, 1);
  assert.equal(env.played[0].episode, 2);
});

test('coalesced episode catalog callbacks launch only the latest requested episode', async () => {
  const env = environment({ deferV2: true });
  env.component.playEpisode({ number: 1 });
  env.component.playEpisode({ number: 2 });
  const catalogs = env.calls.filter(x => x.url.includes('/v2?'));
  assert.equal(catalogs.length, 1);
  catalogs[0].complete(env.data); await drain();
  assert.equal(env.played.length, 1);
  assert.equal(env.played[0].episode, 2);
});

test('server JSON omitting zero index on the first stream still publishes AniLibria', async () => {
  const response = streams('AniLibria'); delete response[0].index;
  const env = environment({ probe: () => ({ streams: response }) });
  env.component.launch(env.data, { number: 2 }); await drain();
  assert.equal(env.played[0].pidtor_audio_options[0]?.title, 'AniLibria');
  assert.equal(env.played[0].ffprobe[0].index, 0);
  assert.equal('index' in response[0], false, 'do not mutate shared network response');
});

test('missing nonzero stream index is not fabricated from array position', async () => {
  const response = streams('Wrong index'); delete response[1].index;
  const env = environment({ probe: () => ({ streams: response }) });
  env.component.launch(env.data, { number: 2 }); await drain();
  assert.equal(env.played[0].pidtor_audio_options.length, 0);
});

test('cached next-episode resolution cannot replace video inside Lampa start event', () => {
  const env = environment(); let insideStart = true; const changes = [];
  env.ctx.replaceSource = () => { changes.push(insideStart); };
  const v = variant('a', HASH_A);
  const option = { key: '1080p', variant: v, audio_options: [], subtitle_options: [], resolve: done => done({
    variant: v, url: source(HASH_A), source_records: [{ variant:v, url:source(HASH_A) }], tracks_ready: true
  }) };
  const data = { pidtor_nextgen:true, pidtor_tracks_ready:false, pidtor_quality_key:'1080p', pidtor_quality_options:[option] };
  env.client.schedulePlayerControls(data);
  insideStart = false;
  env.flushTimers(0);
  assert.deepEqual(changes, [false], 'core must finish its own Video.url call before a resolved source is installed');
});

test('finishing old episode tracks does not cancel a newer pending movie request', async () => {
  const env = environment({ deferV2:true }); let done;
  const v = variant('old', HASH_A);
  env.ctx.replaceSource = () => {};
  const option = { key:'1080p', variant:v, audio_options:[], subtitle_options:[], resolve: callback => { done = callback; } };
  const old = { pidtor_nextgen:true, pidtor_tracks_ready:false, pidtor_quality_key:'1080p', pidtor_quality_options:[option] };
  env.client.schedulePlayerControls(old); env.flushTimers(0);
  env.client.launchMovieDirect({ movie:{id:100, title:'New movie', media_type:'movie'} });
  done({ variant:v, url:source(HASH_A), source_records:[], tracks_ready:true });
  env.calls.find(x=>x.url.includes('/v2?')).complete({ variants:[variant('new', HASH_B, '1080p', [], false)] });
  await drain();
  assert.equal(env.played.length, 1);
  assert.equal(env.played[0].card.id, 100);
});

test('old stall-close timeout does not close the next player', () => {
  const env = environment(); let tick; let closed = 0;
  env.ctx.setInterval = fn => { tick = fn; return 10; };
  env.ctx.Lampa.Player.opened = () => true;
  env.ctx.Lampa.Player.close = () => { closed++; };
  const old = { pidtor_nextgen:true, pidtor_quality_key:'1080p', pidtor_quality_options:[] };
  env.activate(old); env.client.startPlaybackMonitor(old);
  env.advance(16000); tick();
  env.activate({ pidtor_nextgen:true }); env.flushTimers(500);
  assert.equal(closed, 0);
});

test('returning to a pending playlist item restarts its current resolution', () => {
  const env = environment(); const callbacks = [];
  const v = variant('a', HASH_A);
  env.ctx.replaceSource = () => {};
  const option = { key:'1080p', variant:v, audio_options:[], subtitle_options:[], resolve: callback => { callbacks.push(callback); } };
  const a = { pidtor_nextgen:true, pidtor_tracks_ready:false, pidtor_quality_key:'1080p', pidtor_quality_options:[option] };
  env.client.schedulePlayerControls(a); env.flushTimers(0);
  env.client.schedulePlayerControls({ pidtor_nextgen:true, pidtor_tracks_ready:true, pidtor_quality_options:[] });
  env.client.schedulePlayerControls(a); env.flushTimers(0);
  assert.equal(callbacks.length, 2);
  callbacks[0]({ variant:v, url:source(HASH_A), source_records:[], tracks_ready:true });
  assert.equal(a.pidtor_tracks_ready, false);
  callbacks[1]({ variant:v, url:source(HASH_A), source_records:[], tracks_ready:true });
  assert.equal(a.pidtor_tracks_ready, true);
});

function monitoredPlayer() {
  const env = environment();
  const intervals = new Map();
  let intervalId = 0;
  const video = { currentTime: 200, currentSrc: source(HASH_A), readyState: 4, paused: false, seeking: false, ended: false };
  env.ctx.setInterval = fn => { const id = ++intervalId; intervals.set(id, fn); return id; };
  env.ctx.clearInterval = id => intervals.delete(id);
  env.ctx.Lampa.PlayerVideo.video = () => video;
  env.ctx.Lampa.PlayerVideo.destroy = () => {};
  env.ctx.Lampa.PlayerVideo.url = url => { video.currentSrc = url; video.currentTime = 0; video.readyState = 0; };
  env.ctx.restorePosition = () => {};
  const data = { pidtor_nextgen: true, pidtor_use_gst: false, pidtor_source_url: source(HASH_A),
    pidtor_source_urls: [source(HASH_A)], url: source(HASH_A), pidtor_quality_key: '1080p', pidtor_quality_options: [] };
  env.activate(data);
  return { env, video, data, tick: () => [...intervals.values()].forEach(fn => fn()) };
}

test('a source replacement gets its own first-frame timeout', () => {
  const { env, video, data, tick } = monitoredPlayer();
  env.client.startPlaybackMonitor(data); tick();
  env.advance(12000);
  env.client.replaceSource(data, { url: source(HASH_B), sources: [source(HASH_B)] }, variant('b', HASH_B));
  env.advance(2400); tick();
  assert.deepEqual(env.notices, [], 'previous stream deadline must not abort a new source');
  env.advance(10300); video.readyState = 4; video.currentTime = 200.5; tick();
  assert.deepEqual(env.notices, [], 'first frame at 12.7 seconds must keep the selected source');
  assert.ok(video.currentSrc.includes(HASH_B));
});

test('zero playhead without a first frame is not playback progress', () => {
  const { env, video, data, tick } = monitoredPlayer();
  video.currentTime = 0; video.readyState = 0;
  env.client.startPlaybackMonitor(data); tick();
  env.advance(14500); tick();
  assert.deepEqual(env.notices, [], 'cold direct startup has its full 15-second budget');
  env.advance(500); tick();
  assert.equal(env.notices.length, 1, 'a truly stalled cold source still fails over');
});

test('a stalled stream after actual frame progress still triggers recovery', () => {
  const { env, data, tick } = monitoredPlayer();
  env.client.startPlaybackMonitor(data); tick();
  env.advance(14000); tick();
  assert.equal(env.notices.length, 1);
});

test('a deliberately paused decoded video is not a stalled stream', () => {
  const { env, video, data, tick } = monitoredPlayer();
  env.client.startPlaybackMonitor(data); tick(); video.paused = true;
  env.advance(60000); tick();
  assert.deepEqual(env.notices, []);
});

async function run() {
  const results = [];
  for (const { name, run } of tests) {
    let timeout;
    testEnvironments = [];
    try {
      await Promise.race([Promise.resolve().then(run), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('client callback did not settle')), 1000); })]);
      for (const env of testEnvironments) assert.deepEqual(env.callbackErrors, [], 'unexpected asynchronous client exception');
      results.push({ name, status: 'PASS' });
    }
    catch (error) { results.push({ name, status: 'FAIL', error: error.message, stack: error.stack.split('\n').slice(0, 4).join('\n') }); }
    finally { clearTimeout(timeout); }
  }
  return { passed: results.filter(x => x.status === 'PASS').length, failed: results.filter(x => x.status === 'FAIL').length, results };
}
module.exports = { run, environment, variant, streams, source, audio, drain, resolve, HASH_A, HASH_B, HASH_C };
if (require.main === module) run().then(result => { console.log(JSON.stringify(result, null, 2)); process.exitCode = result.failed ? 1 : 0; });
