#!/usr/bin/env node
/* Что делает боевой воркер при открытии дорожки: какой глю выбран, был ли
   откат на другую сборку и чем закончилось. */
const PW = '/srv/deepseek-harness/home/Servers/mcp/playwright/node_modules/playwright';
const CHROME = '/srv/deepseek-harness/home/Servers/chrome/chrome-linux64/chrome';
const { chromium } = require(PW);
const FILE = process.env.FILE || '/lampac-js/uploads/dts-6.1-real.mkv';
const INDEX = Number(process.env.INDEX || 1);
const WORKER_VERSION = process.env.WORKER_VERSION || '20261010-android-4';

const run = (arg) => new Promise((resolve) => {
  const b64url = (v) => {
    const bytes = new TextEncoder().encode(v);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).split('+').join('-').split('/').join('_').replace(/=+$/, '');
  };
  const out = [];
  const w = new Worker('/mpvwasm/assets/mpvwasm-audio-only-worker.js?v=' + arg.version);
  let id = 0;
  const pend = new Map();
  w.onmessage = (e) => {
    const m = e.data || {};
    const p = pend.get(m.id);
    if (!p) { out.push({ stray: m }); return; }
    pend.delete(m.id);
    if (m.ok) p.res(m.result); else p.rej(new Error(m.error || 'worker error'));
  };
  w.onerror = (e) => out.push({ workerError: String(e.message || e) });
  const req = (command, payload) => new Promise((res, rej) => {
    const i = ++id;
    pend.set(i, { res, rej });
    w.postMessage(Object.assign({ id: i, command }, payload || {}));
  });
  (async () => {
    try {
      const abs = location.origin + new URL(arg.file, location.href).pathname;
      const info = await req('open', { url: '/mpvwasm/proxy?u=' + b64url(new URL(arg.file, location.href).href) });
      out.push({ step: 'open', tracks: (info.tracks || []).map((t) => t.type + ':' + t.codecName + ':' + t.channels) });
    } catch (e) { out.push({ step: 'open', error: String(e.message) }); }
    try { out.push({ step: 'info#1', info: await req('info') }); } catch (e) { out.push({ step: 'info#1', error: String(e.message) }); }
    try { out.push({ step: 'select', result: await req('select', { index: arg.index }) }); }
    catch (e) { out.push({ step: 'select', error: String(e.message) }); }
    try { out.push({ step: 'info#2', info: await req('info') }); } catch (e) { out.push({ step: 'info#2', error: String(e.message) }); }
    try {
      await req('seek', { us: 0 });
      const r = await req('read', { maxPackets: 64 });
      out.push({ step: 'read', chunks: (r.chunks || []).length,
                 samples: (r.chunks || []).reduce((a, c) => a + c.pcm.length / c.channels, 0), eof: !!r.eof });
    } catch (e) { out.push({ step: 'read', error: String(e.message) }); }
    w.terminate();
    resolve(out);
  })();
});

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: false,
    args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage', '--ignore-certificate-errors', '--mute-audio']
  });
  const page = await browser.newPage();
  await page.goto('https://lampac.fun/lampac-js/uploads/audio-wasm-check2.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
  const r = await page.evaluate(run, { file: FILE, index: INDEX, version: WORKER_VERSION });
  console.log(JSON.stringify(r, null, 1));
  await browser.close();
})();
