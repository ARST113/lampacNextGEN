/* S2: real Lampa on https://lampac.fun, with the fake AndroidJS client attached.
 * Proves which of the two built-in players Lampa picks, then forces the inner
 * HTML5 player + Audio WASM bridge and plays the AC3 test file and the real stream. */
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
    wait: function (cond, timeout, step) {
      return new Promise(function (resolve) {
        var t0 = Date.now();
        (function tick() {
          if (safe(cond, false)) return resolve(true);
          if (Date.now() - t0 > (timeout || 30000)) return resolve(false);
          setTimeout(tick, step || 1000);
        })();
      });
    },
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    storage: function (k) { return safe(function () { return Lampa.Storage.get(k); }, null); },
    player: function () { return safe(function () { return Lampa.Storage.field('player'); }, null); },
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
        androidjs: typeof AndroidJS,
        appVersion: safe(function () { return AndroidJS.appVersion(); }, null),
        platform: safe(function () { return Lampa.Platform.get(); }, null),
        userAgent: navigator.userAgent
      };
    },
    video: function () {
      var v = safe(function () { return Lampa.PlayerVideo.video(); }, null);
      if (!v) return null;
      return {
        muted: v.muted, paused: v.paused, readyState: v.readyState,
        currentTime: Math.round((v.currentTime || 0) * 100) / 100,
        duration: isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : null,
        error: v.error ? (v.error.code + ':' + v.error.message) : null,
        src: String(v.currentSrc || v.src || '').slice(0, 180)
      };
    },
    dom: function () {
      return {
        playerOpened: safe(function () { return Lampa.Player.opened(); }, null),
        hasVideoTag: !!document.querySelector('video'),
        bodyClass: document.body.className,
        url: location.href
      };
    }
  };

  window.__H = H;
  H.rep({ event: 's2-bootstrap', href: location.href, readyState: document.readyState });
  H.rep({ event: 'console-table', caps: H.caps() });
  safe(function () { console.table(H.caps()); });
  safe(function () { console.log('CAPS_JSON ' + JSON.stringify(H.caps())); });

  var TEST_AC3 = 'https://lampac.fun/lampac-js/uploads/audio-check-ac3.mp4';
  var STREAM = 'http://213.171.26.189:2367/stream/The.Wild.Robot.2024.1080p.BluRay.x264-ZoroSenpai_EniaHD.mkv'
    + '?link=a374cdc944da7dffb36655f2c97f18cf8c86e957&index=1&play';

  (async function run() {
    var ok = await H.wait(function () {
      return window.Lampa && Lampa.Player && Lampa.Player.play && Lampa.PlayerVideo && Lampa.Storage;
    }, 240000, 1000);
    H.rep({ event: 's2-lampa', ok: !!ok, player: H.player(), caps: H.caps(), dom: H.dom() });
    if (!ok) { H.rep({ event: 's2-no-lampa' }); return; }

    await H.sleep(5000);
    H.rep({ event: 's2-lampa-ready', player: H.player(), dom: H.dom() });

    // Phase 1: default player on Android -> Lampa.Android.openPlayer -> AndroidJS.openPlayer
    H.rep({ event: 's2-phase', phase: 'android-default', player: H.player() });
    Lampa.Player.play({ url: TEST_AC3, title: 'AC3 test (default player)' });
    for (var i = 0; i < 6; i++) {
      await H.sleep(3000);
      H.rep({ event: 's2-android-watch', i: i, player: H.player(), video: H.video(), dom: H.dom() });
    }
    H.rep({ event: 's2-android-done', video: H.video(), dom: H.dom() });
    safe(function () { Lampa.Player.close(); });

    // Phase 2: force the inner player + our Audio WASM plugin
    await H.sleep(3000);
    var prev = H.player();
    safe(function () { Lampa.Storage.set('player', 'inner'); });
    H.rep({ event: 's2-player-set', prev: prev, now: H.player() });
    Lampa.Player.play({ url: TEST_AC3, title: 'AC3 test (inner player)', launch_player: 'inner' });
    for (var j = 0; j < 16; j++) {
      await H.sleep(3000);
      H.rep({ event: 's2-inner-watch', j: j, player: H.player(), video: H.video(), dom: H.dom() });
    }
    H.rep({ event: 's2-inner-done', video: H.video(), dom: H.dom() });
    safe(function () { Lampa.Player.close(); });

    // Phase 3: real 5.1 AC3 stream from the cinema source
    await H.sleep(3000);
    H.rep({ event: 's2-phase', phase: 'real-stream', url: STREAM });
    Lampa.Player.play({ url: STREAM, title: 'Real AC3 5.1 stream', launch_player: 'inner' });
    for (var m = 0; m < 14; m++) {
      await H.sleep(4000);
      H.rep({ event: 's2-stream-watch', m: m, player: H.player(), video: H.video(), dom: H.dom() });
    }
    H.rep({ event: 's2-complete', video: H.video(), dom: H.dom() });
  })().catch(function (e) {
    H.rep({ event: 's2-fatal', error: String((e && e.stack) || e) });
  });
})();
