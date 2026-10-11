#!/usr/bin/env node
/* Замер реальной скорости декодирования моста: сколько секунд звука WASM отдаёт
   за секунду настенного времени. Если < 1.0 — рендерер гарантированно рвётся. */
const PW = '/srv/deepseek-harness/home/Servers/mcp/playwright/node_modules/playwright';
const CHROME = '/srv/deepseek-harness/home/Servers/chrome/chrome-linux64/chrome';
const { chromium } = require(PW);

const PAGE = process.env.PAGE || 'https://lampac.fun/lampac-js/uploads/audio-wasm-check2.html';
const VERSION = process.env.VERSION || '20261010-android-7';
const TARGET = Number(process.env.TARGET || 30);

const FILES = [
  ['AC3 5.1 (фильм)', '/lampac-js/uploads/ac3-5.1-90s.mp4'],
  ['EAC3 7.1 (фильм)', '/lampac-js/uploads/eac3-7.1-90s.mp4'],
  ['DTS 6.1 (фильм)', '/lampac-js/uploads/dts-6.1-real.mkv'],
  ['AAC 2.0 (фильм)', '/lampac-js/uploads/aac-2.0-90s.mp4'],
  ['весь фрагмент', '/lampac-js/uploads/real-frag.mp4']
];

const runner = async (arg) => {
  const url = arg.url, target = arg.target, version = arg.version;
  const b64url = (v) => {
    const bytes = new TextEncoder().encode(v);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).split('+').join('-').split('/').join('_').replace(/=+$/, '');
  };
  const w = new Worker('/mpvwasm/assets/mpvwasm-audio-only-worker.js?v=' + version);
  let id = 0;
  const pend = new Map();
  w.onmessage = (e) => {
    const p = pend.get(e.data.id);
    if (!p) return;
    pend.delete(e.data.id);
    if (e.data.ok) p.res(e.data.result); else p.rej(new Error(e.data.error || 'worker error'));
  };
  const req = (command, payload) => new Promise((res, rej) => {
    const i = ++id;
    pend.set(i, { res, rej });
    w.postMessage(Object.assign({ id: i, command }, payload || {}));
  });
  const out = { url };
  try {
    const abs = new URL(url, location.href).href;
    const info = await req('open', { url: '/mpvwasm/proxy?u=' + b64url(abs) });
    out.tracks = (info.tracks || []).map((t) => t.type + ':' + t.codecName + ':' + t.channels);
    const glue = await req('info');
    out.glue = glue && glue.glue ? glue.glue : (glue && glue.singleThread === false ? 'pthread' : 'st');
    out.singleThread = !!(glue && glue.singleThread);
    const audio = (info.tracks || []).filter((t) => t.type === 'audio');
    if (!audio.length) { out.error = 'нет аудиодорожек'; return out; }
    // дорожка того кодека, который не умеет браузер: ac3/eac3/dts, иначе первая
    const pick = audio.find((t) => /^(ac3|eac3|dca|dts)/i.test(t.codecName)) || audio[0];
    out.codec = pick.codecName; out.channels = pick.channels;
    await req('select', { index: pick.index });
    const sel = await req('info');
    out.decodeRate = sel && sel.sampleRate;
    await req('seek', { us: 0 });
    let dur = 0, chunks = 0, firstAt = null;
    const t0 = performance.now();
    while (dur < target) {
      const r = await req('read', { maxPackets: 256 });
      const list = r.chunks || [];
      for (const c of list) dur += c.pcm.length / c.channels / c.sampleRate;
      chunks += list.length;
      if (firstAt === null && list.length) firstAt = (performance.now() - t0) / 1000;
      if (r.eof) { out.eof = true; break; }
    }
    const wall = (performance.now() - t0) / 1000;
    out.audioSec = +dur.toFixed(2);
    out.wallSec = +wall.toFixed(2);
    out.speed = +(dur / wall).toFixed(3);
    out.chunks = chunks;
    out.firstPcmSec = firstAt === null ? null : +firstAt.toFixed(2);
    try { await req('close'); } catch (e) {}
  } catch (e) {
    out.error = String((e && e.message) || e);
  } finally {
    w.terminate();
  }
  return out;
};

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: false,
    args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage', '--ignore-certificate-errors',
      '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1280,900']
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('   pageerror:', String(e).slice(0, 160)));
  await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2000);
  const results = [];
  const only = process.env.FILTER || '';
  for (const [name, url] of FILES) {
    if (only && name.indexOf(only) < 0) continue;
    process.stdout.write('== ' + name + ' … ');
    const r = await page.evaluate(runner, { url: url, target: TARGET, version: VERSION });
    results.push(Object.assign({ name }, r));
    console.log(JSON.stringify(r));
  }
  console.log('\n=== СВОДКА (speed = секунд звука за секунду времени)');
  for (const r of results) {
    console.log((r.name + '                    ').slice(0, 22),
      r.error ? ('ОШИБКА: ' + r.error) : ('speed ' + r.speed + '  (' + r.audioSec + ' с звука за ' + r.wallSec + ' с, ' +
      r.channels + ' кан., ' + r.glue + (r.singleThread ? '/ST' : '/pthread') + ', первый PCM ' + r.firstPcmSec + ' с)'));
  }
  console.log('JSON=' + JSON.stringify(results));
  await browser.close();
})();
