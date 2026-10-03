'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {harness, clone, group} = require('./helpers/lampa-sync-harness');
const history = {schema: 1, cards: {'tmdb:42': {aliases: ['tmdb:42'], last_mode: 'online', modes: {online: {updated_at: 20, progress: {time: 321}, episode: {season: 1, episode: 2}, online: {balanser: 'phantom'}}}}}};

function account(fixture) {
    assert.ok(fixture.context.LampacSync, 'the synchronization modules must share an account runtime');
    return fixture.context.LampacSync;
}
function ready(initial) {
    const f = harness({initial}); f.loadAccount(); account(f); f.flush(); return f;
}
function change(f, password) {
    let result; account(f).setPassword(password, error => { result = error || null; }); f.flush(); return result;
}

test('automatic login provides one synchronization account and preserves legacy local history', () => {
    const f = ready({lampac_unic_id: 'login-a', lampac_resume_history_v1: history});
    assert.equal(account(f).ready(), true);
    assert.equal(account(f).uid(), 'alpha');
    assert.equal(account(f).status().source, 'login');
    assert.deepEqual(f.values.lampac_resume_history_v1, history);
    const check = new URL(f.requests[0].url);
    assert.equal(check.pathname, '/sync/account');
    assert.equal(check.searchParams.get('token'), 'login-a');
});

test('all module prefixes add exactly one Lampac section inside Synchronization settings', () => {
    const f = ready(); f.loadAccount('link-a'); f.loadAccount(); f.flush();
    const titles = f.settings.filter(item => item.param.type === 'title' && item.field.name === 'Синхронизация Lampac');
    assert.equal(titles.length, 1);
    assert.equal(titles[0].component, 'account');
    assert.ok(f.settings.some(item => item.param.name === 'lampac_sync_password_action'));
    assert.ok(f.settings.some(item => item.param.name === 'lampac_sync_login_action'));
    assert.ok(f.settings.some(item => item.param.name === 'lampac_sync_refresh_action'));
    assert.equal(JSON.stringify(f.settings).includes('login-a'), false);
});

test('any custom ID keeps its namespace when login changes and survives a restart', () => {
    const f = ready(); assert.equal(change(f, 'code-b'), null);
    f.Lampa.Storage.set('lampac_unic_id', 'login-a'); f.flush();
    assert.equal(account(f).uid(), group('code-b'));
    assert.equal(account(f).status().source, 'manual');
    const restarted = harness({initial: f.state(), server: f.server});
    restarted.loadAccount('link-a'); restarted.loadAccount(); restarted.flush();
    assert.equal(account(restarted).uid(), group('code-b'));
    assert.equal(account(restarted).status().source, 'manual');
});

test('a custom code does not bypass a failed Lampac login', () => {
    const f = ready({lampac_unic_id: 'login-a', account_email: 'alias-a', lampac_resume_history_v1: history});
    const before = clone(f.values);
    delete f.server.identities['alias-a'];
    assert.ok(change(f, 'shared-code'));
    const check = new URL(f.requests.at(-1).url);
    assert.equal(check.searchParams.get('token'), 'alias-a');
    assert.equal(check.searchParams.get('sync_id'), 'shared-code');
    assert.equal(check.searchParams.has('account_email'), false);
    assert.equal(check.searchParams.has('uid'), false);
    assert.equal(account(f).uid(), 'alpha');
    assert.equal(account(f).ready(), true);
    assert.deepEqual(f.values, before);
});

test('changing accounts preserves old local history without exposing it to a new owner', () => {
    const f = ready({lampac_unic_id: 'login-a', lampac_resume_history_v1: history, favorite: {book: [{id: 42}]}, file_view: {episode: {time: 321}}});
    assert.equal(change(f, 'code-b'), null);
    assert.equal(Object.keys(f.values.lampac_resume_history_v1.cards).length, 0);
    assert.deepEqual(f.values.favorite, {});
    assert.deepEqual(f.values.file_view, {});
    account(f).useLogin(); f.flush();
    assert.equal(account(f).uid(), 'alpha');
    assert.deepEqual(f.values.lampac_resume_history_v1, history);
    assert.deepEqual(f.values.favorite, {book: [{id: 42}]});
    assert.deepEqual(f.values.file_view, {episode: {time: 321}});
});

