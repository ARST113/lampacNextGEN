/* Audio-only demux/decode worker. The existing FFmpeg WASM binary is reused; video packets are discarded. */
(function () {
  'use strict';
  var modulePromise, module, selected = -1, nextPtsUs = null, endOfFile = false;
  var VERSION = '20261010-android-9';
  // Android WebView (и любой обычный http-контекст без COOP/COEP) не даёт SharedArrayBuffer,
  // поэтому старая многопоточная сборка демуксера там просто не грузится. Выбираем сборку:
  //   crossOriginIsolated + SharedArrayBuffer -> mpvwasm-demuxer.js      (pthread, как раньше)
  //   иначе                                  -> mpvwasm-demuxer-st.js   (single-thread)
  var SINGLE_THREAD = !(typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated);
  var GLUE = SINGLE_THREAD ? 'mpvwasm-demuxer-st.js' : 'mpvwasm-demuxer.js';
  function instantiate(glue) {
    importScripts('/mpvwasm/assets/' + glue + '?v=' + VERSION);
    return self.MpvWasmDemuxerModule({
      locateFile: function (name) { return '/mpvwasm/assets/' + name + '?v=' + VERSION; },
      mainScriptUrlOrBlob: '/mpvwasm/assets/' + glue + '?v=' + VERSION,
      print: function () {}, printErr: function () {}
    });
  }
  // Есть ли в WebAssembly поддержка BigInt (i64 в сигнатурах)? Появилась только в Chrome 85,
  // а сборка с -sWASM_BIGINT=1 на старом WebView падает уже на вызове экспортированной функции
  // ("wasm function signature contains illegal type"). Проверяем пробным модулем.
  function supportsBigIntWasm() {
    try {
      var module = new WebAssembly.Module(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0,
        1, 5, 1, 96, 1, 126, 0,
        3, 2, 1, 0,
        7, 7, 1, 3, 102, 111, 111, 0, 0,
        10, 4, 1, 2, 0, 11
      ]));
      var instance = new WebAssembly.Instance(module, {});
      instance.exports.foo(1n);   // Chromium < 85 падает здесь: "wasm function signature contains illegal type"
      return true;
    } catch (error) { return false; }
  }
  var BIGINT_WASM = typeof WebAssembly === 'object' && supportsBigIntWasm();
  // Порядок попыток. legacy — однопоточная сборка без WASM_BIGINT (для WebView/Chrome < 85).
  var CANDIDATES = BIGINT_WASM
    ? (SINGLE_THREAD
        ? ['mpvwasm-demuxer-st.js', 'mpvwasm-demuxer-st-legacy.js', 'mpvwasm-demuxer.js']
        : ['mpvwasm-demuxer.js', 'mpvwasm-demuxer-st.js', 'mpvwasm-demuxer-st-legacy.js'])
    : (SINGLE_THREAD
        ? ['mpvwasm-demuxer-st-legacy.js', 'mpvwasm-demuxer-st.js', 'mpvwasm-demuxer.js']
        : ['mpvwasm-demuxer-st-legacy.js', 'mpvwasm-demuxer.js', 'mpvwasm-demuxer-st.js']);
  var lastOpen = null, lastSelectIndex = -1, lastSeekUs = 0, LEGACY = false;
  function load() {
    if (!modulePromise) {
      var chain = Promise.reject(Error('start'));
      CANDIDATES.forEach(function (glue) {
        chain = chain.catch(function () {
          return instantiate(glue).then(function (instance) {
            GLUE = glue;
            SINGLE_THREAD = glue.indexOf('mpvwasm-demuxer.js') < 0;
            LEGACY = glue.indexOf('legacy') >= 0;
            module = instance;
            return instance;
          });
        });
      });
      modulePromise = chain;
    }
    return modulePromise;
  }
  // Рантайм-фолбэк: если на этой сборке вызов упал на несовместимости wasm,
  // откатываемся на следующую сборку и повторяем сессию (open -> select -> seek -> команда).
  function switchBuildAndReplay(message) {
    CANDIDATES = CANDIDATES.slice(1);
    if (!CANDIDATES.length) return null;
    module = null; modulePromise = null; selected = -1; nextPtsUs = null; endOfFile = false;
    return load().then(function () {
      if (lastOpen) call(lastOpen);
      if (lastSelectIndex >= 0) call({ command: 'select', index: lastSelectIndex });
      if (lastSeekUs > 0) call({ command: 'seek', us: lastSeekUs });
      return call(message);
    });
  }
  function isWasmCompatError(error) {
    var text = String((error && error.message) || error || '').toLowerCase();
    return text.indexOf('illegal type') >= 0 || text.indexOf('function signature') >= 0 ||
           text.indexOf('wasm') >= 0 && text.indexOf('signature') >= 0 ||
           text.indexOf('audio decoder unavailable') >= 0;
  }
  // В legacy-сборке (WASM_BIGINT=0) i64-аргументы разложены на две 32-битные половины,
  // а функции с i64-возвратом на старом WebView вообще вызывать нельзя.
  function seekCall(us) {
    if (LEGACY) {
      return module._demux_seek(us >>> 0, Math.floor(us / 4294967296));
    }
    return module._demux_seek(BigInt(us));
  }
  function packetPtsUs() {
    if (LEGACY) return NaN;
    return Number(module._demux_packet_pts_us());
  }
  function call(message) {
    var result;
    switch (message.command) {
      case 'open':
        lastOpen = message;
        lastSelectIndex = -1;
        lastSeekUs = 0;
        module._demux_close();
        selected = -1;
        nextPtsUs = LEGACY ? 0 : null;
        endOfFile = false;
        result = module.ccall('demux_open', 'number', ['string'], [String(message.url || '')]);
        if (result < 0) throw Error('Unable to open stream: ' + result);
        var ptr = module._demux_tracks_json();
        try { return JSON.parse(module.UTF8ToString(ptr)); }
        finally { module._demux_free_string(ptr); }
      case 'info':
        return { glue: GLUE, singleThread: SINGLE_THREAD, bigIntWasm: BIGINT_WASM, legacy: LEGACY, version: VERSION,
                 sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
                 crossOriginIsolated: !!self.crossOriginIsolated };
      case 'select':
        selected = Number(message.index);
        lastSelectIndex = selected;
        result = module._demux_audio_open(selected);
        if (result < 0) { selected = -1; throw Error('Audio decoder unavailable: ' + result); }
        nextPtsUs = null;
        endOfFile = false;
        return { selected: selected, sampleRate: module._demux_audio_sample_rate(), channels: module._demux_audio_pcm_channels() };
      case 'seek':
        // Демуксер считает 0 «пустой» целью и отдаёт -1: ровно в начало файла
        // он не встаёт. 1 мкс работает и эквивалентен началу.
        lastSeekUs = Math.max(1, Math.round(Number(message.us || 0)));
        result = seekCall(lastSeekUs);
        if (result < 0) throw Error('Audio seek failed: ' + result);
        nextPtsUs = LEGACY ? lastSeekUs : null;
        endOfFile = false;
        return true;
      case 'read':
        if (selected < 0 || endOfFile) return { chunks: [], eof: endOfFile };
        var chunks = [], emittedUs = 0;
        var maxPackets = Math.min(4096, Math.max(1, Number(message.maxPackets || 1024)));
        for (var i = 0; i < maxPackets && emittedUs < 2500000; i++) {
          result = module._demux_read_packet();
          if (result <= 0) { endOfFile = true; break; }
          if (module._demux_packet_stream_index() !== selected) continue;
          var pts = packetPtsUs();
          var samples = module._demux_audio_decode_current_packet();
          if (samples < 0) throw Error('Audio decode failed: ' + samples);
          if (!samples) continue;
          var rate = module._demux_audio_sample_rate(), channels = module._demux_audio_pcm_channels();
          if (rate <= 0 || channels <= 0) throw Error('Invalid decoded audio format');
          var duration = Math.round(samples * 1000000 / rate);
          if (!isFinite(pts) || pts < 0 || pts > 86400000000) pts = nextPtsUs === null ? lastSeekUs : nextPtsUs;
          // The decoder can output delayed frames. Keep timestamps monotonic for contiguous PCM.
          if (nextPtsUs !== null && Math.abs(pts - nextPtsUs) < 120000) pts = nextPtsUs;
          var pointer = module._demux_audio_pcm_ptr();
          var copy = new Float32Array(samples * channels);
          copy.set(new Float32Array(module.HEAPU8.buffer, pointer, samples * channels));
          chunks.push({ pcm: copy, channels: channels, sampleRate: rate, ptsUs: pts });
          nextPtsUs = pts + duration;
          emittedUs += duration;
        }
        return { chunks: chunks, eof: endOfFile };
      case 'close':
        module._demux_audio_close();
        module._demux_close();
        selected = -1;
        nextPtsUs = null;
        endOfFile = false;
        return true;
      default: throw Error('Unknown audio worker command');
    }
  }
  // Serialize commands, including asynchronous module initialization.
  var chain = Promise.resolve();
  function answer(message, result) {
    var transfer = [];
    if (result && result.chunks) result.chunks.forEach(function (chunk) { transfer.push(chunk.pcm.buffer); });
    self.postMessage({ id: message.id, ok: true, result: result }, transfer);
  }
  function execute(message) {
    chain = chain.catch(function () {}).then(function () {
      return load().then(function () { return call(message); });
    });
    return chain;
  }
  self.onmessage = function (event) {
    var message = event.data || {};
    execute(message).then(function (result) {
      answer(message, result);
    }).catch(function (error) {
      var retry = isWasmCompatError(error) ? switchBuildAndReplay(message) : null;
      if (!retry) {
        self.postMessage({ id: message.id, ok: false, error: String((error && error.message) || error) });
        return;
      }
      retry.then(function (result) { answer(message, result); })
        .catch(function (second) {
          self.postMessage({ id: message.id, ok: false, error: String((second && second.message) || second) });
        });
    });
  };
})();
