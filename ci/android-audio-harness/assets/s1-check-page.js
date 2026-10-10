/* S1: open the public check page, press AC3 / EAC3 / DTS, report every state change.
 * Injected by the harness after onPageFinished. All reporting goes through
 * window.Harness.report() -> file + logcat (tag LAMPAJS). */
(function () {
  'use strict';

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  var H = {
    rep: function (o) {
      o.ts = Date.now();
      var line = safe(function () { return JSON.stringify(o); }, '{}');
      try { Harness.report(line); } catch (e) {
        try { Harness.log('report failed: ' + e); } catch (_) {}
      }
      return line;
    },
    txt: function (sel) {
      var e = document.querySelector(sel);
      return e ? String(e.textContent || '').replace(/\s+/g, ' ').trim() : null;
    },
    badges: function () {
      return Array.prototype.map.call(document.querySelectorAll('#iso .badge'), function (b) {
        return String(b.textContent || '').trim();
      });
    },
    logText: function () { return (H.txt('#log') || '').slice(-1200); },
    video: function () {
      var v = document.querySelector('#v');
      if (!v) return null;
      return {
        muted: v.muted, paused: v.paused, readyState: v.readyState,
        currentTime: Math.round((v.currentTime || 0) * 100) / 100,
        duration: isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : null,
        networkState: v.networkState,
        error: v.error ? (v.error.code + ':' + v.error.message) : null,
        src: String(v.currentSrc || v.src || '').slice(0, 160)
      };
    },
    caps: function () {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      return {
        secure: !!self.isSecureContext,
        crossOriginIsolated: !!self.crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer,
        audioWorkletNode: typeof AudioWorkletNode,
        audioContextCtor: typeof Ctx,
        webWorker: typeof Worker,
        scriptProcessor: Ctx && Ctx.prototype ? typeof Ctx.prototype.createScriptProcessor : 'n/a',
        mediaRecorder: typeof MediaRecorder,
        userAgent: navigator.userAgent
      };
    },
    snap: function () {
      return {
        href: location.href,
        build: H.txt('#s-build'),
        backend: H.txt('#s-backend'),
        track: H.txt('#s-track'),
        buffer: H.txt('#s-buffer'),
        freq: H.txt('#s-freq'),
        level: H.txt('#s-level'),
        underruns: H.txt('#s-underruns'),
        iso: H.badges(),
        video: H.video(),
        log: H.logText()
      };
    },
    wait: function (cond, timeout, step) {
      return new Promise(function (resolve) {
        var t0 = Date.now();
        (function tick() {
          if (safe(cond, false)) return resolve(true);
          if (Date.now() - t0 > (timeout || 30000)) return resolve(false);
          setTimeout(tick, step || 500);
        })();
      });
    },
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  };

  window.__H = H;
  H.rep({ event: 's1-bootstrap', href: location.href, readyState: document.readyState });
  H.rep({ event: 'console-table', caps: safe(H.caps, null) });
  safe(function () { console.table(H.caps()); });
  safe(function () { console.log('CAPS_JSON ' + JSON.stringify(H.caps())); });

  (async function run() {
    var ready = await H.wait(function () {
      return document.querySelector('#s-build') && document.querySelector('button[data-src]');
    }, 45000, 500);
    H.rep({ event: ready ? 's1-page' : 's1-page-timeout', snap: H.snap() });

    var seq = [
      ['ac3', 'button[data-src*="audio-check-ac3"]'],
      ['eac3', 'button[data-src*="audio-check-eac3"]']
    ];

    for (var i = 0; i < seq.length; i++) {
      var codec = seq[i][0];
      var btn = document.querySelector(seq[i][1]) || document.querySelectorAll('button[data-src]')[i];
      if (!btn) { H.rep({ event: 's1-no-button', codec: codec }); continue; }
      btn.click();
      H.rep({ event: 's1-clicked', codec: codec });
      await H.wait(function () {
        var b = H.txt('#s-backend') || '';
        return /Audio WASM|ScriptProcessor|DTS-декодер/.test(b) && b.indexOf('запуск') < 0;
      }, 60000, 500);
      for (var k = 0; k < 14; k++) {
        H.rep({ event: 's1-playing', codec: codec, k: k, snap: H.snap() });
        await H.sleep(2500);
      }
      H.rep({ event: 's1-codec-done', codec: codec, snap: H.snap() });
    }

    var dts = document.querySelector('#dtsprobe');
    if (dts) { dts.click(); H.rep({ event: 's1-clicked', codec: 'dts' }); }
    await H.wait(function () { return /DTS-декодер/.test(H.txt('#s-backend') || ''); }, 120000, 1000);
    for (var j = 0; j < 6; j++) {
      H.rep({ event: 's1-dts', j: j, snap: H.snap() });
      await H.sleep(2000);
    }
    H.rep({ event: 's1-complete', snap: H.snap() });
  })().catch(function (e) {
    H.rep({ event: 's1-fatal', error: String((e && e.stack) || e) });
  });
})();
