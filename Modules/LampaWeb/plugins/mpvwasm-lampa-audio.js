/* Additional AC3 / EAC3 / DTS audio decoding for the ORIGINAL Lampa video player.
 * No replacement video element, no video remuxing and no external player UI.
 * The existing MPV2 plugin is deliberately left untouched.
 */
(function () {
  'use strict';
  if (window.__lampa_audio_wasm_bridge_v1) return;
  window.__lampa_audio_wasm_bridge_v1 = true;

  var VERSION = '20261009-audio-bridge-1';
  var CODECS = { ac3: true, eac3: true, dts: true, dca: true };
  var session = null, sessionNumber = 0;

  function storage(key, fallback) {
    try { return Lampa.Storage.get(key, fallback); } catch (_) { return fallback; }
  }
  function notice(message) {
    console.warn('[Lampa Audio WASM] ' + message);
    try { if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message); } catch (_) {}
  }
  function codecName(track) {
    var name = String(track.codecName || track.codec_name || '').toLowerCase();
    if (name === 'eac3' || name === 'e-ac-3') return 'eac3';
    if (name === 'ac3' || name === 'ac-3') return 'ac3';
    if (name.indexOf('dts') === 0 || name === 'dca') return 'dts';
    return name;
  }
  function needsDecoder(video, track, mode) {
    var codec = codecName(track);
    if (!CODECS[codec] || mode === 'off') return false;
    if (mode === 'force') return true;
    var label = codec === 'ac3' ? 'ac-3' : codec === 'eac3' ? 'ec-3' : 'dtsc';
    try { return !video.canPlayType('audio/mp4; codecs="' + label + '"'); }
    catch (_) { return true; }
  }
  function base64Url(value) {
    var bytes = new TextEncoder().encode(value);
    var text = '';
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return btoa(text).split('+').join('-').split('/').join('_').replace(/=+$/, '');
  }
  function sourceUrl(video) {
    return String(video.currentSrc || video.src || '');
  }
  function proxyUrl(url) {
    // Using the existing MPV WASM proxy ensures the worker can read HTTP byte ranges
    // even when the source server does not provide cross-origin access.
    return '/mpvwasm/proxy?u=' + base64Url(url);
  }
  function AudioSession(video, data) {
    this.video = video;
    this.data = data || {};
    this.id = ++sessionNumber;
    this.closed = false;
    this.worker = null;
    this.workerId = 0;
    this.pending = {};
    this.ctx = null;
    this.node = null;
    this.tracks = [];
    this.selection = -1;
    this.selectedCodec = '';
    this.active = false;
    this.ready = false;
    this.opened = false;
    this.reading = false;
    this.eof = false;
    this.bufferedUs = 0;
    this.timer = null;
    this.lastSeek = -1;
    this.epoch = 0;
    this.lastError = '';
    this.mode = storage('mpvwasm_audio_mode', 'auto');
    this.url = sourceUrl(video);
    this.originalMuted = !!video.muted;
    var self = this;
    this.onNativeSeek = function () { self.seek(); };
    video.addEventListener('seeking', this.onNativeSeek);
  }
  AudioSession.prototype.request = function (command, payload) {
    var self = this;
    if (self.closed || !self.worker) return Promise.reject(Error('Audio session closed'));
    var id = ++self.workerId;
    return new Promise(function (resolve, reject) {
      self.pending[id] = { resolve: resolve, reject: reject };
      try { self.worker.postMessage(Object.assign({ id: id, command: command }, payload || {})); }
      catch (error) { delete self.pending[id]; reject(error); }
    });
  };
  AudioSession.prototype.createWorker = function () {
    var self = this;
    self.worker = new Worker('/mpvwasm/assets/mpvwasm-audio-only-worker.js?v=' + VERSION);
    self.worker.onmessage = function (event) {
      var message = event.data || {};
      var pending = self.pending[message.id];
      if (!pending) return;
      delete self.pending[message.id];
      if (message.ok) pending.resolve(message.result);
      else pending.reject(Error(message.error || 'Audio worker error'));
    };
    self.worker.onerror = function (event) {
      self.fail('WASM worker: ' + (event.message || 'unable to start'));
    };
  };
  AudioSession.prototype.start = async function () {
    var self = this;
    if (self.closed || self.mode === 'off' || !self.url || !/^https?:/i.test(self.url)) return;
    if (!window.isSecureContext || typeof AudioWorkletNode !== 'function' || typeof Worker !== 'function') {
      self.fail('Для Audio WASM необходимы HTTPS, Web Workers и AudioWorklet');
      return;
    }
    try {
      self.createWorker();
      // Never alter the source video URL or its playback state.
      var info = await self.request('open', { url: proxyUrl(self.url) });
      if (self.closed) return;
      self.opened = true;
      self.tracks = (info.tracks || []).filter(function (t) { return t.type === 'audio'; });
      if (!self.tracks.some(function (t) { return needsDecoder(self.video, t, self.mode); })) {
        self.stopWorker();
        return;
      }
      self.renderTracks();
      var initial = self.tracks.findIndex(function (t) { return needsDecoder(self.video, t, self.mode); });
      // Auto-enable WASM only when the initial audio stream actually needs it.
      // Otherwise, leave native playback intact until the user chooses an unsupported track.
      if (initial === 0) self.selectTrack(0);
    } catch (error) {
      self.fail('Не удалось открыть Audio WASM: ' + (error.message || error));
    }
  };
  AudioSession.prototype.renderTracks = function () {
    var self = this;
    if (self.closed || !Lampa.PlayerPanel || !Lampa.PlayerPanel.setTracks) return;
    var ffprobe = Array.isArray(self.data.ffprobe) ? self.data.ffprobe : [];
    var items = self.tracks.map(function (track, audioIndex) {
      var codec = codecName(track);
      var meta = ffprobe.find(function (entry) { return entry.index === track.index; }) || {};
      var language = meta.tags && meta.tags.language || '';
      var title = track.title || meta.tags && meta.tags.title || (language ? language.toUpperCase() : 'Дорожка ' + (audioIndex + 1));
      var unsupported = needsDecoder(self.video, track, self.mode);
      return {
        index: audioIndex,
        title: title + ' / ' + codec.toUpperCase() + (unsupported ? ' / WASM' : ''),
        language: language,
        label: codec.toUpperCase(),
        extra: { channels: track.channels || 2 },
        selected: audioIndex === self.selection,
        enabled: audioIndex === self.selection,
        onSelect: function () { self.selectTrack(audioIndex); }
      };
    });
    Lampa.PlayerPanel.setTracks(items);
  };
  AudioSession.prototype.ensureAudio = async function () {
    if (this.ctx && this.node) return;
    var Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw Error('AudioContext unavailable');
    var ctx = new Context({ latencyHint: 'playback' });
    try {
      await ctx.audioWorklet.addModule('/mpvwasm/assets/mpvwasm-audio-only-worklet.js?v=' + VERSION);
      if (this.closed) { await ctx.close(); return; }
      var node = new AudioWorkletNode(ctx, 'lampa-audio-wasm-bridge', { outputChannelCount: [2] });
      var self = this;
      node.port.onmessage = function (event) {
        var data = event.data || {};
        if (data.type !== 'status' || self.closed) return;
        self.bufferedUs = Math.max(0, Number(data.bufferedUs || 0));
        if (!self.ready && self.bufferedUs > 350000 && ctx.state === 'running' && self.selection >= 0) {
          self.ready = true;
          self.active = true;
          self.video.muted = true;
        }
        self.pump();
      };
      node.onprocessorerror = function () { self.fail('Ошибка звукового процессора'); };
      node.connect(ctx.destination);
      this.ctx = ctx;
      this.node = node;
      await ctx.resume();
      if (ctx.state !== 'running') throw Error('AudioContext suspended (autoplay policy)');
    } catch (error) {
      try { await ctx.close(); } catch (_) {}
      throw error;
    }
  };
  AudioSession.prototype.selectTrack = async function (index) {
    var self = this;
    if (self.closed || !self.opened) return;
    var track = self.tracks[index];
    if (!track) return;
    var epoch = ++self.epoch;
    self.selection = index;
    self.ready = false;
    self.active = false;
    self.bufferedUs = 0;
    self.eof = false;
    self.video.muted = self.originalMuted;
    if (self.node) self.node.port.postMessage({ type: 'clear', clockUs: Math.round((self.video.currentTime || 0) * 1000000) });
    if (!needsDecoder(self.video, track, self.mode)) {
      try {
        var tracks = self.video.audioTracks;
        if (tracks && tracks.length > index) {
          for (var i = 0; i < tracks.length; i++) tracks[i].enabled = (i === index);
        } else {
          notice('Нативный выбор аудиодорожки недоступен на этом устройстве');
        }
      } catch (error) { notice('Ошибка переключения нативной дорожки'); }
      self.renderTracks();
      return;
    }
    try {
      await self.ensureAudio();
      if (self.closed || epoch !== self.epoch) return;
      var selection = await self.request('select', { index: track.index });
      if (!selection || self.closed || epoch !== self.epoch) return;
      var position = Math.max(0, Math.round(Number(self.video.currentTime || 0) * 1000000));
      await self.request('seek', { us: position });
      if (self.closed || epoch !== self.epoch) return;
      self.sync(true);
      self.pump();
      self.renderTracks();
    } catch (error) { self.fail('Аудиодекодер ' + codecName(track) + ': ' + (error.message || error)); }
  };
  AudioSession.prototype.pump = async function () {
    var self = this;
    if (self.closed || self.reading || self.eof || !self.node || self.selection < 0 || self.bufferedUs > 2800000) return;
    if (!needsDecoder(self.video, self.tracks[self.selection], self.mode)) return;
    var epoch = self.epoch;
    self.reading = true;
    try {
      var result = await self.request('read', { maxPackets: 256 });
      if (self.closed || epoch !== self.epoch || !self.node) return;
      var chunks = result && result.chunks || [];
      chunks.forEach(function (chunk) {
        self.node.port.postMessage({
          type: 'pcm', pcm: chunk.pcm, ptsUs: chunk.ptsUs,
          channels: chunk.channels, sampleRate: chunk.sampleRate
        }, [chunk.pcm.buffer]);
      });
      self.eof = !!(result && result.eof);
    } catch (error) { if (epoch === self.epoch) self.fail('Ошибка чтения аудио: ' + (error.message || error)); }
    finally { self.reading = false; }
  };
  AudioSession.prototype.seek = function () {
    var self = this;
    if (self.closed || !self.opened || self.selection < 0 || !needsDecoder(self.video, self.tracks[self.selection], self.mode)) return;
    var epoch = ++self.epoch;
    self.ready = false;
    self.bufferedUs = 0;
    self.eof = false;
    var position = Math.max(0, Math.round(Number(self.video.currentTime || 0) * 1000000));
    self.video.muted = true;
    if (self.node) self.node.port.postMessage({ type: 'clear', clockUs: position });
    self.request('seek', { us: position }).then(function () {
      if (self.closed || epoch !== self.epoch) return;
      self.sync(true);
      self.pump();
    }).catch(function (error) { if (epoch === self.epoch) self.fail('Audio seek: ' + (error.message || error)); });
  };
  AudioSession.prototype.sync = function (force) {
    if (this.closed || !this.node || this.selection < 0) return;
    if (!needsDecoder(this.video, this.tracks[this.selection], this.mode)) return;
    if (this.active && !this.video.muted) this.video.muted = true;
    this.node.port.postMessage({
      type: 'sync',
      clockUs: Math.round(Math.max(0, Number(this.video.currentTime || 0)) * 1000000),
      paused: !!this.video.paused,
      rate: Number(this.video.playbackRate || 1),
      volume: Number(this.video.volume)
    });
    if (force || this.bufferedUs < 2200000) this.pump();
  };
  AudioSession.prototype.stopWorker = function () {
    var self = this;
    Object.keys(self.pending).forEach(function (id) {
      self.pending[id].reject(Error('Audio worker stopped'));
      delete self.pending[id];
    });
    if (self.worker) { self.worker.terminate(); self.worker = null; }
  };
  AudioSession.prototype.fail = function (message) {
    if (this.closed) return;
    this.lastError = message;
    notice(message);
    this.destroy();
  };
  AudioSession.prototype.destroy = function () {
    if (this.closed) return;
    this.closed = true;
    this.epoch++;
    if (this.timer) clearInterval(this.timer);
    try { this.video.removeEventListener('seeking', this.onNativeSeek); } catch (_) {}
    if (this.active || this.video.muted) {
      try { this.video.muted = this.originalMuted; } catch (_) {}
    }
    this.stopWorker();
    if (this.node) { try { this.node.disconnect(); this.node.port.onmessage = null; } catch (_) {} }
    if (this.ctx) { try { this.ctx.close().catch(function () {}); } catch (_) {} }
    this.node = null; this.ctx = null;
  };
  function attach(data) {
    if (!Lampa.PlayerVideo || typeof Lampa.PlayerVideo.video !== 'function') return;
    var video = Lampa.PlayerVideo.video();
    if (!video || !video.tagName || video.tagName.toLowerCase() !== 'video') return;
    if (session && !session.closed && session.video === video && session.url === sourceUrl(video)) return;
    if (session) session.destroy();
    session = new AudioSession(video, data || (Lampa.Player.playdata && Lampa.Player.playdata()) || {});
    var target = session;
    target.timer = setInterval(function () {
      if (target.closed) return;
      if (sourceUrl(video) !== target.url) {
        target.destroy();
        if (session === target) { session = null; attach(); }
        return;
      }
      target.sync(false);
    }, 120);
    target.start();
  }
  function cleanup() {
    if (session) session.destroy();
    session = null;
  }
  function registerSettings() {
    if (!Lampa.SettingsApi || !Lampa.SettingsApi.addParam) return;
    Lampa.SettingsApi.addParam({
      component: 'player',
      param: {
        name: 'mpvwasm_audio_mode', type: 'select', default: 'auto',
        values: { auto: 'Автоматически', force: 'Для AC3 / EAC3 / DTS всегда', off: 'Выключено' }
      },
      field: { name: 'Audio WASM (AC3 / EAC3 / DTS)', description: 'Звук через FFmpeg WASM; видео и управление остаются штатными' }
    });
  }
  function init() {
    if (!window.Lampa || !Lampa.Player || !Lampa.PlayerVideo || !Lampa.PlayerPanel) return false;
    registerSettings();
    Lampa.Player.listener.follow('ready', function (event) { attach(event); });
    Lampa.Player.listener.follow('destroy', cleanup);
    Lampa.PlayerVideo.listener.follow('loadeddata', function () { attach(); });
    Lampa.PlayerVideo.listener.follow('destroy', cleanup);
    Lampa.PlayerVideo.listener.follow('tracks', function () {
      if (session && session.opened && !session.closed) setTimeout(function () {
        if (session && !session.closed) session.renderTracks();
      }, 0);
    });
    console.log('[Lampa Audio WASM] audio backend registered');
    return true;
  }
  if (!init()) {
    var tries = 0;
    var waiting = setInterval(function () { if (init() || ++tries >= 30) clearInterval(waiting); }, 500);
  }
})();