test('selecting the same custom ID retains its own history', () => {
    const f = ready({lampac_unic_id: 'login-a', lampac_resume_history_v1: history});
    assert.equal(change(f, 'code-a'), null);
    f.Lampa.Storage.set('lampac_resume_history_v1', history);
    assert.equal(change(f, 'code-a'), null);
    assert.deepEqual(f.values.lampac_resume_history_v1, history);
});

test('reset to automatic login follows the latest login identity', () => {
    const f = ready(); change(f, 'code-a');
    f.Lampa.Storage.set('lampac_unic_id', 'login-b'); f.flush();
    assert.equal(account(f).uid(), group('code-a'));
    account(f).useLogin(); f.flush();
    assert.equal(account(f).uid(), 'beta');
    assert.equal(account(f).status().source, 'login');
});

test('late password validation cannot replace a newer selection', () => {
    const f = ready(); const sync = account(f);
    sync.setPassword('code-a'); const old = f.pending.at(-1);
    sync.setPassword('code-b'); const current = f.pending.at(-1);
    current.respond(200, {success: true, user_uid: group('code-b')});
    old.respond(200, {success: true, user_uid: 'alpha'}, true);
    assert.equal(sync.uid(), group('code-b'));
});

test('account switches invalidate requests already issued by the previous owner', () => {
    const f = ready(); let imported = false;
    account(f).request('GET', '/storage/get?path=sync_view', null, () => { imported = true; });
    const old = f.pending.at(-1);
    account(f).setPassword('code-b'); const check = f.pending.at(-1);
    check.respond(200, {success: true, user_uid: 'beta'});
    old.respond(200, {success: true, data: JSON.stringify(history)}, true);
    assert.equal(imported, false);
    assert.equal(old.aborted, true);
});

test('Lampac profile changes isolate local data and restore the previous profile', () => {
    const f = ready({lampac_unic_id: 'login-a', lampac_resume_history_v1: history});
    f.Lampa.Storage.set('lampac_profile_id', 'kids'); f.flush();
    assert.equal(account(f).profile(), 'kids');
    assert.equal(Object.keys(f.values.lampac_resume_history_v1.cards).length, 0);
    f.Lampa.Storage.set('lampac_profile_id', ''); f.flush();
    assert.deepEqual(f.values.lampac_resume_history_v1, history);
});

test('the password settings action opens Lampa input without revealing the saved key', () => {
    const f = ready(); change(f, 'code-b');
    f.settings.find(item => item.param.name === 'lampac_sync_password_action').onChange();
    assert.equal(f.input.params.value, '');
    assert.equal(f.input.params.nosave, true);
    f.input.callback('code-a'); f.flush();
    assert.equal(account(f).uid(), group('code-a'));
});

test('selecting Lampac synchronization disables CUB sync while retaining its login', () => {
    const cub = {email: 'alias-a', token: 'cub-session', profile: {id: 7}};
    const f = ready({lampac_unic_id: 'login-a', account: cub, account_use: true});
    assert.equal(f.Lampa.Storage.field('account_use'), false);
    assert.deepEqual(f.values.account, cub);
});


test('empty or invalid codes retain the active ID and local history', () => {
    const f = ready({lampac_unic_id: 'login-a', lampac_resume_history_v1: history});
    const checks = f.requests.length;
    for (const code of ['', ' ', 'x'.repeat(129), 'bad\u0000code']) assert.ok(change(f, code));
    assert.equal(f.requests.length, checks);
    assert.equal(account(f).uid(), 'alpha');
    assert.deepEqual(f.values.lampac_resume_history_v1, history);
});

