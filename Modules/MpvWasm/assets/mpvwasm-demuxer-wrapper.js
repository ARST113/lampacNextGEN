(function () {
  'use strict';

  var VERSION = '20260708-87-range-cache';
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

  function WorkerDemuxSession(worker, info) {
    this.worker = worker;
    this.info = info || {};
    this.tracks = this.info.tracks || [];
    this.trackByIndex = {};
    this.async = true;
    this.nextId = 1;
    this.pending = {};
    this.closed = false;
    this.packetQueue = [];
    this.batchLimit = 64;
    var self = this;
    this.tracks.forEach(function (track) {
      self.trackByIndex[track.index] = track;
    });
    worker.onmessage = function (event) {
      var message = event.data || {};
      var pending = self.pending[message.id];
      if (!pending) return;
      delete self.pending[message.id];
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || 'demux worker error'));
    };
    worker.onerror = function (event) {
      var error = new Error(event.message || 'demux worker crashed');
      Object.keys(self.pending).forEach(function (id) {
        self.pending[id].reject(error);
        delete self.pending[id];
      });
    };
  }

  WorkerDemuxSession.prototype.call = function (type, payload) {
    if (this.closed && type !== 'close') return Promise.resolve(null);
    var id = this.nextId++;
    var message = Object.assign({ id: id, type: type }, payload || {});
    var self = this;
    return new Promise(function (resolve, reject) {
      self.pending[id] = { resolve: resolve, reject: reject };
      self.worker.postMessage(message);
    });
  };

  WorkerDemuxSession.prototype.readPacket = function () {
    if (this.packetQueue.length) return Promise.resolve(this.packetQueue.shift());
    var self = this;
    return this.call('readBatch', { limit: this.batchLimit }).then(function (packets) {
      packets = packets || [];
      if (!packets.length) return null;
      self.packetQueue = packets.slice(1);
      return packets[0];
    });
  };

  WorkerDemuxSession.prototype.seek = function (timeUs) {
    this.packetQueue = [];
    return this.call('seek', { timeUs: Math.max(0, Math.round(Number(timeUs || 0))) });
  };

  WorkerDemuxSession.prototype.openAudioDecoder = function (trackIndex) {
    return this.call('openAudioDecoder', { trackIndex: Number(trackIndex) });
  };

  WorkerDemuxSession.prototype.decodeCurrentAudioPacket = function () {
    return this.call('decodeCurrentAudioPacket');
  };

  WorkerDemuxSession.prototype.closeAudioDecoder = function () {
    return this.call('closeAudioDecoder');
  };

  WorkerDemuxSession.prototype.close = function () {
    if (this.closed) return Promise.resolve(0);
    var worker = this.worker;
    var self = this;
    return this.call('close').catch(function () { }).then(function () {
      self.closed = true;
      try { worker.terminate(); } catch (_) { }
      return 0;
    });
  };

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

  async function openWorker(url) {
    if (typeof Worker !== 'function') return open(url);
    var worker = new Worker('/mpvwasm/assets/mpvwasm-demuxer-session-worker.js?v=' + VERSION, { name: 'mpvwasm-demuxer-session' });
    var session = new WorkerDemuxSession(worker, {});
    var info = await session.call('open', { url: absoluteUrl(url) });
    session.info = info || {};
    session.tracks = session.info.tracks || [];
    session.trackByIndex = {};
    session.tracks.forEach(function (track) {
      session.trackByIndex[track.index] = track;
    });
    session.workerTiming = session.info.workerTiming || null;
    return session;
  }

  window.MpvWasmDemuxer = {
    version: VERSION,
    load: loadModule,
    open: open,
    openWorker: openWorker
  };
})();
