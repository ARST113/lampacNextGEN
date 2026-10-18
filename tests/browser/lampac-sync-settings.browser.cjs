'use strict';
// Run with --lampa-root <deployed Lampa checkout>; optional --real-history <private JSON copy>.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const {server, clone, group, root} = require('../helpers/lampa-sync-harness');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, list) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), list[index + 1]]);
    return pairs;
}, []));
const lampaRoot = args['lampa-root'];
if (!lampaRoot) throw new Error('--lampa-root is required');
const output = args['artifact-dir'] || '/tmp/lampac-sync-browser';
fs.mkdirSync(output, {recursive: true});
const playwright = require(process.env.PLAYWRIGHT_MODULE || '/opt/codex/cua_node/lib/node_modules/playwright-core');
const history = args['real-history'] ? JSON.parse(fs.readFileSync(args['real-history'], 'utf8')) : {
    online_view: {}, lampac_resume_history_v1: {schema: 1, cards: {}}
};
const remote = server();
remote.documents.set('alpha::sync_view', {time: 1000, data: clone(history)});
let origin;
const calls = [];
const mime = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2'};
const scripts = {
    '/sync.js': 'Modules/Sync/Sync/plugins/sync_v2/sync.js',
    '/bookmark.js': 'Modules/Sync/Sync/plugins/bookmark.js',
    '/timecode.js': 'Modules/Sync/TimeCode/plugin.js',
    '/invc-ws.js': 'Modules/Sync/Sync/plugins/sync_v2/invc-ws.js'
};
const fixture = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const pathname = url.pathname;
    if (scripts[pathname]) {
        let text = fs.readFileSync(path.join(root, 'Modules/Sync/Shared/sync-account.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, scripts[pathname]), 'utf8');
        text = text.replaceAll('{localhost}', origin).replaceAll('{token}', '').replaceAll('{sync-invc}', fs.readFileSync(path.join(root, 'Modules/Sync/Sync/plugins/sync-invc.js'), 'utf8'));
        res.writeHead(200, {'Content-Type': 'application/javascript'}); res.end(text); return;
    }
    if (/^\/(sync\/account|storage\/|bookmark\/|timecode\/)/.test(pathname)) {
        calls.push({path: pathname, id: url.searchParams.get('sync_id')});
        let body = ''; for await (const chunk of req) body += chunk;
        const reply = remote.handle({url: url.href, body: body || null});
        res.writeHead(reply.status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(reply.data)); return;
    }
    let file;
    if (pathname === '/js/nws-client-es5.js') file = path.join(root, 'Core/plugins/nws-client-es5.js');
    else file = path.resolve(lampaRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, {'Content-Type': mime[path.extname(file)] || 'application/octet-stream'}); res.end(fs.readFileSync(file)); return;
    }
    res.writeHead(404); res.end();
});

