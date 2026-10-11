/* MPV2-PROBE v1 — временная диагностика MPV2 на телефоне (11.10.2026).
   Пишет маячки в nginx-лог: окружение, консольные логи mpv2/mpvwasm, ошибки страницы,
   ошибки <video>, конфиги VideoDecoder, стек вызовов play()/pause() и снимки метрик.
   Транспорт — как у nav-probe: sendBeacon на /lampac-js/uploads/mpv2-probe/b-<b64>.gif */
(function () {
  try {
    if (window.__mpv2Probe) return;
    window.__mpv2Probe = 1;
    window.__MPV_WASM_DEBUG = true;

    var MAX = 240, sent = 0, seen = {};
    var t0 = Date.now();

    function b64(s) {
      try {
        return btoa(unescape(encodeURIComponent(s)))
          .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
      } catch (e) { return 'x'; }
    }

    function send(kind, data) {
      if (sent >= MAX) return;
      try {
        var payload = { k: kind, t: Date.now() - t0, d: data };
        var key = kind + '|' + JSON.stringify(data).slice(0, 160);
        if (seen[key]) return;
        seen[key] = 1;
        sent++;
        var url = '/lampac-js/uploads/mpv2-probe/b-' + b64(JSON.stringify(payload)) + '.gif';
        if (navigator.sendBeacon) navigator.sendBeacon(url);
        else { var im = new Image(); im.src = url; }
      } catch (e) { }
    }

    function short(v, n) {
      var s = '';
      try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { s = String(v); }
      s = String(s == null ? '' : s).replace(/\s+/g, ' ');
      return s.length > (n || 260) ? s.slice(0, n || 260) + '…' : s;
    }

    // ---------- окружение ----------
    function env() {
      var o = {
        ua: short(navigator.userAgent, 150),
        iso: window.crossOriginIsolated,
        sab: typeof SharedArrayBuffer,
        vd: typeof VideoDecoder,
        aw: typeof AudioWorkletNode,
        hc: navigator.hardwareConcurrency || 0,
        dm: navigator.deviceMemory || 0,
        vis: document.visibilityState,
        mode: (function () { try { return window.Lampa && Lampa.Storage ? Lampa.Storage.get('mpvwasm_player_mode', '?') : '?'; } catch (e) { return '?'; } })(),
        plugin: window.__mpvwasm_lampa_plugin || null
      };
      send('env', o);
    }

    function probeCodecs() {
      if (!window.VideoDecoder || !VideoDecoder.isConfigSupported) return;
      var cfgs = [
        { codec: 'avc1.42e01e', codedWidth: 1280, codedHeight: 720 },
        { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 },
        { codec: 'avc1.640032', codedWidth: 1920, codedHeight: 1080 },
        { codec: 'hvc1.1.6.L120.B0', codedWidth: 1920, codedHeight: 1080 },
        { codec: 'hev1.1.6.L120.B0', codedWidth: 1920, codedHeight: 1080 },
        { codec: 'av01.0.12M.08', codedWidth: 1920, codedHeight: 1080 },
        { codec: 'av01.0.08M.08', codedWidth: 1920, codedHeight: 1080 },
        { codec: 'av01.0.12M.10', codedWidth: 1920, codedHeight: 1080 }
      ];
      cfgs.forEach(function (cfg, i) {
        var variants = [
          Object.assign({ hardwareAcceleration: 'prefer-hardware' }, cfg),
          Object.assign({ hardwareAcceleration: 'no-preference' }, cfg),
          Object.assign({ hardwareAcceleration: 'prefer-software' }, cfg)
        ];
        variants.forEach(function (v) {
          try {
            VideoDecoder.isConfigSupported(v).then(function (res) {
              send('codec', { c: v.codec, hw: v.hardwareAcceleration, ok: !!(res && res.supported) });
            }, function (e) { send('codec', { c: v.codec, hw: v.hardwareAcceleration, err: short(e && e.message || e, 60) }); });
          } catch (e) { send('codec', { c: v.codec, err: short(e && e.message || e, 60) }); }
        });
      });
    }

    // ---------- консоль ----------
    ['warn', 'error', 'log'].forEach(function (level) {
      var orig = console[level];
      console[level] = function () {
        try {
          var parts = [];
          for (var i = 0; i < arguments.length; i++) {
            var a = arguments[i];
            if (a instanceof Error) parts.push(a.message + ' @ ' + short(a.stack, 200));
            else if (typeof a === 'object') parts.push(short(a, 300));
            else parts.push(String(a));
          }
          var text = parts.join(' ');
          if (/mpv|MPV|decod|Decod|VideoDecoder|webcodecs|WebCodecs|demux|Demux|AudioWorklet|play\(\)|pause\(\)/i.test(text)) {
            send('console', { l: level, m: short(text, 300) });
          }
        } catch (e) { }
        return orig.apply(console, arguments);
      };
    });

    // ---------- ошибки страницы ----------
    window.addEventListener('error', function (e) {
      send('onerror', {
        m: short(e && e.message, 200),
        src: short(e && e.filename, 90),
        ln: e && e.lineno, col: e && e.colno,
        st: short(e && e.error && e.error.stack, 260)
      });
    }, true);
    window.addEventListener('unhandledrejection', function (e) {
      send('reject', { m: short(e && e.reason && (e.reason.stack || e.reason.message) || e.reason, 260) });
    });

    // ---------- VideoDecoder: конфиг и ошибки ----------
    try {
      if (window.VideoDecoder) {
        var VD = window.VideoDecoder;
        var conf = VD.prototype.configure;
        VD.prototype.configure = function (cfg) {
          try {
            send('vd-conf', {
              c: cfg && cfg.codec,
              hw: cfg && cfg.hardwareAcceleration,
              w: cfg && cfg.codedWidth, h: cfg && cfg.codedHeight,
              desc: cfg && cfg.description ? (cfg.description.byteLength || cfg.description.length || 0) : 0,
              fmt: cfg && cfg.avc && cfg.avc.format
            });
          } catch (e) { }
          return conf.apply(this, arguments);
        };
        var Wrapped = function (init) {
          var inst = new VD(init);
          try {
            inst.addEventListener('error', function (ev) {
              var err = inst.__mpv2_err;
              send('vd-err', {
                m: short((ev && ev.error && ev.error.message) || (err && err.message) || 'unknown', 120),
                state: (function () { try { return inst.state; } catch (e) { return '?'; } })(),
                q: (function () { try { return inst.decodeQueueSize; } catch (e) { return -1; } })()
              });
            });
          } catch (e) { }
          return inst;
        };
        Wrapped.prototype = VD.prototype;
        Wrapped.isConfigSupported = VD.isConfigSupported ? VD.isConfigSupported.bind(VD) : undefined;
        window.VideoDecoder = Wrapped;
      }
    } catch (e) { }

    // ---------- <video> и play/pause ----------
    function mediaInfo(v) {
      var o = { rs: v.readyState, ns: v.networkState, t: Math.round((v.currentTime || 0) * 100) / 100, p: v.paused };
      if (v.error) { o.ec = v.error.code; o.em = short(v.error.message, 120); }
      if (v.videoWidth) { o.w = v.videoWidth; o.h = v.videoHeight; }
      try { o.src = short(v.currentSrc || v.src, 70); } catch (e) { }
      return o;
    }
    ['error', 'stalled', 'waiting', 'playing', 'pause', 'ended', 'emptied', 'abort'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        var v = e.target;
        if (!v || v.tagName !== 'VIDEO') return;
        send('media', { ev: ev, i: mediaInfo(v) });
      }, true);
    });
    try {
      var play = HTMLMediaElement.prototype.play, pause = HTMLMediaElement.prototype.pause;
      HTMLMediaElement.prototype.play = function () {
        var st = '';
        try { st = short(new Error('s').stack, 200); } catch (e) { }
        send('mp', { a: 'play', st: st });
        return play.apply(this, arguments);
      };
      HTMLMediaElement.prototype.pause = function () {
        var st = '';
        try { st = short(new Error('s').stack, 200); } catch (e) { }
        send('mp', { a: 'pause', st: st });
        return pause.apply(this, arguments);
      };
    } catch (e) { }

    // ---------- собственный лог плеера (console перехватывают плагины Lampa) ----------
    var logSent = 0;
    function pumpPlayerLog() {
      var arr = window.__mpvwasm_log;
      if (!arr || !arr.length) return;
      if (arr.length < logSent) logSent = 0;
      var batch = arr.slice(logSent, logSent + 4);
      logSent = Math.min(arr.length, logSent + batch.length);
      batch.forEach(function (e) {
        send('mlog', { a: e && e.action, d: short(e && e.data, 420) });
      });
    }

    // ---------- снимки метрик MPV2 ----------
    var ticks = 0;
    var timer = setInterval(function () {
      ticks++;
      var d = window.__mpvwasm_hybrid_debug;
      if (d) {
        send('metrics', {
          b: d.backend, c: d.codec, dec: d.decodedFrames, ren: d.renderedFrames, dr: d.droppedFrames,
          drift: d.driftMs, thr: d.throttleReason, un: d.audioUnderruns, ac: d.audioOutputChannels,
          asrc: d.audioSourceChannels, srv: d.audioSampleRate, st: d.audioContextState, err: short(d.lastError, 120)
        });
      }
      pumpPlayerLog();
      var v = document.querySelector('video');
      if (v && ticks % 3 === 0) send('video', mediaInfo(v));
      if (ticks > 60) { clearInterval(timer); send('probe-end', { sent: sent }); }
    }, 2000);

    if (document.readyState === 'complete' || document.readyState === 'interactive') { env(); probeCodecs(); }
    else document.addEventListener('DOMContentLoaded', function () { env(); probeCodecs(); });
    window.addEventListener('load', function () { setTimeout(env, 1500); });
    setInterval(pumpPlayerLog, 1500);
    setTimeout(function () {
      var assets = [];
      try {
        performance.getEntriesByType('resource').forEach(function (r) {
          if (/mpvwasm/.test(r.name)) {
            var u = r.name.replace(location.origin, '').split('?')[0];
            if (assets.indexOf(u) < 0) assets.push(u);
          }
        });
      } catch (e) { }
      send('assets', { a: assets.slice(0, 25) });
    }, 20000);
  } catch (e) { }
})();
