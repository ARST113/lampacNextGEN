'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {harness, server, clone, group} = require('./helpers/lampa-sync-harness');
const storage = 'Modules/Sync/Sync/plugins/sync_v2/sync.js';
const favorite = 'Modules/Sync/Sync/plugins/bookmark.js';
const timecode = 'Modules/Sync/TimeCode/plugin.js';
const events = 'Modules/Sync/Sync/plugins/sync_v2/invc-ws.js';
const movie = {id: 42, name: 'Synthetic series'};
const history = {schema: 1, cards: {'tmdb:42': {last_mode: 'online', modes: {online: {updated_at: 20, progress: {time: 321}, episode: {season: 1, episode: 3}, online: {balanser: 'phantom'}}}}}};
function client(initial, remote) {
    const f = harness({initial: Object.assign({lampac_unic_id: 'login-a', activity: {movie}}, initial), server: remote});
    [storage, favorite, timecode].forEach(file => f.load(file, '', true)); f.flush(); return f;
}
function select(f, key) { f.context.LampacSync.setPassword(key); f.flush(); }
function requests(f, path) { return f.requests.filter(req => new URL(req.url).pathname === path && !req.aborted); }
function completed(f, path) { const req = requests(f, path).at(-1); assert.ok(req, 'request for ' + path); return req; }

test('history exports saved provider, next episode and progress through the selected password', () => {
    const f = client(); select(f, 'code-b');
    f.Lampa.Storage.set('lampac_resume_history_v1', history); f.flush();
    const req = completed(f, '/storage/set');
    assert.equal(new URL(req.url).searchParams.get('token'), 'login-a');
    assert.equal(new URL(req.url).searchParams.get('sync_id'), 'code-b');
    assert.deepEqual(f.server.documents.get(group('code-b') + '::sync_view').data.lampac_resume_history_v1, history);
});

test('a second client receives history, bookmark categories and playback timecodes under one password', () => {
    const remote = server(); const a = client({}, remote); select(a, 'code-b');
    a.Lampa.Storage.set('lampac_resume_history_v1', history);
    a.Lampa.Favorite.add('book', movie);
    a.Lampa.Timeline.listener.send('update', {data: {hash: 'episode-3', road: {time: 321, duration: 900, percent: 35}}}); a.flush();
    const b = client({lampac_unic_id: 'login-b'}, remote); select(b, 'code-b');
    b.Lampa.Listener.send('full', {type: 'complite'}); b.flush();
    assert.deepEqual(b.values.lampac_resume_history_v1, history);
    assert.deepEqual(b.values.favorite.book, [42]);
    assert.equal(b.values.file_view['episode-3'].time, 321);
    assert.equal(new URL(completed(a, '/bookmark/add').url).searchParams.get('sync_id'), 'code-b');
    assert.equal(new URL(completed(a, '/timecode/add').url).searchParams.get('sync_id'), 'code-b');
});

test('default modules loaded first adopt a later token-bearing plugin without duplicate transports', () => {
    const f = client();
    f.load(storage, 'login-b', true); f.load(timecode, '', true); f.load(favorite, '', true); f.flush();
    f.Lampa.Favorite.add('book', movie);
    f.Lampa.Timeline.listener.send('update', {data: {hash: 'episode-3', road: {time: 15}}}); f.flush();
    assert.equal(requests(f, '/bookmark/add').length, 1);
    assert.equal(requests(f, '/timecode/add').length, 1);
    assert.equal(new URL(completed(f, '/bookmark/add').url).searchParams.get('token'), 'login-b');
    assert.equal(new URL(completed(f, '/timecode/add').url).searchParams.get('token'), 'login-b');
});

test('manual password survives later default and token-bearing modules', () => {
    const f = client(); select(f, 'code-b');
    [storage, favorite, timecode].forEach(file => f.load(file, 'link-a', true)); f.flush();
    f.Lampa.Favorite.add('watch', movie); f.flush();
    assert.equal(f.context.LampacSync.uid(), group('code-b'));
    assert.equal(new URL(completed(f, '/bookmark/add').url).searchParams.get('sync_id'), 'code-b');
});

test('a new account is not seeded with old viewing history or bookmarks', () => {
    const f = client({lampac_resume_history_v1: history, favorite: {card: [movie], book: [42]}});
    select(f, 'code-b');
    assert.equal(Object.keys(f.server.documents.get(group('code-b') + '::sync_view').data.lampac_resume_history_v1.cards).length, 0);
    assert.deepEqual(f.server.documents.get(group('code-b') + '::sync_view').data.online_view, []);
    assert.deepEqual(f.server.documents.get(group('code-b') + '::sync_view').data.torrents_view, []);
    assert.equal(f.server.bookmarks.has(group('code-b') + ':'), false);
    f.context.LampacSync.useLogin(); f.flush();
    assert.deepEqual(f.values.lampac_resume_history_v1, history);
    assert.deepEqual(f.values.favorite.book, [42]);
});

