/* Audio-only demux/decode worker. The existing FFmpeg WASM binary is reused; video packets are discarded. */
(function () {
  'use strict';
  var modulePromise, module, selected = -1, nextPtsUs = null, endOfFile = false;
  var VERSION = '20261009-audio-bridge-1';
  function load() {
    if (!modulePromise) {
      importScripts('/mpvwasm/assets/mpvwasm-demuxer.js?v=' + VERSION);
      modulePromise = self.MpvWasmDemuxerModule({
        locateFile: function (name) { return '/mpvwasm/assets/' + name + '?v=' + VERSION; },
        mainScriptUrlOrBlob: '/mpvwasm/assets/mpvwasm-demuxer.js?v=' + VERSION,
        print: function () {}, printErr: function () {}
      }).then(function (instance) { module = instance; return instance; });
    }
    return modulePromise;
  }
  function call(message) {
    var result;
    switch (message.command) {
      case 'open':
        module._demux_close();
        selected = -1;
        nextPtsUs = null;
        endOfFile = false;
        result = module.ccall('demux_open', 'number', ['string'], [String(message.url || '')]);
        if (result < 0) throw Error('Unable to open stream: ' + result);
        var ptr = module._demux_tracks_json();
        try { return JSON.parse(module.UTF8ToString(ptr)); }
        finally { module._demux_free_string(ptr); }
      case 'select':
        selected = Number(message.index);
        result = module._demux_audio_open(selected);
        if (result < 0) { selected = -1; throw Error('Audio decoder unavailable: ' + result); }
        nextPtsUs = null;
        endOfFile = false;
        return { selected: selected, sampleRate: module._demux_audio_sample_rate(), channels: module._demux_audio_pcm_channels() };
      case 'seek':
        result = module._demux_seek(BigInt(Math.max(0, Math.round(Number(message.us || 0)))));
        if (result < 0) throw Error('Audio seek failed: ' + result);
        nextPtsUs = null;
        endOfFile = false;
        return true;
      case 'read':
        if (selected < 0 || endOfFile) return { chunks: [], eof: endOfFile };
        var chunks = [], emittedUs = 0;
        var maxPackets = Math.min(1024, Math.max(1, Number(message.maxPackets || 256)));
        for (var i = 0; i < maxPackets && emittedUs < 700000; i++) {
          result = module._demux_read_packet();
          if (result <= 0) { endOfFile = true; break; }
          if (module._demux_packet_stream_index() !== selected) continue;
          var pts = Number(module._demux_packet_pts_us());
          var samples = module._demux_audio_decode_current_packet();
          if (samples < 0) throw Error('Audio decode failed: ' + samples);
          if (!samples) continue;
          var rate = module._demux_audio_sample_rate(), channels = module._demux_audio_pcm_channels();
          if (rate <= 0 || channels <= 0) throw Error('Invalid decoded audio format');
          var duration = Math.round(samples * 1000000 / rate);
          if (!isFinite(pts) || pts < 0 || pts > 86400000000) pts = nextPtsUs === null ? 0 : nextPtsUs;
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
  self.onmessage = function (event) {
    var message = event.data || {};
    chain = chain.catch(function () {}).then(function () {
      return load().then(function () { return call(message); });
    }).then(function (result) {
      var transfer = [];
      if (result && result.chunks) result.chunks.forEach(function (chunk) { transfer.push(chunk.pcm.buffer); });
      self.postMessage({ id: message.id, ok: true, result: result }, transfer);
    }).catch(function (error) {
      self.postMessage({ id: message.id, ok: false, error: String(error && error.message || error) });
    });
  };
})();
