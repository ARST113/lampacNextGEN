#!/usr/bin/env node
/* Реальный тест на ПК: настоящая Lampa (lampac.fun) + наш плагин + настоящий AC3-стрим.
   Использование:
     node pc-real-stream.js [http://lampac.fun/] [<stream-url>]
   Печатает состояние <video>, состояние моста и пики/частоты по FFT.
*/
const fs = require('fs');
const path = require('path');
const PW = '/srv/deepseek-harness/home/Servers/mcp/playwright/node_modules/playwright';
const CHROME = '/srv/deepseek-harness/home/Servers/chrome/chrome-linux64/chrome';
const { chromium } = require(PW);

const SITE = process.argv[2] || 'http://lampac.fun/';
const STREAM = process.argv[3] || 'http://source-host.example:2367/stream/The.Wild.Robot.2024.1080p.BluRay.x264-ZoroSenpai_EniaHD.mkv?link=&lt;hash&gt;&index=1&play';
const OUT = process.env.OUT || path.join(__dirname, 'pc-real-stream-result.json');
const SECONDS = Number(process.env.SECONDS || 100);

const TAP = () => {
  window.__tap = { events: [], peak: 0, rms: 0, best: null, source: null, ctx: null };
  window.__logs = [];
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    try {
      const destName = dest && dest.constructor ? dest.constructor.name : '';
      const srcName = this.constructor ? this.constructor.name : '';
      window.__tap.events.push(srcName + '->' + destName);
      if (destName === 'AudioDestinationNode') {
        const ctx = dest.context;
        const an = ctx.createAnalyser();
        an.fftSize = 8192; an.smoothingTimeConstant = 0;
        origConnect.call(this, an);
        const t = window.__tap;
        t.source = srcName; t.sampleRate = ctx.sampleRate; t.ctx = ctx;
        try {
          const sp = ctx.createScriptProcessor(4096, 2, 2);
          const silent = ctx.createGain(); silent.gain.value = 0;
          t.pcm = []; t.pcmRate = ctx.sampleRate;
          sp.onaudioprocess = (e) => {
            if (t.pcm.length > 4000) return;
            const l = e.inputBuffer.getChannelData(0), r = e.inputBuffer.getChannelData(1);
            t.pcm.push([new Float32Array(l), new Float32Array(r)]);
          };
          origConnect.call(this, sp);
          origConnect.call(sp, silent);
          origConnect.call(silent, ctx.destination);
          t.sp = sp;
        } catch (e) { t.spErr = String(e); }
        const buf = new Float32Array(an.fftSize);
        const fd = new Float32Array(an.frequencyBinCount);
        t.timer = setInterval(() => {
          an.getFloatTimeDomainData(buf);
          let p = 0, s = 0;
          for (let i = 0; i < buf.length; i++) { const x = buf[i], a = x < 0 ? -x : x; if (a > p) p = a; s += x * x; }
          t.peak = Math.max(t.peak, p); t.rms = Math.max(t.rms, Math.sqrt(s / buf.length));
          an.getFloatFrequencyData(fd);
          const bin = ctx.sampleRate / an.fftSize;
          let first = -Infinity, second = -Infinity, f1 = 0, f2 = 0;
          for (let i = 3; i < fd.length; i++) {
            if (fd[i] > first) { second = first; f2 = f1; first = fd[i]; f1 = i; }
            else if (fd[i] > second) { second = fd[i]; f2 = i; }
          }
          if (isFinite(first) && (!t.best || first > t.best.topDb)) t.best = { topHz: Math.round(f1 * bin), secondHz: Math.round(f2 * bin), topDb: Math.round(first) };
        }, 100);
      }
    } catch (e) { window.__tap.err = String(e); }
    return origConnect.call(this, dest, ...rest);
  };

  window.__capture = (ms) => new Promise((resolve) => {
    const t = window.__tap;
    const video = document.querySelector('video');
    const startTime = video ? video.currentTime : null;
    if (!t || !t.pcm) return resolve({ error: 'no PCM tap' });
    t.pcm = [];
    setTimeout(() => {
      const rate = t.pcmRate || 48000;
      let frames = 0;
      for (const pair of t.pcm) frames += pair[0].length;
      const left = new Float32Array(frames), right = new Float32Array(frames);
      let offset = 0;
      for (const pair of t.pcm) { left.set(pair[0], offset); right.set(pair[1], offset); offset += pair[0].length; }
      let peak = 0, sum = 0;
      for (let i = 0; i < frames; i++) { const a = Math.abs(left[i]); if (a > peak) peak = a; sum += left[i] * left[i]; }
      const rms = frames ? Math.sqrt(sum / frames) : 0;
      // WAV 16 bit stereo
      const header = new ArrayBuffer(44);
      const view = new DataView(header);
      const w = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); view.setUint32(4, 36 + frames * 4, true); w(8, 'WAVEfmt '); view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); view.setUint16(22, 2, true); view.setUint32(24, rate, true);
      view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
      w(36, 'data'); view.setUint32(40, frames * 4, true);
      const bytes = new Uint8Array(header.byteLength + frames * 4);
      bytes.set(new Uint8Array(header), 0);
      let p = 44;
      const put = (v) => { const s = Math.max(-1, Math.min(1, v)); const n = s < 0 ? s * 0x8000 : s * 0x7fff; bytes[p++] = n & 0xff; bytes[p++] = (n >> 8) & 0xff; };
      for (let i = 0; i < frames; i++) { put(left[i]); put(right[i]); }
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      resolve({ base64: btoa(binary), frames, rate, peak, rms, startTime, endTime: video ? video.currentTime : null, ctxState: t.ctx ? t.ctx.state : null });
    }, ms);
  });

  window.__snap = () => {
    const v = document.querySelector('video');
    const s = { t: Math.round(performance.now()) };
    if (v) {
      Object.assign(s, {
        src: (v.currentSrc || v.src || '').slice(0, 120), readyState: v.readyState, networkState: v.networkState,
        paused: v.paused, muted: v.muted, volume: v.volume, currentTime: +v.currentTime.toFixed(2),
        duration: isFinite(v.duration) ? +v.duration.toFixed(2) : String(v.duration),
        videoWidth: v.videoWidth, videoHeight: v.videoHeight,
        err: v.error ? { code: v.error.code, message: v.error.message } : null,
        audioTracks: v.audioTracks ? v.audioTracks.length : null,
        buffered: v.buffered.length ? [+v.buffered.start(0).toFixed(1), +v.buffered.end(v.buffered.length - 1).toFixed(1)] : []
      });
    }
    s.tap = window.__tap ? { peak: +window.__tap.peak.toFixed(4), rms: +window.__tap.rms.toFixed(4), best: window.__tap.best, events: window.__tap.events.slice(-4), ctxState: window.__tap.ctx ? window.__tap.ctx.state : null } : null;
    s.pluginLogs = (window.__logs || []).slice(-8);
    s.bridge = (typeof window.__mpvwasmState === 'function') ? window.__mpvwasmState() : null;
    s.lampaPlayer = window.Lampa && Lampa.Player ? { opened: !!(Lampa.Player.opened && Lampa.Player.opened()), storage: Lampa.Storage.get('mpvwasm_audio_mode', 'auto'), playerSetting: Lampa.Storage.get('player') } : null;
    return s;
  };
};

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: false,
    args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage', '--ignore-certificate-errors',
      '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1280,760']
  });
  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', m => {
    const line = '[' + m.type() + '] ' + m.text();
    consoleLines.push(line);
    if (/WASM|Mixed|mixed|blocked|audio/i.test(m.text())) console.log('  console:', line.slice(0, 300));
  });
  page.on('pageerror', e => console.log('  pageerror:', String(e.stack || e).slice(0, 700)));

  console.log('== открываю', SITE);
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.Lampa && Lampa.Player && Lampa.PlayerVideo', null, { timeout: 90000 });
  console.log('== Lampa загружена, прохожу первый запуск и ставлю измеритель');
  await page.waitForFunction('!document.querySelector(".loading-progress")', null, { timeout: 60000 }).catch(() => console.log('  (экран загрузки не исчез)'));
  for (let i = 0; i < 14; i++) {
    const info = await page.evaluate(() => ({
      activity: document.querySelectorAll('.activity').length,
      buttons: Array.from(document.querySelectorAll('.button, .selector, [data-code], .modal__button, .card')).map(b => (b.textContent || '').trim().slice(0, 32)).filter(Boolean).slice(0, 8)
    }));
    if (info.activity) { console.log('  главный экран появился на шаге', i); break; }
    const clicked = await page.evaluate(() => {
      const wanted = /Русский|Продолжить|Пропустить|Начать|Позже|Понятно|Готово|Далее|Next|Continue|Skip|Start/i;
      const nodes = Array.from(document.querySelectorAll('.button, .selector, [data-code], .modal__button'));
      const b = nodes.find(n => wanted.test((n.textContent || '').trim()));
      if (b) { b.click(); return (b.textContent || '').trim().slice(0, 30); }
      return null;
    });
    console.log('  шаг', i, 'кнопки:', JSON.stringify(info.buttons), 'нажал:', clicked);
    await page.waitForTimeout(2500);
  }
  await page.waitForTimeout(3000);
  console.log('== экран:', JSON.stringify(await page.evaluate(() => ({
    activity: document.querySelectorAll('.activity').length,
    loading: document.querySelectorAll('.loading-progress').length,
    body: document.body.className
  }))));
  await page.addInitScript(() => {}); // no-op, tap ставим вручную ниже
  await page.evaluate(TAP);
  if (process.env.DEBUG) await page.evaluate(() => { window.__mpvwasmDebug = true; });
  if (process.env.PROXY_BASE) await page.evaluate((b) => { window.__mpvwasmProxyBase = b; }, process.env.PROXY_BASE);
  await page.evaluate(() => {
    window.__logs = window.__logs || [];
    ['log', 'warn', 'error'].forEach((kind) => {
      const orig = console[kind].bind(console);
      console[kind] = function () {
        try { window.__logs.push(kind + ': ' + Array.from(arguments).map(String).join(' ').slice(0, 240)); } catch (e) {}
        return orig.apply(console, arguments);
      };
    });
  });

  const before = await page.evaluate(() => ({
    secure: window.isSecureContext, isolated: !!window.crossOriginIsolated,
    sab: typeof SharedArrayBuffer, worklet: typeof AudioWorkletNode, scriptProc: !!window.ScriptProcessorNode,
    plugins: (window.Lampa && Lampa.Plugins) ? Lampa.Plugins.loaded || null : null
  }));
  console.log('== контекст:', JSON.stringify(before));

  console.log('== запускаю Lampa.Player.play со стримом');
  await page.evaluate((url) => {
    try {
      Lampa.Player.play({ url: url, title: 'The Wild Robot (AC3 test)' });
    } catch (e) { window.__playError = String(e); }
  }, STREAM);
  const playError = await page.evaluate(() => window.__playError || null);
  if (playError) console.log('  play error:', playError.slice(0, 600));
  await page.waitForTimeout(2000);
  console.log('== после play:', JSON.stringify(await page.evaluate(() => ({
    videos: document.querySelectorAll('video').length,
    player: document.querySelectorAll('.player').length,
    body: document.body.className,
    playerOpened: !!(window.Lampa && Lampa.Player && Lampa.Player.opened && Lampa.Player.opened())
  }))));

  async function captureWhilePlaying(seconds) {
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const st = await page.evaluate(() => { const v = document.querySelector('video'); return v ? { paused: v.paused, rs: v.readyState } : null; });
      if (st && !st.paused && st.rs >= 3) break;
      await page.waitForTimeout(1000);
    }
    return page.evaluate((s) => window.__capture(s), seconds);
  }
  const deadline = Date.now() + SECONDS * 1000;
  let last = '';
  const snapshots = [];
  let capture1 = null, capture2 = null;
  const started = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    let snap;
    try { snap = await page.evaluate(() => window.__snap ? window.__snap() : null); } catch (e) { snap = null; }
    if (!snap) continue;
    snapshots.push({ at: Math.round((Date.now() - started) / 1000), ...snap });
    const line = JSON.stringify(snap);
    if (line !== last) { console.log('  ' + new Date().toISOString().slice(11, 19) + ' ' + line.slice(0, 400)); last = line; }
    const played = Math.round((Date.now() - started) / 1000);
    if (!capture1 && played >= 6) {
      console.log('== снимаю 8 с PCM на 6-й секунде (пока видео точно играет)');
      capture1 = await captureWhilePlaying(8000);
      if (capture1 && capture1.base64) fs.writeFileSync(OUT.replace(/\.json$/, '.t20.wav'), Buffer.from(capture1.base64, 'base64'));
      console.log('   t20:', capture1 ? JSON.stringify({ frames: capture1.frames, peak: capture1.peak, rms: capture1.rms }) : 'нет');
    }
    if (capture1 && played >= 45) {
      console.log('== снимаю 8 с PCM на 45-й секунде (проверка, что мост не умирает)');
      const c2 = await captureWhilePlaying(8000);
      if (c2 && c2.base64) fs.writeFileSync(OUT.replace(/\.json$/, '.t75.wav'), Buffer.from(c2.base64, 'base64'));
      capture2 = c2;
      console.log('   t75:', c2 ? JSON.stringify({ frames: c2.frames, peak: c2.peak, rms: c2.rms }) : 'нет');
      break;
    }
  }

  console.log('== снимаю 12 секунд PCM из WebAudio (то, что реально слышно)');
  const rec = capture2 || (await captureWhilePlaying(12000));
  if (rec && rec.base64) {
    const audioFile = OUT.replace(/\.json$/, '.wav');
    fs.writeFileSync(audioFile, Buffer.from(rec.base64, 'base64'));
    console.log('== запись:', audioFile, rec.frames, 'кадров; video', rec.startTime, '->', rec.endTime, '; peak', rec.peak, 'rms', rec.rms);
  } else {
    console.log('== запись не удалась:', JSON.stringify(rec));
  }

  let phase2 = null;
  if (process.env.PHASE2) {
    const SHORT = process.env.SHORT || (SITE.replace(/\/$/, '') + '/lampac-js/uploads/audio-check-ac3.mp4');
    console.log('== фаза 2: короткий AC3-файл (440 Гц слева / 1000 Гц справа):', SHORT);
    await page.evaluate((url) => { try { Lampa.Player.play({ url: url, title: 'AC3 tone' }); } catch (e) { window.__playError2 = String(e); } }, SHORT);
    await page.waitForTimeout(9000);
    const cap = await page.evaluate(() => window.__capture(6000));
    if (cap && cap.base64) fs.writeFileSync(OUT.replace(/\.json$/, '.tone.wav'), Buffer.from(cap.base64, 'base64'));
    phase2 = { frames: cap && cap.frames, peak: cap && cap.peak, rms: cap && cap.rms, state: await page.evaluate(() => window.__mpvwasmState ? window.__mpvwasmState() : null) };
    console.log('== фаза 2 запись:', JSON.stringify(phase2));
  }

  const resources = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter(e => /mpvwasm|demuxer|worklet|worker/i.test(e.name))
    .map(e => ({ name: e.name.replace(location.origin, ''), size: e.transferSize, ms: Math.round(e.duration) })));
  const tracks = await page.evaluate(() => {
    try {
      return Array.from(document.querySelectorAll('.player-panel__track, .track, .panel__track')).map(e => e.textContent.trim().slice(0, 60));
    } catch (e) { return []; }
  });

  const final = await page.evaluate(() => window.__snap());
  const shot = path.join(__dirname, 'pc-real-stream.png');
  await page.screenshot({ path: shot });
  fs.writeFileSync(OUT, JSON.stringify({ site: SITE, stream: STREAM, context: before, snapshots, final, resources, tracks, recording: rec ? { frames: rec.frames, rate: rec.rate, startTime: rec.startTime, endTime: rec.endTime, peak: rec.peak, rms: rec.rms, videoAdvanced: rec.endTime - rec.startTime } : null, phase2, pluginWarnings: consoleLines.filter(l => /Lampa Audio WASM/.test(l)), console: consoleLines.slice(-80) }, null, 2));
  console.log('== финал:', JSON.stringify({ tap: final.tap, readyState: final.readyState, muted: final.muted, currentTime: final.currentTime, duration: final.duration }));
  console.log('== ресурсы:', JSON.stringify(resources.slice(0, 12)));
  console.log('== дорожки в панели:', JSON.stringify(tracks.slice(0, 8)));
  console.log('== скриншот:', shot, '== json:', OUT);
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