test('denied bookmark responses cannot replace local favorites', () => {
    const f = client({favorite: {card: [movie], book: [42]}});
    const before = clone(f.values.favorite);
    f.Lampa.Listener.send('lampac', {name: 'bookmark_pullFromServer'});
    completed(f, '/bookmark/list').respond(200, {accsdb: true, msg: 'denied'});
    assert.deepEqual(f.values.favorite, before);
});

test('a delayed import from a previous account cannot change any active local data', () => {
    const f = client();
    f.context.LampacSync.refresh();
    f.pending.at(-1).respond(200, {success: true, user_uid: 'alpha'});
    const old = f.pending.filter(req => !req.aborted && new URL(req.url).pathname !== '/sync/account').slice(-3);
    select(f, 'code-b');
    const before = f.state();
    old.forEach(req => req.respond(200, new URL(req.url).pathname === '/storage/get'
        ? {success: true, fileInfo: {changeTime: 5000}, data: JSON.stringify({lampac_resume_history_v1: history})}
        : {card: [movie], book: [42]}, true));
    assert.deepEqual(f.values.favorite, before.favorite);
    assert.deepEqual(f.values.lampac_resume_history_v1, before.lampac_resume_history_v1);
});

test('default-profile events are ignored while a different profile is active', () => {
    const f = client({lampac_profile_id: 'kids'}); const count = f.requests.length;
    f.event('storage', {path: 'sync_view', pathfile: ''});
    f.event('bookmark', {type: 'set', profile_id: '', data: [{where: 'book', data: [42]}]});
    assert.equal(f.requests.length, count);
    assert.equal(((f.values.favorite || {}).book || []).length, 0);
});

test('events belonging to another account cannot import its history or bookmarks', () => {
    const f = client(); const count = f.requests.length;
    f.event('storage', {path: 'sync_view', pathfile: ''}, 'beta');
    f.event('bookmark', {type: 'set', profile_id: '', data: {where: 'book', data: [42]}}, 'beta');
    assert.equal(f.requests.length, count);
    assert.equal(((f.values.favorite || {}).book || []).length, 0);
});

test('bookmark added events are handled and malformed socket payloads are ignored', () => {
    const f = client(); let applied = 0;
    f.Lampa.Favorite.listener.follow('add', () => { applied++; });
    f.event('bookmark', {type: 'added', profile_id: '', data: {where: 'book', card: movie}});
    assert.equal(applied, 1);
    assert.doesNotThrow(() => f.event('bookmark', '{invalid-json'));
});

test('timecode form data survives reserved characters and ignores malformed stored rows', () => {
    const f = client(); select(f, 'code-b');
    f.Lampa.Timeline.listener.send('update', {data: {hash: 'id + & =', road: {time: 45}}}); f.flush();
    const codes = f.server.timecodes.get(group('code-b') + '::42_tv');
    assert.equal(JSON.parse(codes['id + & =']).time, 45);
    codes.corrupt = '{';
    f.Lampa.Listener.send('full', {type: 'complite'});
    assert.doesNotThrow(() => f.flush());
    assert.equal(f.values.file_view['id + & ='].time, 45);
});

test('changing accounts recreates only the synchronization socket and rejects old events', () => {
    const f = client(); const online = {socket: {close() { online.closed = true; }}, closed: false};
    f.context.nwsClient = {'fixture.lampac': online};
    f.context.rch_nws = {'fixture.lampac': {Registry() {}}};
    f.load(events, '', true); f.flush();
    const old = f.sockets.at(-1);
    assert.equal(online.closed, false);
    assert.notEqual(new URL(old.url).searchParams.get('id'), 'playback-device');
    assert.ok(old.calls.some(args => args[0] === 'RegistryEvent' && args[1] === 'alpha'));
    select(f, 'code-b');
    const current = f.sockets.at(-1);
    assert.equal(old.closed, true);
    assert.notEqual(old, current);
    assert.notEqual(new URL(old.url).searchParams.get('id'), new URL(current.url).searchParams.get('id'));
    assert.equal(online.closed, false);
    assert.ok(current.calls.some(args => args[0] === 'RegistryEvent' && args[1] === group('code-b')));
    const count = f.requests.length;
    old.emit('event', 'alpha', 'storage', JSON.stringify({path: 'sync_view', pathfile: ''}));
    assert.equal(f.requests.length, count);
});