test('a storage failure rolls back the visible history and account selection', () => {
    const f = ready({lampac_unic_id: 'login-a', lampac_resume_history_v1: history});
    const set = f.Lampa.Storage.set.bind(f.Lampa.Storage);
    let fail = true;
    f.Lampa.Storage.set = (key, value, quiet) => {
        if (key === 'lampac_sync_owner_v1' && fail) { fail = false; throw new Error('Quota exceeded'); }
        set(key, value, quiet);
    };
    assert.ok(change(f, 'new-household'));
    assert.equal(account(f).uid(), 'alpha');
    assert.equal(account(f).status().source, 'login');
    assert.deepEqual(f.values.lampac_resume_history_v1, history);
    assert.equal(f.values.lampac_sync_id, '');
});

test('localStorage quota failures cannot discard the only copy of the previous history', () => {
    const f = ready({lampac_unic_id: 'login-a', lampac_resume_history_v1: history});
    const set = f.context.localStorage.setItem;
    f.context.localStorage.setItem = (key, value) => {
        if (key === 'lampac_sync_accounts_v1') throw new Error('Quota exceeded');
        set(key, value);
    };
    assert.ok(change(f, 'new-household'));
    assert.equal(account(f).uid(), 'alpha');
    assert.deepEqual(f.values.lampac_resume_history_v1, history);
});


test('entering an existing basic ID joins its original history without creating another namespace', () => {
    const f = ready({lampac_unic_id: 'login-a', lampac_resume_history_v1: history});
    assert.equal(change(f, 'alias-a'), null);
    assert.equal(account(f).uid(), 'alpha');
    assert.deepEqual(f.values.lampac_resume_history_v1, history);
});

test('new IDs and profiles retain native watched-list array operations', () => {
    const f = ready({lampac_unic_id: 'login-a', online_view: ['42'], torrents_view: ['torrent-42']});
    assert.equal(change(f, 'new-empty'), null);
    for (const key of ['online_view', 'torrents_view']) {
        const viewed = f.Lampa.Storage.cache(key, 5000, []);
        assert.ok(Array.isArray(viewed), key + ' must remain an array');
        assert.equal(viewed.indexOf('42'), -1);
        viewed.push('42');
        f.Lampa.Storage.set(key, viewed);
    }
    f.Lampa.Storage.set('lampac_profile_id', 'new-profile'); f.flush();
    assert.equal(f.Lampa.Storage.cache('online_view', 5000, []).indexOf('42'), -1);
    assert.equal(f.Lampa.Storage.cache('torrents_view', 5000, []).indexOf('42'), -1);
    f.context.LampacSync.useBaseId(); f.flush();
    f.Lampa.Storage.set('lampac_profile_id', ''); f.flush();
    assert.deepEqual(f.values.online_view, ['42']);
    assert.deepEqual(f.values.torrents_view, ['torrent-42']);
});

test('manual selection before initial validation still restores the original basic history', () => {
    const initial = {lampac_unic_id: 'login-a', lampac_resume_history_v1: history, online_view: ['42'], favorite: {book: [42]}};
    const f = harness({initial}); f.loadAccount();
    account(f).setId('family'); f.flush();
    assert.equal(account(f).uid(), group('family'));
    assert.deepEqual(f.values.lampac_resume_history_v1.cards, {});
    account(f).useBaseId(); f.flush();
    assert.equal(account(f).uid(), 'alpha');
    assert.deepEqual(f.values.lampac_resume_history_v1, history);
    assert.deepEqual(f.values.online_view, ['42']);
    assert.deepEqual(f.values.favorite, {book: [42]});
});

test('an initial manual alias of the basic ID preserves visible legacy history', () => {
    const f = harness({initial: {lampac_unic_id: 'login-a', lampac_resume_history_v1: history}});
    f.loadAccount(); account(f).setId('alias-a'); f.flush();
    assert.equal(account(f).uid(), 'alpha');
    assert.deepEqual(f.values.lampac_resume_history_v1, history);
});
