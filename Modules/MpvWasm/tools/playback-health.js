#!/usr/bin/env node
/* Здоровье звука на боевой странице проверки: клиппинг, провалы (underrun),
 * щелчки и счётчики рендерера. Читаем выход анализатора (то, что реально уходит
 * в звук) как длинные окна, поэтому провалы не проскакивают между замерами. */
const PW = '/srv/deepseek-harness/home/Servers/mcp/playwright/node_modules/playwright';
const CHROME = '/srv/deepseek-harness/home/Servers/chrome/chrome-linux64/chrome';
const { chromium } = require(PW);

const PAGE = process.env.PAGE || 'https://lampac.fun/lampac-js/uploads/audio-wasm-check2.html';
const SELECTOR = process.env.SELECTOR || 'button[data-src*="ac3-5.1-90s"]';
const SECONDS = Number(process.env.SECONDS || 20);
const TRACK = Number(process.env.TRACK || 0);   // 1-based: после старта нажать дорожку в #trackrow
const NAME = process.env.NAME || SELECTOR;

/* Внедряем свой зонд до кода страницы: перехватываем анализатор и растягиваем окно,
   чтобы замеры шли встык и ни один провал не потерялся. */
const init = () => {
  window.__probe = { ready: false };
  const origCreate = AudioContext.prototype.createAnalyser;
  AudioContext.prototype.createAnalyser = function () {
    const node = origCreate.call(this);
    try { node.fftSize = 32768; } catch (e) {}
    window.__probe = Object.assign(window.__probe, { node, ctx: this, ready: true });
    return node;
  };
};

const health = (seconds) => new Promise((resolve) => {
  const started = Date.now();
  const waiter = setInterval(() => {
    const probe = window.__probe || {};
    if (!probe.node) {
      if (Date.now() - started > 25000) { clearInterval(waiter); resolve({ error: 'анализатор не найден' }); }
      return;
    }
    clearInterval(waiter);
    run(probe, resolve);
  }, 200);
  function run(p, done) {
  const buf = new Float32Array(p.node.fftSize);
  const acc = { calls: 0, samples: 0, callsWithClip: 0, callsWithClicks: 0, silentRatioSum: 0,
                peak: 0, rmsSum: 0, longestRunMs: 0, mode: 'sink' };
  let last = 0;
  const step = () => {
    p.node.getFloatTimeDomainData(buf);
    acc.calls++;
    acc.samples += buf.length;
    let run = 0, peak = 0, sum = 0, silent = 0, clip = 0, clicks = 0, longest = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      if (a >= 0.99) clip++;
      if (a < 0.0015) { run++; silent++; } else { run = 0; }
      if (run > longest) longest = run;
      if (i) { const d = Math.abs(buf[i] - buf[i - 1]); if (d > 0.3) clicks++; }
      sum += v * v;
    }
    if (clip) acc.callsWithClip++;
    if (clicks) acc.callsWithClicks++;
    acc.silentRatioSum += silent / buf.length;
    const longestMs = longest / p.ctx.sampleRate * 1000;
    if (longestMs > acc.longestRunMs) acc.longestRunMs = longestMs;
    acc.peak = Math.max(acc.peak, peak);
    acc.rmsSum += Math.sqrt(sum / buf.length);
    const el = (id) => { const e = document.getElementById(id); return e ? e.textContent.trim() : null; };
    acc.last = { buffer: el('s-buffer'), queue: el('s-queue'), underruns: el('s-underruns'),
                 backend: el('s-backend'), track: el('s-track'), level: el('s-level'), build: el('s-build') };
    if (Date.now() - last > 2000) {
      last = Date.now();
      console.log('   ' + JSON.stringify(acc.last) + ' peak=' + acc.peak.toFixed(3));
    }
  };
  const id = setInterval(step, 40);
  setTimeout(() => {
    clearInterval(id);
    const sr = p.ctx.sampleRate;
    done({
      sampleRate: sr, calls: acc.calls, seconds: +(acc.calls * 0.04).toFixed(1),
      peak: +acc.peak.toFixed(4), rmsAvg: +(acc.rmsSum / Math.max(1, acc.calls)).toFixed(4),
      callsWithClip: acc.callsWithClip, callsWithClicks: acc.callsWithClicks,
      silencePctOfCalls: +(100 * acc.silentRatioSum / Math.max(1, acc.calls)).toFixed(1),
      longestSilenceMs: +acc.longestRunMs.toFixed(1),
      last: acc.last
    });
  }, seconds * 1000);
  }
});

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: false,
    args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage', '--ignore-certificate-errors',
      '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1280,900']
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('   pageerror:', String(e).slice(0, 160)));
  await page.addInitScript(init);
  await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(1500);
  console.log('== ' + NAME + ' → ' + SELECTOR);
  await page.click(SELECTOR);
  if (TRACK > 0) {
    await page.waitForTimeout(6000);
    const n = await page.evaluate(() => document.querySelectorAll('#trackrow button').length);
    console.log('   дорожек:', n, '→ жму', TRACK);
    if (n >= TRACK) await page.click('#trackrow button:nth-child(' + TRACK + ')');
  }
  const result = await page.evaluate(health, SECONDS);
  console.log('== ИТОГ ' + NAME + ': ' + JSON.stringify(result));
  console.log('JSON=' + JSON.stringify(Object.assign({ name: NAME, selector: SELECTOR }, result)));
  await browser.close();
})();
