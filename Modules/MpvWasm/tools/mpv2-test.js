#!/usr/bin/env node
/* Проверка плеера MPV2 (mpvwasm-lampa-player.js): играет ли он MKV сам, декодирует ли
   AC3 своим wasm-FFmpeg и рисует ли встроенные субтитры.
   usage: node mpv2-test.js [file-url] [seconds] */
const PW = '/srv/deepseek-harness/home/Servers/mcp/playwright/node_modules/playwright';
const CHROME = '/srv/deepseek-harness/home/Servers/chrome/chrome-linux64/chrome';
const { chromium } = require(PW);

const FILE = process.argv[2] || 'https://lampac.fun/lampac-js/uploads/probe-h264-ac3.mkv';
const SECONDS = Number(process.argv[3] || 45);

const TAP = () => {
  window.__tap = { peak: 0, rms: 0, f1: 0, f2: 0, pcm: [], rate: 0, events: [], err: null };
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest) {
    try {
      const name = dest && dest.constructor ? dest.constructor.name : '';
      window.__tap.events.push((this.constructor ? this.constructor.name : '?') + '->' + name);
      if (name === 'AudioDestinationNode') {
        const ctx = dest.context, t = window.__tap;
        t.rate = ctx.sampleRate; t.source = this.constructor ? this.constructor.name : '?';
        const an = ctx.createAnalyser(); an.fftSize = 8192; an.smoothingTimeConstant = 0;
        orig.call(this, an);
        const sp = ctx.createScriptProcessor(4096, 2, 2);
        t.pcmRate = ctx.sampleRate; t.pcm = [];
        sp.onaudioprocess = (e) => {
          if (t.pcm.length > 3000) return;
          t.pcm.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        };
        orig.call(this, sp);
        const silent = ctx.createGain(); silent.gain.value = 0;
        orig.call(sp, silent); orig.call(silent, ctx.destination);
        const buf = new Float32Array(an.fftSize), fd = new Float32Array(an.frequencyBinCount);
        t.timer = setInterval(() => {
          an.getFloatTimeDomainData(buf);
          let p = 0, s = 0;
          for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > p) p = a; s += buf[i] * buf[i]; }
          t.peak = Math.max(t.peak, p); t.rms = Math.max(t.rms, Math.sqrt(s / buf.length));
          an.getFloatFrequencyData(fd);
          const bin = ctx.sampleRate / an.fftSize; let a1 = -Infinity, a2 = -Infinity, i1 = 0, i2 = 0;
          for (let i = 3; i < fd.length; i++) {
            if (fd[i] > a1) { a2 = a1; i2 = i1; a1 = fd[i]; i1 = i; } else if (fd[i] > a2) { a2 = fd[i]; i2 = i; }
          }
          t.f1 = Math.round(i1 * bin); t.f2 = Math.round(i2 * bin);
        }, 250);
      }
    } catch (e) { window.__tap.err = String(e); }
    return orig.apply(this, arguments);
  };
};

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: false,
    args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage', '--ignore-certificate-errors',
           '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--enable-features=SharedArrayBuffer']
  });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => { const t = m.text(); if (/mpv2|mpvwasm|Audio|error|Error|fail/i.test(t)) logs.push(t.slice(0, 220)); });
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e).slice(0, 220)));

  await page.goto('https://lampac.fun/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(9000);
  // снять онбординг, если он есть
  for (let i = 0; i < 6; i++) {
    const clicked = await page.evaluate(() => {
      const want = /Русский|Продолжить|Пропустить|Начать|Позже|Понятно|Готово|Далее|Next|Continue|Skip|Start/i;
      const b = Array.from(document.querySelectorAll('.button, .selector')).find((n) => want.test((n.textContent || '').trim()));
      if (b) { b.click(); return (b.textContent || '').trim().slice(0, 24); }
      return null;
    });
    if (!clicked) break;
    await page.waitForTimeout(1500);
  }
  await page.evaluate(() => {
    try { Lampa.Storage.set('mpvwasm_player_mode', 'mpv2'); } catch (e) {}
    window.__logs = [];
    ['log', 'warn', 'error'].forEach((k) => {
      const o = console[k].bind(console);
      console[k] = function () { try { window.__logs.push(k + ': ' + Array.from(arguments).map(String).join(' ').slice(0, 200)); } catch (e) {} return o.apply(console, arguments); };
    });
  });
  await page.evaluate(TAP);
  const env = await page.evaluate(() => ({
    plugin: window.__mpvwasm_lampa_plugin || null, mode: (function () { try { return Lampa.Storage.get('mpvwasm_player_mode', '?'); } catch (e) { return 'err'; } })(),
    webcodecs: typeof VideoDecoder, worklet: typeof AudioWorkletNode, isolated: !!window.crossOriginIsolated, sab: typeof SharedArrayBuffer
  }));
  console.log('ENV ' + JSON.stringify(env));

  await page.evaluate((url) => { try { Lampa.Player.play({ url: url, title: 'AC3 test' }); } catch (e) { window.__playError = String(e); } }, FILE);
  console.log('playError ' + JSON.stringify(await page.evaluate(() => window.__playError || null)));

  const t0 = Date.now();
  const snaps = [];
  while (Date.now() - t0 < SECONDS * 1000) {
    await page.waitForTimeout(5000);
    const s = await page.evaluate(() => {
      const t = window.__tap || {};
      const v = document.querySelector('video');
      const sub = document.querySelector('[class*="subtitles"], [class*="subtitle"]');
      return {
        at: 0, peak: +t.peak.toFixed(4), rms: +t.rms.toFixed(4), f1: t.f1, f2: t.f2,
        pcmChunks: (t.pcm || []).length, src: t.source || null, events: (t.events || []).slice(0, 6),
        video: v ? { rs: v.readyState, w: v.videoWidth, t: +v.currentTime.toFixed(1), paused: v.paused, muted: v.muted, err: v.error ? v.error.code : null } : null,
        canvas: document.querySelectorAll('canvas').length,
        playerEls: document.querySelectorAll('[class*="player"]').length,
        subEl: sub ? (sub.className + '|' + (sub.textContent || '').trim().slice(0, 60)) : null,
        bodyClass: document.body.className.slice(0, 80)
      };
    });
    snaps.push(s);
    console.log('SNAP ' + Math.round((Date.now() - t0) / 1000) + 's ' + JSON.stringify(s));
  }

  const dom = await page.evaluate(() => {
    const overlay = document.querySelector('[class*="player"]');
    const buttons = Array.from(document.querySelectorAll('button, .button, [class*="btn"], [class*="control"]'))
      .map((b) => ((b.className || '') + ' :: ' + (b.textContent || '').trim().slice(0, 18))).slice(0, 40);
    return { overlayHtml: overlay ? overlay.outerHTML.slice(0, 900) : null, buttons };
  });
  console.log('DOM ' + JSON.stringify(dom, null, 1).slice(0, 2600));
  console.log('LOGS ' + JSON.stringify(logs.slice(-25), null, 1));
  const jsLogs = await page.evaluate(() => (window.__logs || []).slice(-30));
  console.log('JSLOGS ' + JSON.stringify(jsLogs, null, 1));
  await browser.close();
})();
