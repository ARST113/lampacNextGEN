#!/usr/bin/env node
/* Сколько секунд звука в секунду реального времени отдаёт боевой воркер на реальном
   4K-файле: напрямую с источника и через /mpvwasm/proxy.  Один и тот же поток,
   разница только в транспорте.
   usage: node real4k-speed.js direct|proxy [streamIndex] [seekSec] [ms] */
const PW = '/srv/deepseek-harness/home/Servers/mcp/playwright/node_modules/playwright';
const CHROME = '/srv/deepseek-harness/home/Servers/chrome/chrome-linux64/chrome';
const { chromium } = require(PW);

const MODE = process.argv[2] || 'direct';
const INDEX = Number(process.argv[3] || 2);
const SEEK = Number(process.argv[4] || 2580);
const MS = Number(process.argv[5] || 20000);
const URL4K = 'https://source.example/TS-DE/stream/Spider-Man.Brand.New.Day.2026.WEB-DL.2160p.HDR.DV.seleZen.mkv?link=&lt;hash&gt;&index=1&play';

const run = (arg) => new Promise((resolve) => {
  const b64url = (v) => {
    const bytes = new TextEncoder().encode(v);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).split('+').join('-').split('/').join('_').replace(/=+$/, '');
  };
  const out = { mode: arg.mode, index: arg.index, seek: arg.seek };
  const target = arg.mode === 'direct' ? arg.url : '/mpvwasm/proxy?u=' + b64url(arg.url);
  const w = new Worker('/mpvwasm/assets/mpvwasm-audio-only-worker.js?v=20261010-android-8');
  let id = 0;
  const pend = new Map();
  w.onmessage = (e) => {
    const m = e.data || {};
    const p = pend.get(m.id);
    if (!p) return;
    pend.delete(m.id);
    if (m.ok) p.res(m.result); else p.rej(new Error(m.error || 'worker error'));
  };
  w.onerror = (e) => { out.workerError = String(e.message || e); };
  const req = (command, payload) => new Promise((res, rej) => {
    const i = ++id;
    const timer = setTimeout(() => { pend.delete(i); rej(new Error('timeout ' + command)); },
      command === 'open' ? 60000 : 30000);
    pend.set(i, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
    w.postMessage(Object.assign({ id: i, command }, payload || {}));
  });
  (async () => {
    try {
      const t0 = Date.now();
      const info = await req('open', { url: target });
      out.openMs = Date.now() - t0;
      out.tracks = (info.tracks || []).map((t) => t.index + ':' + t.type + ':' + t.codecName + ':' + t.channels);
    } catch (e) { out.openError = String(e.message); resolve(out); return; }
    try {
      await req('select', { index: arg.index });
      await req('seek', { us: arg.seek * 1000000 });
      let samples = 0, reads = 0, skipped = 0, firstPts = null, lastPts = null, eof = false;
      const t0 = Date.now();
      while (Date.now() - t0 < arg.ms && !eof) {
        const r = await req('read', { maxPackets: 64 });
        reads++;
        eof = !!r.eof;
        (r.chunks || []).forEach((c) => {
          const n = Math.floor(c.pcm.length / Math.max(1, c.channels));
          if (firstPts === null) firstPts = c.ptsUs;
          lastPts = c.ptsUs;
          samples += n;
        });
        if (!r.chunks || !r.chunks.length) skipped++;
      }
      const wall = (Date.now() - t0) / 1000;
      out.audioSeconds = +(samples / 48000).toFixed(2);
      out.wallSeconds = +wall.toFixed(2);
      out.realtime = +((samples / 48000) / wall).toFixed(2);
      out.reads = reads;
      out.emptyReads = skipped;
      out.eof = eof;
      out.spanSeconds = firstPts !== null && lastPts !== null ? +((lastPts - firstPts) / 1e6).toFixed(2) : null;
    } catch (e) { out.readError = String(e.message); }
    w.terminate();
    resolve(out);
  })();
});

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: false,
    args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage',
           '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required', '--mute-audio']
  });
  const page = await browser.newPage();
  await page.goto('https://lampac.fun/lampac-js/uploads/audio-wasm-check2.html',
    { waitUntil: 'domcontentloaded', timeout: 90000 });
  const r = await page.evaluate(run, { mode: MODE, url: URL4K, index: INDEX, seek: SEEK, ms: MS });
  console.log(JSON.stringify(r, null, 1));
  await browser.close();
})();
