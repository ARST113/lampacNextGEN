(function () {
  'use strict';

  var VERSION = '20260708-80-mpv2-only';
  var modulePromise = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (window.MpvWasmDemuxerModule) return resolve();
      var script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('Unable to load ' + src)); };
      document.head.appendChild(script);
    });
  }

  function absoluteUrl(url) {
    if (/^\//.test(String(url || ''))) return window.location.origin + url;
    return String(url || '');
  }

  function loadModule() {
    if (modulePromise) return modulePromise;
    modulePromise = loadScript('/mpvwasm/assets/mpvwasm-demuxer.js?v=' + VERSION).then(function () {
      if (typeof window.MpvWasmDemuxerModule !== 'function') throw new Error('MpvWasmDemuxerModule was not found');
      return window.MpvWasmDemuxerModule({
        locateFile: function (file) {
          return '/mpvwasm/assets/' + file + '?v=' + VERSION;
        },
        print: function () { },
        printErr: function (message) {
          if (window.__MPV_WASM_DEBUG) console.warn('[mpvwasm-demuxer]', message);
        }
      });
    });
    return modulePromise;
  }

  function DemuxSession(module, tracks) {
    this.module = module;
    this.tracks = tracks || [];
    this.trackByIndex = {};
    this.tracks.forEach(function (track) {
      this.trackByIndex[track.index] = track;
    }, this);
  }

  DemuxSession.prototype.readPacket = function () {
    var module = this.module;
    var ret = module._demux_read_packet();
    if (ret <= 0) return null;
    var streamIndex = module._demux_packet_stream_index();
    var size = module._demux_packet_size();
    var ptr = module._demux_packet_data();
    var data = new Uint8Array(size);
    if (size > 0 && ptr) data.set(module.HEAPU8.subarray(ptr, ptr + size));
    var track = this.trackByIndex[streamIndex] || {};
    return {
      streamIndex: streamIndex,
      type: track.type || 'other',
      data: data,
      ptsUs: Number(module._demux_packet_pts_us()),
      dtsUs: Number(module._demux_packet_dts_us()),
      durationUs: Number(module._demux_packet_duration_us()),
      keyframe: !!module._demux_packet_keyframe()
    };
  };

  DemuxSession.prototype.seek = function (timeUs) {
    return this.module._demux_seek(BigInt(Math.max(0, Math.round(Number(timeUs || 0)))));
  };

  DemuxSession.prototype.openAudioDecoder = function (trackIndex) {
    return this.module._demux_audio_open(Number(trackIndex));
  };

  DemuxSession.prototype.decodeCurrentAudioPacket = function () {
    var module = this.module;
    var samples = module._demux_audio_decode_current_packet();
    if (samples <= 0) return samples < 0 ? { error: samples } : null;
    var channels = module._demux_audio_pcm_channels();
    var ptr = module._demux_audio_pcm_ptr();
    var total = samples * channels;
    var bytes = module.HEAPU8.subarray(ptr, ptr + total * 4);
    var copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return {
      samples: samples,
      channels: channels,
      sampleRate: module._demux_audio_sample_rate(),
      pcm: new Float32Array(copy.buffer)
    };
  };

  DemuxSession.prototype.closeAudioDecoder = function () {
    try { this.module._demux_audio_close(); } catch (_) { }
  };

  DemuxSession.prototype.close = function () {
    this.closeAudioDecoder();
    try { this.module._demux_close(); } catch (_) { }
  };

  async function open(url) {
    var module = await loadModule();
    var ret = module.ccall('demux_open', 'number', ['string'], [absoluteUrl(url)]);
    if (ret < 0) throw new Error('demux_open failed: ' + ret);
    var ptr = module._demux_tracks_json();
    var json = module.UTF8ToString(ptr);
    module._demux_free_string(ptr);
    var info = JSON.parse(json);
    var session = new DemuxSession(module, info.tracks || []);
    session.info = info;
    return session;
  }

  window.MpvWasmDemuxer = {
    version: VERSION,
    load: loadModule,
    open: open
  };
})();
