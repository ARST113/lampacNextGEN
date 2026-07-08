(function () {
  'use strict';

  var VERSION = '20260708-93-seek-drop-debug';
  var modulePromise = null;
  var module = null;
  var info = null;
  var trackByIndex = {};
  var audioTrackIndex = null;
  var workerTiming = { version: VERSION, createdAt: Date.now() };

  function absoluteUrl(url) {
    if (/^\//.test(String(url || ''))) return self.location.origin + url;
    return String(url || '');
  }

  function loadModule() {
    if (modulePromise) return modulePromise;
    workerTiming.moduleLoadStartAt = Date.now();
    importScripts('/mpvwasm/assets/mpvwasm-demuxer.js?v=' + VERSION);
    modulePromise = self.MpvWasmDemuxerModule({
      locateFile: function (file) {
        return '/mpvwasm/assets/' + file + '?v=' + VERSION;
      },
      mainScriptUrlOrBlob: '/mpvwasm/assets/mpvwasm-demuxer.js?v=' + VERSION,
      print: function () { },
      printErr: function (message) {
        if (self.__MPV_WASM_DEBUG) console.warn('[mpvwasm-demuxer-worker]', message);
      }
    }).then(function (loaded) {
      module = loaded;
      workerTiming.moduleReadyAt = Date.now();
      workerTiming.moduleLoadMs = workerTiming.moduleReadyAt - workerTiming.moduleLoadStartAt;
      return module;
    });
    return modulePromise;
  }

  function open(url) {
    workerTiming.demuxOpenStartAt = Date.now();
    var ret = module.ccall('demux_open', 'number', ['string'], [absoluteUrl(url)]);
    if (ret < 0) throw new Error('demux_open failed: ' + ret);
    var ptr = module._demux_tracks_json();
    var json = module.UTF8ToString(ptr);
    module._demux_free_string(ptr);
    info = JSON.parse(json);
    trackByIndex = {};
    (info.tracks || []).forEach(function (track) {
      trackByIndex[track.index] = track;
    });
    audioTrackIndex = null;
    workerTiming.demuxOpenEndAt = Date.now();
    workerTiming.demuxOpenMs = workerTiming.demuxOpenEndAt - workerTiming.demuxOpenStartAt;
    info.workerTiming = Object.assign({}, workerTiming);
    return info;
  }

  function copyPacketData(ptr, size) {
    var data = new Uint8Array(size);
    if (size > 0 && ptr) data.set(module.HEAPU8.subarray(ptr, ptr + size));
    return data;
  }

  function decodeAudioPacket() {
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
  }

  function readPacket() {
    var ret = module._demux_read_packet();
    if (ret <= 0) return null;
    if (!workerTiming.firstPacketAt) workerTiming.firstPacketAt = Date.now();
    var streamIndex = module._demux_packet_stream_index();
    var size = module._demux_packet_size();
    var data = copyPacketData(module._demux_packet_data(), size);
    var track = trackByIndex[streamIndex] || {};
    var packet = {
      streamIndex: streamIndex,
      type: track.type || 'other',
      data: data,
      ptsUs: Number(module._demux_packet_pts_us()),
      dtsUs: Number(module._demux_packet_dts_us()),
      durationUs: Number(module._demux_packet_duration_us()),
      keyframe: !!module._demux_packet_keyframe()
    };
    if (audioTrackIndex !== null && streamIndex === audioTrackIndex) {
      packet.decodedAudio = decodeAudioPacket();
    }
    return packet;
  }

  function readBatch(limit) {
    var packets = [];
    var count = Math.max(1, Math.min(128, Number(limit || 64)));
    for (var i = 0; i < count; i++) {
      var packet = readPacket();
      if (!packet) break;
      packets.push(packet);
    }
    return packets;
  }

  function transferList(value) {
    var list = [];
    if (Array.isArray(value)) {
      value.forEach(function (item) {
        list = list.concat(transferList(item));
      });
      return list;
    }
    if (value && value.data && value.data.buffer) list.push(value.data.buffer);
    if (value && value.decodedAudio && value.decodedAudio.pcm && value.decodedAudio.pcm.buffer) list.push(value.decodedAudio.pcm.buffer);
    return list;
  }

  async function handle(message) {
    await loadModule();
    switch (message.type) {
      case 'open':
        return open(message.url);
      case 'readPacket':
        return readPacket();
      case 'readBatch':
        return readBatch(message.limit);
      case 'seek':
        return module._demux_seek(BigInt(Math.max(0, Math.round(Number(message.timeUs || 0)))));
      case 'openAudioDecoder':
        audioTrackIndex = Number(message.trackIndex);
        return module._demux_audio_open(audioTrackIndex);
      case 'closeAudioDecoder':
        audioTrackIndex = null;
        try { module._demux_audio_close(); } catch (_) { }
        return 0;
      case 'decodeCurrentAudioPacket':
        return decodeAudioPacket();
      case 'close':
        audioTrackIndex = null;
        try { module._demux_audio_close(); } catch (_) { }
        try { module._demux_close(); } catch (_) { }
        return 0;
      default:
        throw new Error('Unknown demux worker command: ' + message.type);
    }
  }

  self.onmessage = function (event) {
    var message = event.data || {};
    handle(message).then(function (result) {
      self.postMessage({ id: message.id, ok: true, result: result }, transferList(result));
    }).catch(function (error) {
      self.postMessage({ id: message.id, ok: false, error: String(error && (error.stack || error.message || error) || error) });
    });
  };
})();
