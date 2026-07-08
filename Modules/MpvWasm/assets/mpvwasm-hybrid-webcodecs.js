(function () {
  'use strict';

  var VERSION = '20260708-64-hybrid-manual';
  var INVALID_TS = -9000000000000000;

  function loadScript(src, ready) {
    if (ready && ready()) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-mpvwasm-src="' + src + '"]');
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', function () { reject(new Error('Unable to load ' + src)); }, { once: true });
        return;
      }
      var script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.setAttribute('data-mpvwasm-src', src);
      script.onload = resolve;
      script.onerror = function () { reject(new Error('Unable to load ' + src)); };
      document.head.appendChild(script);
    });
  }

  async function ensureDemuxer() {
    await loadScript('/mpvwasm/assets/mpvwasm-demuxer-wrapper.js?v=' + VERSION, function () {
      return !!(window.MpvWasmDemuxer && typeof window.MpvWasmDemuxer.open === 'function');
    });
    if (!window.MpvWasmDemuxer) throw new Error('MpvWasmDemuxer was not found');
  }

  function call(options, name, value) {
    try {
      var fn = options && options[name];
      if (typeof fn === 'function') fn(value);
    } catch (_) { }
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function fromBase64(value) {
    if (!value) return undefined;
    var binary = atob(value);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function hex(value) {
    return ('0' + Number(value || 0).toString(16)).slice(-2);
  }

  function avcCodec(description) {
    if (description && description.length >= 4 && description[0] === 1) {
      return 'avc1.' + hex(description[1]) + hex(description[2]) + hex(description[3]);
    }
    return 'avc1.640028';
  }

  function hevcCodec(track) {
    var level = Number(track && track.level || 153);
    if (!isFinite(level) || level <= 0) level = 153;
    return 'hvc1.1.6.L' + level + '.B0';
  }

  function videoConfigs(track) {
    var description = fromBase64(track && track.extradata || '');
    var codec = String(track && track.codecName || '').toLowerCase();
    var base = {
      codedWidth: Number(track && track.width || 0),
      codedHeight: Number(track && track.height || 0),
      description: description,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true
    };

    if (codec === 'h264') {
      var avc = Object.assign({}, base, { codec: avcCodec(description), avc: { format: 'avc' } });
      return [avc, Object.assign({}, base, { codec: avc.codec })];
    }
    if (codec === 'hevc') {
      return [
        Object.assign({}, base, { codec: hevcCodec(track), hevc: { format: 'hevc' } }),
        Object.assign({}, base, { codec: hevcCodec(track) }),
        Object.assign({}, base, { codec: 'hvc1.1.6.L153.B0' }),
        Object.assign({}, base, { codec: 'hev1.1.6.L153.B0' })
      ];
    }
    if (codec === 'av1') return [Object.assign({}, base, { codec: 'av01.0.12M.08' })];
    if (codec === 'vp9') return [Object.assign({}, base, { codec: 'vp09.00.51.08' })];
    if (codec === 'vp8') return [Object.assign({}, base, { codec: 'vp8' })];
    return [];
  }

  async function supportedConfig(track) {
    if (typeof VideoDecoder !== 'function') return null;
    var configs = videoConfigs(track);
    for (var i = 0; i < configs.length; i++) {
      try {
        var support = await VideoDecoder.isConfigSupported(configs[i]);
        if (support && support.supported) return support.config || configs[i];
      } catch (_) { }
    }
    return null;
  }

  function packetTimeUs(packet) {
    var pts = Number(packet && packet.ptsUs);
    if (isFinite(pts) && pts > INVALID_TS) return pts;
    var dts = Number(packet && packet.dtsUs);
    if (isFinite(dts) && dts > INVALID_TS) return dts;
    return 0;
  }

  function formatTrackTitle(track, fallback) {
    var title = String(track && track.title || '').trim();
    if (title) return title;
    var parts = [];
    if (track && track.codecName) parts.push(String(track.codecName).toUpperCase());
    if (track && track.channels) parts.push(track.channels + 'ch');
    if (track && track.sampleRate) parts.push(Math.round(track.sampleRate / 1000) + 'kHz');
    return parts.join(' ') || fallback;
  }

  function mapAudioTrack(track, selected) {
    return {
      id: String(track.index),
      index: track.index,
      type: 'audio',
      title: formatTrackTitle(track, 'Audio #' + track.index),
      label: formatTrackTitle(track, 'Audio #' + track.index),
      codec: track.codecName || '',
      audioChannels: track.channels || 0,
      sampleRate: track.sampleRate || 0,
      selected: !!selected
    };
  }

  function mapSubtitleTrack(track, selected) {
    return {
      id: String(track.index),
      index: track.index,
      type: 'subtitle',
      title: formatTrackTitle(track, 'Subtitle #' + track.index),
      label: formatTrackTitle(track, 'Subtitle #' + track.index),
      codec: track.codecName || '',
      selected: !!selected
    };
  }

  function clearFrames(frames) {
    while (frames && frames.length) {
      try { frames.shift().close(); } catch (_) { }
    }
  }

  function cleanSubtitleText(text) {
    return String(text || '')
      .replace(/\r/g, '')
      .replace(/\{\\[^}]+\}/g, '')
      .replace(/<\/?[^>]+>/g, '')
      .replace(/^Dialogue:[^\n]*,/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function HybridWebCodecsPlayer(canvas, url, callbacks, options) {
    this.canvas = canvas;
    this.url = url;
    this.callbacks = callbacks || {};
    this.options = options || {};
    this.hybridWebCodecs = true;
    this.hardware = true;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) || canvas.getContext('2d');
    this.session = null;
    this.videoDecoder = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.subtitleTrack = null;
    this.config = null;
    this.duration = 0;
    this.elapsed = 0;
    this.isPlaying = false;
    this.wantPlaying = true;
    this.paused = true;
    this.destroyed = false;
    this.seeking = false;
    this.started = false;
    this.ready = false;
    this.seenVideoKeyframe = false;
    this.dropAudioBeforeUs = 0;
    this.frameQueue = [];
    this.subtitleItems = [];
    this.audioTracks = [];
    this.subtitleTracks = [];
    this.videoTracks = [];
    this.audioContext = null;
    this.audioNode = null;
    this.audioBasePtsUs = null;
    this.audioQueuedSamples = 0;
    this.audioPlayedSamples = 0;
    this.audioBufferUs = 0;
    this.audioClockUs = 0;
    this.pendingClockUs = 0;
    this.seekTargetUs = 0;
    this.lastElapsedEmit = 0;
    this.lastDrawnFrameUs = 0;
    this.renderedFrames = 0;
    this.droppedFrames = 0;
    this.decodedFrames = 0;
    this.submittedFrames = 0;
    this.pumpRunning = false;
    this.volume = 1;
    this.raf = 0;
    this.subtitleNode = null;
    this.subtitleWrap = null;
    this._renderLoop = this._renderLoop.bind(this);
  }

  HybridWebCodecsPlayer.open = async function (canvas, url, callbacks, options) {
    var player = new HybridWebCodecsPlayer(canvas, url, callbacks, options);
    await player.init();
    return player;
  };

  HybridWebCodecsPlayer.prototype.init = async function () {
    await ensureDemuxer();
    if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') {
      throw new Error('WebCodecs VideoDecoder is not available');
    }

    call(this.callbacks, 'status', 'hybrid demux open');
    this.session = await window.MpvWasmDemuxer.open(this.url);
    var tracks = this.session.info.tracks || [];
    this.videoTrack = tracks.filter(function (track) { return track.type === 'video'; })[0];
    if (!this.videoTrack) throw new Error('No video track');

    this.audioTrack = tracks.filter(function (track) { return track.type === 'audio'; })[0] || null;
    var subtitles = tracks.filter(function (track) { return track.type === 'subtitle'; });
    this.subtitleTrack = null;
    this.videoTracks = [this.videoTrack];
    this.audioTracks = tracks.filter(function (track) { return track.type === 'audio'; }).map(function (track) {
      return mapAudioTrack(track, this.audioTrack && track.index === this.audioTrack.index);
    }, this);
    this.subtitleTracks = subtitles.map(function (track) {
      return mapSubtitleTrack(track, false);
    });
    this.duration = Math.max(0, Number(this.session.info.durationUs || 0) / 1000000);

    this.config = await supportedConfig(this.videoTrack);
    if (!this.config) throw new Error('WebCodecs unsupported for ' + (this.videoTrack.codecName || 'video'));

    this.configureVideoDecoder();
    await this.configureAudio();
    this.findSubtitleNode();

    call(this.callbacks, 'duration', this.duration);
    call(this.callbacks, 'videoSize', { width: this.videoTrack.width || 0, height: this.videoTrack.height || 0 });
    call(this.callbacks, 'audioTracks', this.audioTracks);
    call(this.callbacks, 'subtitleTracks', this.subtitleTracks);
    call(this.callbacks, 'status', 'hybrid using ' + this.config.codec);

    this.startLoops();
  };

  HybridWebCodecsPlayer.prototype.configureVideoDecoder = function () {
    var self = this;
    if (this.videoDecoder) {
      try { this.videoDecoder.close(); } catch (_) { }
    }
    this.videoDecoder = new VideoDecoder({
      output: function (frame) {
        self.decodedFrames++;
        self.frameQueue.push(frame);
        while (self.frameQueue.length > 36) {
          self.droppedFrames++;
          try { self.frameQueue.shift().close(); } catch (_) { }
        }
        self.maybeReady();
      },
      error: function (error) {
        call(self.callbacks, 'error', error);
      }
    });
    this.videoDecoder.configure(this.config);
  };

  HybridWebCodecsPlayer.prototype.configureAudio = async function () {
    if (!this.audioTrack) return;
    var AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || !window.AudioWorkletNode) throw new Error('AudioWorklet is not available');
    var wantedRate = Math.max(8000, Number(this.audioTrack.sampleRate || 48000));
    try {
      this.audioContext = new AudioContextClass({ sampleRate: wantedRate, latencyHint: 'playback' });
    } catch (_) {
      this.audioContext = new AudioContextClass({ latencyHint: 'playback' });
    }
    await this.audioContext.audioWorklet.addModule('/mpvwasm/assets/mpvwasm-audio-worklet.js?v=' + VERSION);
    this.audioNode = new AudioWorkletNode(this.audioContext, 'mpvwasm-pcm-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    var self = this;
    this.audioNode.port.onmessage = function (event) {
      var data = event.data || {};
      if (data.type !== 'clock') return;
      if (self.audioBasePtsUs === null) return;
      if (Number(data.clockUs || 0) < self.audioBasePtsUs - 100000) return;
      self.audioClockUs = Number(data.clockUs || 0);
      self.audioPlayedSamples = Number(data.playedSamples || 0);
      self.audioBufferUs = Number(data.bufferUs || 0);
      self.emitElapsed(false);
      self.updateDebug();
    };
    this.audioNode.connect(this.audioContext.destination);
    await this.audioContext.suspend();
    var ret = this.session.openAudioDecoder(this.audioTrack.index);
    if (ret < 0) throw new Error('audio decoder open failed: ' + ret);
    this.resetAudioClock(null);
  };

  HybridWebCodecsPlayer.prototype.findSubtitleNode = function () {
    var root = this.canvas && this.canvas.closest ? this.canvas.closest('.player-video') : null;
    this.subtitleWrap = root ? root.querySelector('.player-video__subtitles') : null;
    this.subtitleNode = root ? root.querySelector('.player-video__subtitles-text') : null;
  };

  HybridWebCodecsPlayer.prototype.startLoops = function () {
    this.setPause(false);
    this.pump();
    this.raf = requestAnimationFrame(this._renderLoop);
  };

  HybridWebCodecsPlayer.prototype.resetAudioClock = function (basePtsUs) {
    this.audioBasePtsUs = basePtsUs === null || basePtsUs === undefined || !isFinite(Number(basePtsUs)) ? null : Number(basePtsUs);
    this.audioQueuedSamples = 0;
    this.audioPlayedSamples = 0;
    this.audioBufferUs = 0;
    this.audioClockUs = this.audioBasePtsUs || 0;
    if (this.audioNode) {
      this.audioNode.port.postMessage({
        type: 'reset',
        basePtsUs: this.audioClockUs,
        hasBasePts: this.audioBasePtsUs !== null
      });
      this.audioNode.port.postMessage({ type: 'volume', volume: this.volume });
    }
  };

  HybridWebCodecsPlayer.prototype.resumeAudio = function () {
    if (!this.audioContext || this.destroyed) return;
    var self = this;
    this.audioContext.resume().catch(function (error) {
      call(self.callbacks, 'error', error);
    });
  };

  HybridWebCodecsPlayer.prototype.pauseAudio = function () {
    if (!this.audioContext || this.destroyed) return;
    this.audioContext.suspend().catch(function () { });
  };

  HybridWebCodecsPlayer.prototype.throttleReason = function () {
    if (this.seekTargetUs && !this.hasFrameNear(this.seekTargetUs, 120000)) return '';
    if (this.audioTrack && this.audioBufferUs > 2500000) return 'audio-buffer';
    if (!this.ready && this.audioTrack && this.audioBufferUs > 900000 && this.frameQueue.length > 3) return 'startup-buffer';
    return '';
  };

  HybridWebCodecsPlayer.prototype.pump = async function () {
    if (this.pumpRunning) return;
    this.pumpRunning = true;
    try {
      while (!this.destroyed) {
        if (this.seeking) {
          await sleep(15);
          continue;
        }

        if (this.throttleReason()) {
          this.maybeReady();
          await sleep(8);
          continue;
        }

        var handled = 0;
        while (handled < 96 && !this.destroyed && !this.seeking && !this.throttleReason()) {
          var packet = this.session.readPacket();
          if (!packet) {
            call(this.callbacks, 'fileEnd');
            return;
          }
          handled++;
          this.handlePacket(packet);
        }

        this.maybeReady();
        await sleep(0);
      }
    } catch (error) {
      if (!this.destroyed) call(this.callbacks, 'error', error);
    } finally {
      this.pumpRunning = false;
    }
  };

  HybridWebCodecsPlayer.prototype.handlePacket = function (packet) {
    if (packet.streamIndex === this.videoTrack.index) {
      this.handleVideoPacket(packet);
    } else if (this.audioTrack && packet.streamIndex === this.audioTrack.index) {
      this.handleAudioPacket(packet);
    } else if (this.subtitleTrack && packet.streamIndex === this.subtitleTrack.index) {
      this.handleSubtitlePacket(packet);
    }
  };

  HybridWebCodecsPlayer.prototype.handleVideoPacket = function (packet) {
    if (!this.videoDecoder || this.videoDecoder.state !== 'configured') return;
    if (this.seenVideoKeyframe && (this.videoDecoder.decodeQueueSize > 128 || this.frameQueue.length > 40)) return;
    if (!this.seenVideoKeyframe) {
      if (!packet.keyframe) return;
      this.seenVideoKeyframe = true;
    }
    var timestamp = packetTimeUs(packet);
    try {
      this.videoDecoder.decode(new EncodedVideoChunk({
        type: packet.keyframe ? 'key' : 'delta',
        timestamp: timestamp,
        duration: packet.durationUs > 0 ? packet.durationUs : undefined,
        data: packet.data
      }));
      this.submittedFrames++;
    } catch (error) {
      this.seenVideoKeyframe = false;
      call(this.callbacks, 'status', 'hybrid video decode retry ' + (error && (error.message || error) || error));
    }
  };

  HybridWebCodecsPlayer.prototype.handleAudioPacket = function (packet) {
    var ptsUs = packetTimeUs(packet);
    if (this.dropAudioBeforeUs && ptsUs + 50000 < this.dropAudioBeforeUs) return;
    var decoded = this.session.decodeCurrentAudioPacket();
    if (!decoded) return;
    if (decoded.error) {
      call(this.callbacks, 'status', 'hybrid audio decode error ' + decoded.error);
      return;
    }
    if (this.audioBasePtsUs === null) this.resetAudioClock(ptsUs);
    this.audioQueuedSamples += decoded.samples;
    this.audioBufferUs = Math.max(0, Math.round((this.audioQueuedSamples - this.audioPlayedSamples) / Math.max(1, decoded.sampleRate || 48000) * 1000000));
    if (this.audioNode) {
      this.audioNode.port.postMessage({
        type: 'pcm',
        pcm: decoded.pcm.buffer,
        channels: decoded.channels,
        sampleRate: decoded.sampleRate,
        ptsUs: ptsUs
      }, [decoded.pcm.buffer]);
    }
  };

  HybridWebCodecsPlayer.prototype.handleSubtitlePacket = function (packet) {
    var startUs = packetTimeUs(packet);
    var durationUs = Number(packet.durationUs || 0);
    if (!durationUs || durationUs < 0) durationUs = 4000000;
    var text = '';
    try { text = cleanSubtitleText(new TextDecoder('utf-8').decode(packet.data)); } catch (_) { }
    if (!text) return;
    this.subtitleItems.push({ startUs: startUs, endUs: startUs + durationUs, text: text });
    while (this.subtitleItems.length > 80) this.subtitleItems.shift();
  };

  HybridWebCodecsPlayer.prototype.maybeReady = function () {
    if (this.destroyed || this.ready) return;
    var videoReady = this.seekTargetUs ? this.hasFrameNear(this.seekTargetUs, 120000) : this.frameQueue.length > 0;
    var audioReady = !this.audioTrack || this.audioBufferUs >= 300000 || this.audioQueuedSamples > 0;
    if (!videoReady || !audioReady) return;

    var firstStart = !this.started;
    this.ready = true;
    this.seekTargetUs = 0;
    this.pendingClockUs = 0;
    if (firstStart) {
      this.started = true;
      call(this.callbacks, 'fileStart', { backend: 'hybrid-webcodecs' });
    }
    this.renderFrame(firstStart);
    if (this.wantPlaying) this.resumeAudio();
    this.isPlaying = !!this.wantPlaying;
    this.paused = !this.wantPlaying;
    call(this.callbacks, 'isPlaying', this.isPlaying);
    this.updateDebug();
  };

  HybridWebCodecsPlayer.prototype.currentClockUs = function () {
    if (this.audioTrack && this.audioClockUs) return this.audioClockUs;
    if (this.audioTrack && this.pendingClockUs) return this.pendingClockUs;
    if (this.audioBasePtsUs !== null) return this.audioBasePtsUs;
    if (this.frameQueue.length) return Number(this.frameQueue[0].timestamp || 0);
    return Math.round(this.elapsed * 1000000);
  };

  HybridWebCodecsPlayer.prototype.hasFrameNear = function (timeUs, toleranceUs) {
    var minUs = Number(timeUs || 0) - Number(toleranceUs || 0);
    for (var i = 0; i < this.frameQueue.length; i++) {
      if (Number(this.frameQueue[i].timestamp || 0) >= minUs) return true;
    }
    return false;
  };

  HybridWebCodecsPlayer.prototype.renderFrame = function (force) {
    if (!this.frameQueue.length) return;
    var clockUs = this.currentClockUs();
    var maxEarlyUs = force ? 300000 : 30000;
    var maxLateUs = force ? 900000 : 80000;
    var frame = null;

    while (this.frameQueue.length) {
      frame = this.frameQueue[0];
      var timestamp = Number(frame.timestamp || 0);
      if (!force && timestamp < clockUs - maxLateUs && this.frameQueue.length > 1) {
        this.droppedFrames++;
        try { this.frameQueue.shift().close(); } catch (_) { }
        continue;
      }
      if (force || timestamp <= clockUs + maxEarlyUs) {
        this.frameQueue.shift();
        break;
      }
      frame = null;
      break;
    }

    if (!frame) return;
    try {
      this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
      this.lastDrawnFrameUs = Number(frame.timestamp || clockUs);
      this.renderedFrames++;
    } catch (error) {
      call(this.callbacks, 'error', error);
    } finally {
      try { frame.close(); } catch (_) { }
    }
  };

  HybridWebCodecsPlayer.prototype.renderSubtitles = function (clockUs) {
    if (!this.subtitleNode || !this.subtitleWrap) return;
    if (!this.subtitleTrack) {
      this.subtitleNode.textContent = '';
      this.subtitleWrap.classList.add('hide');
      return;
    }
    var active = '';
    for (var i = this.subtitleItems.length - 1; i >= 0; i--) {
      var item = this.subtitleItems[i];
      if (clockUs >= item.startUs && clockUs <= item.endUs) {
        active = item.text;
        break;
      }
    }
    this.subtitleNode.textContent = active;
    this.subtitleWrap.classList.toggle('hide', !active);
  };

  HybridWebCodecsPlayer.prototype._renderLoop = function () {
    if (this.destroyed) return;
    if (this.ready && !this.paused) this.renderFrame(false);
    var clockUs = this.currentClockUs();
    this.renderSubtitles(clockUs);
    this.emitElapsed(false);
    this.raf = requestAnimationFrame(this._renderLoop);
  };

  HybridWebCodecsPlayer.prototype.emitElapsed = function (force) {
    var now = performance.now();
    if (!force && now - this.lastElapsedEmit < 200) return;
    this.lastElapsedEmit = now;
    var clockUs = this.currentClockUs();
    if (clockUs > 0) this.elapsed = Math.max(0, clockUs / 1000000);
    call(this.callbacks, 'elapsed', this.elapsed);
  };

  HybridWebCodecsPlayer.prototype.updateDebug = function () {
    if (!this.options.debug && !window.__MPV_WASM_DEBUG) return;
    window.__mpvwasm_hybrid_debug = {
      backend: 'hybrid-webcodecs',
      codec: this.config && this.config.codec,
      duration: this.duration,
      elapsed: this.elapsed,
      audioClockUs: this.audioClockUs,
      videoFrameUs: this.lastDrawnFrameUs,
      driftMs: Math.round((this.lastDrawnFrameUs - this.audioClockUs) / 1000),
      submittedFrames: this.submittedFrames,
      decodedFrames: this.decodedFrames,
      renderedFrames: this.renderedFrames,
      droppedFrames: this.droppedFrames,
      videoQueue: this.frameQueue.length,
      decodeQueue: this.videoDecoder ? this.videoDecoder.decodeQueueSize : 0,
      audioBufferUs: this.audioBufferUs,
      audioTrack: this.audioTrack && this.audioTrack.index,
      subtitleTrack: this.subtitleTrack && this.subtitleTrack.index
    };
  };

  HybridWebCodecsPlayer.prototype.setPause = function (paused) {
    this.paused = !!paused;
    this.wantPlaying = !this.paused;
    this.isPlaying = !this.paused;
    if (this.paused) this.pauseAudio();
    else if (this.ready) this.resumeAudio();
    call(this.callbacks, 'isPlaying', this.isPlaying);
  };

  HybridWebCodecsPlayer.prototype.play = function () {
    this.setPause(false);
    return Promise.resolve();
  };

  HybridWebCodecsPlayer.prototype.pause = function () {
    this.setPause(true);
  };

  HybridWebCodecsPlayer.prototype.seekRelative = function (seconds) {
    return this.seek(this.elapsed + Number(seconds || 0));
  };

  HybridWebCodecsPlayer.prototype.seek = async function (seconds) {
    if (!this.session || this.destroyed) return;
    var target = Math.max(0, Number(seconds || 0));
    if (this.duration) target = Math.min(target, Math.max(0, this.duration - 0.25));
    var targetUs = Math.round(target * 1000000);
    var seekUs = Math.max(0, targetUs - 1500000);

    call(this.callbacks, 'status', 'hybrid seek ' + target.toFixed(3));
    this.seeking = true;
    this.ready = false;
    this.elapsed = target;
    this.pendingClockUs = targetUs;
    this.seekTargetUs = targetUs;
    this.emitElapsed(true);
    clearFrames(this.frameQueue);
    this.subtitleItems = [];
    this.seenVideoKeyframe = false;
    this.dropAudioBeforeUs = targetUs;
    this.resetAudioClock(null);
    if (this.audioContext) await this.audioContext.suspend().catch(function () { });
    this.configureVideoDecoder();
    if (this.audioTrack) {
      try { this.session.closeAudioDecoder(); } catch (_) { }
    }
    var ret = this.session.seek(seekUs);
    if (ret < 0) call(this.callbacks, 'status', 'hybrid seek ret ' + ret);
    else call(this.callbacks, 'status', 'hybrid seek ok ' + (seekUs / 1000000).toFixed(3));
    if (this.audioTrack) {
      var audioRet = this.session.openAudioDecoder(this.audioTrack.index);
      if (audioRet < 0) call(this.callbacks, 'status', 'hybrid audio reopen ret ' + audioRet);
    }
    this.seeking = false;
    this.pump();
  };

  HybridWebCodecsPlayer.prototype.setVolume = function (volume) {
    this.volume = Math.max(0, Math.min(1, Number(volume || 0)));
    if (this.audioNode) this.audioNode.port.postMessage({ type: 'volume', volume: this.volume });
  };

  HybridWebCodecsPlayer.prototype.setAudioTrack = function (id) {
    var index = Number(id);
    var track = (this.session.info.tracks || []).filter(function (item) {
      return item.type === 'audio' && Number(item.index) === index;
    })[0];
    if (!track || (this.audioTrack && track.index === this.audioTrack.index)) return Promise.resolve();
    this.audioTrack = track;
    this.audioTracks = (this.session.info.tracks || []).filter(function (item) { return item.type === 'audio'; }).map(function (item) {
      return mapAudioTrack(item, item.index === track.index);
    });
    call(this.callbacks, 'audioTracks', this.audioTracks);
    return this.seek(this.elapsed);
  };

  HybridWebCodecsPlayer.prototype.setSubtitleTrack = function (id) {
    var index = Number(id);
    if (index < 0 || !isFinite(index)) {
      this.subtitleTrack = null;
      this.subtitleTracks.forEach(function (track) { track.selected = false; });
      this.subtitleItems = [];
      this.renderSubtitles(this.currentClockUs());
      call(this.callbacks, 'subtitleTracks', this.subtitleTracks);
      return Promise.resolve();
    }
    var track = (this.session.info.tracks || []).filter(function (item) {
      return item.type === 'subtitle' && Number(item.index) === index;
    })[0];
    if (!track) return Promise.resolve();
    this.subtitleTrack = track;
    this.subtitleTracks.forEach(function (item) { item.selected = Number(item.index) === index; });
    this.subtitleItems = [];
    call(this.callbacks, 'subtitleTracks', this.subtitleTracks);
    return this.seek(this.elapsed);
  };

  HybridWebCodecsPlayer.prototype.setOptions = function (callbacks) {
    this.callbacks = callbacks || {};
  };

  HybridWebCodecsPlayer.prototype.destroy = async function () {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    clearFrames(this.frameQueue);
    try { if (this.videoDecoder) this.videoDecoder.close(); } catch (_) { }
    try { if (this.audioNode) this.audioNode.disconnect(); } catch (_) { }
    try { if (this.audioContext) await this.audioContext.close(); } catch (_) { }
    try { if (this.session) this.session.close(); } catch (_) { }
    this.videoDecoder = null;
    this.audioNode = null;
    this.audioContext = null;
    this.session = null;
  };

  window.MpvWasmWebCodecs = window.MpvWasmWebCodecs || {};
  window.MpvWasmWebCodecs.supportedConfig = window.MpvWasmWebCodecs.supportedConfig || supportedConfig;

  window.HybridWebCodecsBackend = {
    version: VERSION,
    supportedConfig: supportedConfig,
    open: HybridWebCodecsPlayer.open
  };
})();
