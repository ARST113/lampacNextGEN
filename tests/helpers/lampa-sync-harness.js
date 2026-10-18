'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..', '..');
const accountPath = path.join(root, 'Modules/Sync/Shared/sync-account.js');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const group = id => 'lampac-sync-' + crypto.createHash('sha256').update(id.trim()).digest('hex');

function emitter() {
    const handlers = [];
    return {
        follow(names, fn) { handlers.push({names: names.split(','), fn}); },
        remove(name, fn) { const index = handlers.findIndex(h => h.names.includes(name) && h.fn === fn); if (index >= 0) handlers.splice(index, 1); },
        send(name, data) { handlers.slice().filter(h => h.names.includes(name)).forEach(h => h.fn(data)); }
    };
}

function server() {
    const identities = {'login-a': 'alpha', 'alias-a': 'alpha', 'login-b': 'beta', 'link-a': 'alpha'};
    const documents = new Map();
    const bookmarks = new Map();
    const timecodes = new Map();
    let clock = 1000;
    return {
        identities, documents, bookmarks, timecodes,
        handle(request) {
            const url = new URL(request.url);
            const token = url.searchParams.get('token');
            let uid = identities[token] || identities[url.searchParams.get('account_email')] || identities[url.searchParams.get('uid')];
            if (!uid) return {status: 200, data: {accsdb: true, msg: 'Access denied'}};
            if (url.searchParams.has('sync_id')) {
                const id = url.searchParams.get('sync_id').trim();
                if (!id || id.length > 128 || /[\x00-\x1f\x7f-\x9f]/.test(id)) return {status: 400, data: {success: false, invalid_sync_id: true}};
                uid = identities[id.toLowerCase()] || Object.values(identities).find(value => value.toLowerCase() === id.toLowerCase()) || group(id);
            }
            const profile = url.searchParams.get('profile_id') || url.searchParams.get('pathfile') || '';
            const owner = uid + ':' + profile;
            const body = request.body && /^[\[{]/.test(request.body) ? JSON.parse(request.body) : null;
            if (url.pathname === '/sync/account') return {status: 200, data: {success: true, user_uid: uid}};
            if (url.pathname === '/reqinfo') return {status: 200, data: {user_uid: uid}};
            if (url.pathname === '/storage/get') {
                const doc = documents.get(owner + ':' + url.searchParams.get('path'));
                return {status: 200, data: doc ? {success: true, fileInfo: {changeTime: doc.time}, data: JSON.stringify(doc.data)} : {success: false, msg: 'outFile'}};
            }
            if (url.pathname === '/storage/set') {
                const doc = {data: body, time: ++clock};
                documents.set(owner + ':' + url.searchParams.get('path'), doc);
                return {status: 200, data: {success: true, fileInfo: {changeTime: doc.time}}};
            }
            if (url.pathname === '/bookmark/list') return {status: 200, data: clone(bookmarks.get(owner)) || {dbInNotInitialization: true}};
            if (url.pathname === '/bookmark/set') {
                const fav = clone(bookmarks.get(owner)) || {};
                (Array.isArray(body) ? body : [body]).forEach(item => { fav[item.where] = item.data; });
                bookmarks.set(owner, fav);
                return {status: 200, data: {success: true}};
            }
            if (/^\/bookmark\/(add|added|remove)$/.test(url.pathname)) {
                const fav = clone(bookmarks.get(owner)) || {};
                const list = fav[body.where] || [];
                const filtered = list.filter(id => String(id) !== String(body.card_id));
                fav.card = (fav.card || []).filter(card => String(card.id) !== String(body.card_id));
                if (!url.pathname.endsWith('/remove')) { filtered.unshift(body.card_id); fav.card.unshift(body.card); }
                fav[body.where] = filtered;
                bookmarks.set(owner, fav);
                return {status: 200, data: {success: true}};
            }
            if (url.pathname === '/timecode/all') return {status: 200, data: clone(timecodes.get(owner + ':' + url.searchParams.get('card_id'))) || {}};
            if (url.pathname === '/timecode/add') {
                const form = new URLSearchParams(request.body);
                const key = owner + ':' + url.searchParams.get('card_id');
                const codes = clone(timecodes.get(key)) || {};
                codes[form.get('id')] = form.get('data');
                timecodes.set(key, codes);
                return {status: 200, data: {success: true}};
            }
            return {status: 404, data: {success: false}};
        }
    };
}

function harness(options = {}) {
    const values = clone(options.initial || {lampac_unic_id: 'login-a'});
    const remote = options.server || server();
    const requests = [];
    const pending = [];
    const settings = [];
    const notices = [];
    const eventHandlers = {};
    const storageEvents = emitter();
    const storage = {
        get(key, fallback = '') { return key in values ? clone(values[key]) : clone(fallback); },
        set(key, value, quiet) { values[key] = clone(value); if (!quiet) storageEvents.send('change', {name: key, value: clone(value)}); },
        field(key) { const value = this.get(key, false); return value === 'true' || value === true; },
        cache(key, size, fallback) { return this.get(key, fallback); },
        listener: storageEvents
    };
    class Xhr {
        constructor() { this.headers = {}; this.readyState = 0; this.aborted = false; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(name, value) { this.headers[name.toLowerCase()] = value; }
        send(body) { this.body = body; requests.push(this); pending.push(this); }
        abort() { this.aborted = true; if (this.onabort) this.onabort(); }
        respond(status, data, force = false) {
            if (this.aborted && !force) return;
            this.status = status;
            this.responseText = typeof data === 'string' ? data : JSON.stringify(data);
            this.readyState = 4;
            if (this.onreadystatechange) this.onreadystatechange();
            if (this.onload) this.onload();
        }
    }
    const document = {
        addEventListener(name, fn) { (eventHandlers[name] ||= []).push(fn); },
        removeEventListener(name, fn) { eventHandlers[name] = (eventHandlers[name] || []).filter(item => item !== fn); },
        dispatchEvent(event) { (eventHandlers[event.type] || []).slice().forEach(fn => fn(event)); },
        createEvent() { return {initCustomEvent(type, bubbles, cancelable, detail) { this.type = type; this.detail = detail; }}; }
    };
    const Lampa = {
        Storage: storage, Listener: emitter(), Timeline: {listener: emitter()}, Player: {listener: emitter()},
        Settings: {listener: emitter()},
        SettingsApi: {addParam(item) { settings.push(item); }, getParam(component) { return settings.filter(item => item.component === component); }},
        Noty: {show(text) { notices.push(text); }},
        Favorite: {listener: emitter(), init() {}, read() {}, add(where, card) { this.listener.send('add', {where, card}); }, remove(where, card) { this.listener.send('remove', {where, card}); }},
        Arrays: {clone, isObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }, extend(value, defaults) { Object.keys(defaults).forEach(key => { if (!(key in value)) value[key] = defaults[key]; }); }},
        Utils: {addUrlComponent(url, part) { return url + (url.includes('?') ? '&' : '?') + part; }, uid() { return 'generated-device'; }, clearCard: clone,
            putScriptAsync(urls, fn) { if (fn) fn(); }, putScript(urls, fn, a, done) { if (done) done(); else if (fn) fn(); }},
        Input: {edit(params, callback) { result.input = {params, callback}; }},
        Controller: {toggle() {}}
    };
    Lampa.Reguest = function() {
        this.silent = (url, success, error, data) => {
            const xhr = new Xhr(); xhr.open(data ? 'POST' : 'GET', url);
            xhr.onreadystatechange = () => { if (xhr.readyState === 4 && success) success(JSON.parse(xhr.responseText)); };
            xhr.send(data ? new URLSearchParams(data).toString() : null);
        };
        this.clear = () => {};
    };
    const jquery = function() { throw new Error('DOM rendering belongs in browser acceptance'); };
    jquery.ajax = opts => {
        const xhr = new Xhr(); xhr.open(opts.type || 'GET', opts.url);
        xhr.onreadystatechange = () => { if (xhr.readyState === 4 && opts.success) opts.success(JSON.parse(xhr.responseText)); };
        xhr.send(opts.data || null); return xhr;
    };
    const sockets = [];
    class NativeWsClient {
        constructor(url, options) { this.url = url + '?id=' + storage.get('lampac_nws_id', 'playback-device') + '&ver=1'; this.options = options; this.handlers = emitter(); this.calls = []; this.closed = false; this.socket = {close: () => { this.closed = true; }}; sockets.push(this); }
        on(name, fn) { this.handlers.follow(name, args => fn(...args)); }
        invoke(...args) { this.calls.push(args); }
        connect() { this.emit('Connected', 'connection-' + sockets.indexOf(this)); }
        close() { this.closed = true; }
        emit(name, ...args) { this.handlers.send(name, args); }
    }
    const context = vm.createContext({Lampa, document, XMLHttpRequest: Xhr, NativeWsClient, $: jquery, console, setTimeout, clearTimeout, Date, JSON, encodeURIComponent, decodeURIComponent,
        localStorage: {getItem(key) { return key in values ? JSON.stringify(values[key]) : null; }, setItem(key, text) { try { values[key] = JSON.parse(text); } catch { values[key] = text; } }, removeItem(key) { delete values[key]; }, get length() { return Object.keys(values).length; }, key(index) { return Object.keys(values)[index]; }} });
    context.window = context;
    context.hostkey = 'fixture.lampac';
    context.appready = true;
    const result = {
        context, Lampa, values, requests, pending, settings, notices, sockets, server: remote, input: null,
        load(file, token = '', prefix = false) {
            let source = fs.readFileSync(path.join(root, file), 'utf8');
            if (prefix && fs.existsSync(accountPath)) source = fs.readFileSync(accountPath, 'utf8') + '\n' + source;
            source = source.replaceAll('{sync-invc}', fs.readFileSync(path.join(root, 'Modules/Sync/Sync/plugins/sync-invc.js'), 'utf8'))
                .replaceAll('{invc-rch_nws}', '').replaceAll('{localhost}', 'https://fixture.lampac').replaceAll('{token}', encodeURIComponent(token));
            vm.runInContext(source, context, {filename: file});
        },
        loadAccount(token = '') { if (fs.existsSync(accountPath)) this.load('Modules/Sync/Shared/sync-account.js', token); },
        flush() {
            let remaining = 100;
            while (pending.length && remaining-- > 0) {
                const req = pending.shift(); if (req.aborted) continue;
                const reply = remote.handle(req); req.respond(reply.status, reply.data);
            }
            if (pending.length) throw new Error('Synchronization request loop');
        },
        event(name, data, uid = context.LampacSync && context.LampacSync.uid()) { document.dispatchEvent({type: 'lwsEvent', detail: {name, data: typeof data === 'string' ? data : JSON.stringify(data), uid}}); },
        state() { return clone(values); }
    };
    return result;
}
module.exports = {harness, server, clone, emitter, root, group};