(async () => {
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + fixture.address().port;
    const browser = await playwright.chromium.launch({executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
    try {
        const context = await browser.newContext({viewport: {width: 1280, height: 960}});
        await context.route('**/*', route => {
            if (route.request().url().startsWith(origin)) return route.continue();
            if (route.request().resourceType() === 'script') return route.fulfill({contentType: 'application/javascript', body: ''});
            if (/lgbt/.test(route.request().url())) return route.fulfill({contentType: 'application/json', body: '[]'});
            if (!/themoviedb|tmdb/.test(route.request().url())) return route.fulfill({status: 503, contentType: 'application/json', body: '{}'});
            return route.fulfill({contentType: 'application/json', body: JSON.stringify({results: [], items: [], genres: [], total_pages: 1, total_results: 0})});
        });
        await context.addInitScript(initial => {
            window.lampa_settings = {account_use: true, account_sync: true};
            const values = Object.assign({lampac_unic_id: 'login-a', account_email: 'login-a', account_use: true, language: 'ru', extensions: [], keyboard_type: 'lampa'}, initial);
            Object.keys(values).forEach(key => localStorage.setItem(key, typeof values[key] === 'object' ? JSON.stringify(values[key]) : String(values[key])));
        }, history);
        const page = await context.newPage();
        const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log('Page error:', error.message); });
        await page.goto(origin, {waitUntil: 'load'});
        await page.waitForFunction(() => window.appready && window.Lampa, {timeout: 30000});
        await page.waitForSelector('.welcome', {state: 'hidden', timeout: 30000});
        if (args['continue-watching']) await page.addScriptTag({path: args['continue-watching']});
        await page.addScriptTag({url: origin + '/sync.js'});
        await page.waitForFunction(() => window.LampacSync && LampacSync.ready() && LampacSync.uid() === 'alpha');
        await page.waitForFunction(() => window.lampacBookmarkSyncInitialized && window.lampac_timecode_plugin);
        await page.evaluate(() => { Lampa.Controller.toggle('settings'); Lampa.Settings.create('account'); });
        await page.waitForSelector('.lampac-sync-setting');
        assert.equal(await page.locator('.lampac-sync-setting').count(), 5);
        assert.equal(await page.locator('.lampac-sync-setting').first().innerText(), 'Синхронизация Lampac');
        assert.equal(await page.locator('[data-name="lampac_sync_password_action"] .settings-param__name').innerText(), 'ID синхронизации');
        assert.match(await page.locator('[data-name="lampac_sync_password_action"] .settings-param__value').innerText(), /Базовый/);
        const basic = await page.evaluate(() => ({resume: Lampa.Storage.get('lampac_resume_history_v1', {}), views: Lampa.Storage.get('online_view', {}), cub: Lampa.Storage.field('account_use')}));
        assert.equal(basic.cub, false);
        assert.deepEqual(basic.resume, history.lampac_resume_history_v1);
        assert.deepEqual(basic.views, history.online_view);
        await page.waitForTimeout(400);
        await page.screenshot({path: path.join(output, 'settings-basic.png')});
        await page.locator('[data-name="lampac_sync_password_action"]').click();
        await page.waitForSelector('.settings-input__title');
        assert.match(await page.locator('.settings-input__title').innerText(), /Свой ID/);
        for (const digit of '739168') await page.locator('.simple-keyboard [data-skbtn="' + digit + '"]').click();
        // Native Lampa keyboard debounces its action keys for 100 ms.
        await page.waitForTimeout(150);
        await page.evaluate(() => $('.simple-keyboard [data-skbtn="{ENTER}"]').trigger('hover:enter'));
        await page.waitForFunction(uid => LampacSync.uid() === uid && LampacSync.ready(), group('739168'), {timeout: 5000});
        const changed = await page.evaluate(() => Object.keys(Lampa.Storage.get('lampac_resume_history_v1', {cards: {}}).cards).length);
        assert.equal(changed, 0, 'The new ID must not receive the old history from ContinueWatching memory');
        await page.screenshot({path: path.join(output, 'settings-custom.png')});
        await page.locator('[data-name="lampac_sync_login_action"]').click();
        await page.waitForFunction(() => LampacSync.uid() === 'alpha' && LampacSync.ready());
        const restored = await page.evaluate(() => ({resume: Lampa.Storage.get('lampac_resume_history_v1', {}), views: Lampa.Storage.get('online_view', {})}));
        assert.deepEqual(restored.resume, history.lampac_resume_history_v1);
        assert.deepEqual(restored.views, history.online_view);
        await page.screenshot({path: path.join(output, 'settings-restored.png')});
        const result = {passed: true, real_history: !!args['real-history'], resume_records: Object.keys(restored.resume.cards).length, online_views: Object.keys(restored.views).length, page_errors: errors};
        assert.equal(errors.length, 0);
        fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
    } catch (error) {
        const pages = browser.contexts().flatMap(context => context.pages());
        if (pages[0]) {
            console.log('Browser state:', await pages[0].evaluate(() => ({uid: window.LampacSync && LampacSync.uid(), status: window.LampacSync && LampacSync.status(), input: $('.settings-input__input').text(), own: Lampa.Storage.get('lampac_sync_id', ''), controller: Lampa.Controller.enabled().name})));
            console.log('Calls:', calls);
            await pages[0].screenshot({path: path.join(output, 'failure.png')});
            fs.writeFileSync(path.join(output, 'failure.txt'), await pages[0].locator('body').innerText());
        }
        throw error;
    } finally { await browser.close(); await new Promise(resolve => fixture.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
