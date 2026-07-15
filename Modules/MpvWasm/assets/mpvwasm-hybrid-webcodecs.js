(function () {
  'use strict';

  var VERSION = '20260709-04-buffering';
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
    var profile = Number(track && track.profile || 1);
    if (!isFinite(profile) || profile <= 0) profile = 1;
    var level = Number(track && track.level || 153);
    if (!isFinite(level) || level <= 0) level = 153;
    var compat = profile === 2 ? 4 : 6;
    return 'hvc1.' + profile + '.' + compat + '.L' + level + '.B0';
  }

  function hevcCodecFromHvcC(description, sampleEntry) {
    if (!description || description.length < 23 || description[0] !== 1) return null;
    var profileByte = description[1];
    var profileSpace = profileByte >> 6;
    var tierFlag = (profileByte >> 5) & 1;
    var profileIdc = profileByte & 0x1f;
    var compat = ((description[2] << 24) | (description[3] << 16) | (description[4] << 8) | description[5]) >>> 0;
    var level = description[12];
    var constraints = '';
    for (var i = 6; i < 12; i++) constraints += hex(description[i]);
    constraints = constraints.replace(/(00)+$/g, '') || '0';
    var space = profileSpace === 1 ? 'A' : (profileSpace === 2 ? 'B' : (profileSpace === 3 ? 'C' : ''));
    return sampleEntry + '.' + space + profileIdc + '.' + compat.toString(16).toUpperCase() + '.' + (tierFlag ? 'H' : 'L') + level + '.' + constraints.toUpperCase();
  }

  function hevcCodecVariants(track, description) {
    var level = Number(track && track.level || 153);
    if (!isFinite(level) || level <= 0) level = 153;
    var variants = [
      hevcCodecFromHvcC(description, 'hvc1'),
      hevcCodecFromHvcC(description, 'hev1'),
      hevcCodec(track),
      hevcCodec(track).replace(/^hvc1/, 'hev1'),
      'hvc1.1.6.L' + level + '.B0',
      'hev1.1.6.L' + level + '.B0',
      'hvc1.2.4.L' + level + '.B0',
      'hev1.2.4.L' + level + '.B0',
      'hvc1.1.6.L153.B0',
      'hev1.1.6.L153.B0',
      'hvc1.2.4.L153.B0',
      'hev1.2.4.L153.B0'
    ];
    return variants.filter(function (item, index) { return item && variants.indexOf(item) === index; });
  }

  function videoConfigs(track) {
    var description = fromBase64(track && track.extradata || '');
    var codec = String(track && track.codecName || '').toLowerCase();
    var colorSpace = videoColorSpace(track);
    var base = {
      codedWidth: Number(track && track.width || 0),
      codedHeight: Number(track && track.height || 0),
      description: description,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true
    };
    if (colorSpace) base.colorSpace = colorSpace;

    if (codec === 'h264') {
      var avc = Object.assign({}, base, { codec: avcCodec(description), avc: { format: 'avc' } });
      return [avc, Object.assign({}, base, { codec: avc.codec })];
    }
    if (codec === 'hevc') {
      var variants = hevcCodecVariants(track, description);
      var configs = [];
      if (description) {
        variants.forEach(function (item) {
          configs.push(Object.assign({}, base, { codec: item }));
          configs.push(Object.assign({}, base, { codec: item, hevc: { format: 'hevc' } }));
        });
      }
      var noDescriptionBase = Object.assign({}, base);
      delete noDescriptionBase.description;
      variants.forEach(function (item) {
        configs.push(Object.assign({}, noDescriptionBase, { codec: item }));
        configs.push(Object.assign({}, noDescriptionBase, { codec: item, hevc: { format: 'annexb' } }));
      });
      return configs;
    }
    if (codec === 'av1') return [Object.assign({}, base, { codec: 'av01.0.12M.08' })];
    if (codec === 'vp9') return [Object.assign({}, base, { codec: 'vp09.00.51.08' })];
    if (codec === 'vp8') return [Object.assign({}, base, { codec: 'vp8' })];
    return [];
  }

  function videoColorSpace(track) {
    if (!track) return null;
    var primariesId = Number(track.colorPrimaries || 0);
    var transferId = Number(track.colorTransfer || 0);
    var matrixId = Number(track.colorMatrix || 0);
    var color = {};
    if (primariesId === 1) color.primaries = 'bt709';
    else if (primariesId === 5) color.primaries = 'bt470bg';
    else if (primariesId === 6) color.primaries = 'smpte170m';
    else if (primariesId === 9) color.primaries = 'bt2020';
    if (transferId === 1) color.transfer = 'bt709';
    else if (transferId === 6) color.transfer = 'smpte170m';
    else if (transferId === 13) color.transfer = 'iec61966-2-1';
    else if (transferId === 16) color.transfer = 'smpte2084';
    else if (transferId === 18) color.transfer = 'arib-std-b67';
    if (matrixId === 0) color.matrix = 'rgb';
    else if (matrixId === 1) color.matrix = 'bt709';
    else if (matrixId === 5) color.matrix = 'bt470bg';
    else if (matrixId === 6) color.matrix = 'smpte170m';
    else if (matrixId === 9) color.matrix = 'bt2020-ncl';
    else if (matrixId === 10) color.matrix = 'bt2020-cl';
    if (Number(track.colorRange || 0) === 2) color.fullRange = true;
    return Object.keys(color).length ? color : null;
  }

  async function supportedConfig(track) {
    if (typeof VideoDecoder !== 'function') return null;
    var configs = videoConfigs(track);
    for (var i = 0; i < configs.length; i++) {
      try {
        var support = await VideoDecoder.isConfigSupported(configs[i]);
        if (support && support.supported) {
          var supported = Object.assign({}, support.config || configs[i]);
          if (configs[i].avc) supported.avc = configs[i].avc;
          if (configs[i].hevc) supported.hevc = configs[i].hevc;
          return supported;
        }
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

  function audioCodecConfig(track) {
    var codec = String(track && track.codecName || '').toLowerCase();
    var mapped = '';
    if (codec === 'ac3' || codec === 'eac3' || codec === 'dts' || codec === 'truehd') return null;
    else if (codec === 'aac') mapped = 'mp4a.40.2';
    else if (codec === 'mp3') mapped = 'mp3';
    else if (codec === 'opus') mapped = 'opus';
    else if (codec === 'flac') mapped = 'flac';
    if (!mapped) return null;
    return {
      codec: mapped,
      sampleRate: Number(track && track.sampleRate || 48000),
      numberOfChannels: Number(track && track.channels || 2)
    };
  }

  function clearFrames(frames) {
    while (frames && frames.length) {
      try { frames.shift().close(); } catch (_) { }
    }
  }

  function createShader(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'shader compile failed');
    return shader;
  }

  function fitRect(canvas, sourceWidth, sourceHeight) {
    var cw = Math.max(1, Number(canvas && canvas.width || 1));
    var ch = Math.max(1, Number(canvas && canvas.height || 1));
    var sw = Math.max(1, Number(sourceWidth || 1));
    var sh = Math.max(1, Number(sourceHeight || 1));
    var scale = Math.min(cw / sw, ch / sh);
    var width = Math.max(1, Math.round(sw * scale));
    var height = Math.max(1, Math.round(sh * scale));
    return {
      x: Math.round((cw - width) / 2),
      y: Math.round((ch - height) / 2),
      width: width,
      height: height
    };
  }

  function createWebglRenderer(canvas) {
    var gl = null;
    try {
      gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, desynchronized: true }) ||
        canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, desynchronized: true });
    } catch (_) { }
    if (!gl) return null;

    var vertexSource = 'attribute vec2 a_position;attribute vec2 a_texcoord;varying vec2 v_texcoord;void main(){gl_Position=vec4(a_position,0.0,1.0);v_texcoord=a_texcoord;}';
    var fragmentSource = 'precision mediump float;uniform sampler2D u_texture;varying vec2 v_texcoord;void main(){gl_FragColor=texture2D(u_texture,v_texcoord);}';
    var program = gl.createProgram();
    gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'program link failed');

    var position = gl.getAttribLocation(program, 'a_position');
    var texcoord = gl.getAttribLocation(program, 'a_texcoord');
    var buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1,
       1, -1, 1, 1,
      -1,  1, 0, 0,
       1,  1, 1, 0
    ]), gl.STATIC_DRAW);
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    return {
      type: 'webgl',
      render: function (frame, sourceWidth, sourceHeight) {
        var rect = fitRect(canvas, sourceWidth, sourceHeight);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.viewport(rect.x, rect.y, rect.width, rect.height);
        gl.useProgram(program);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(texcoord);
        gl.vertexAttribPointer(texcoord, 2, gl.FLOAT, false, 16, 8);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
      destroy: function () {
        try { gl.deleteTexture(texture); } catch (_) { }
        try { gl.deleteBuffer(buffer); } catch (_) { }
        try { gl.deleteProgram(program); } catch (_) { }
      }
    };
  }

  function create2dRenderer(canvas) {
    var ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) || canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');
    if (!ctx) return null;
    try { ctx.imageSmoothingEnabled = true; } catch (_) { }
    return {
      type: '2d',
      render: function (frame, sourceWidth, sourceHeight) {
        var rect = fitRect(canvas, sourceWidth || frame.displayWidth || frame.codedWidth, sourceHeight || frame.displayHeight || frame.codedHeight);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(frame, rect.x, rect.y, rect.width, rect.height);
      },
      destroy: function () { }
    };
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
    var rendererMode = '';
    try { rendererMode = String(localStorage.getItem('mpvwasm_renderer') || '2d'); } catch (_) { rendererMode = '2d'; }
    try { this.renderer = rendererMode === 'webgl' ? createWebglRenderer(canvas) : create2dRenderer(canvas); } catch (_) { this.renderer = null; }
    this.ctx = this.renderer ? null : (canvas.getContext('2d', { alpha: false, desynchronized: true }) || canvas.getContext('2d'));
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
    this.audioDecoder = null;
    this.audioDecoderMode = 'none';
    this.audioDecoderConfig = null;
    this.audioBasePtsUs = null;
    this.audioQueuedSamples = 0;
    this.audioPlayedSamples = 0;
    this.audioBufferUs = 0;
    this.audioClockUs = 0;
    this.audioClockWallAt = 0;
    this.audioSyncPaused = false;
    this.buffering = false;
    this.pendingClockUs = 0;
    this.seekTargetUs = 0;
    this.lastElapsedEmit = 0;
    this.lastDrawnFrameUs = 0;
    this.lastRenderAt = 0;
    this.lastFrameIntervalMs = 0;
    this.frameIntervalJitterMs = 0;
    this.maxFrameIntervalMs = 0;
    this.renderedFrames = 0;
    this.droppedFrames = 0;
    this.seekDroppedFrames = 0;
    this.decodedFrames = 0;
    this.submittedFrames = 0;
    this.packetsRead = 0;
    this.seekStartedAt = 0;
    this.lastSeekReadyMs = 0;
    this.pumpRunning = false;
    this.volume = 1;
    this.raf = 0;
    this.subtitleNode = null;
    this.subtitleWrap = null;
    this.subtitleLastText = null;
    this.subtitleLastVisible = null;
    this.statsAt = 0;
    this.statsRenderedFrames = 0;
    this.statsDecodedFrames = 0;
    this.renderFps = 0;
    this.decodeFps = 0;
    this.timing = { version: VERSION, createdAt: Date.now(), marks: [] };
    this._renderLoop = this._renderLoop.bind(this);
  }

  HybridWebCodecsPlayer.open = async function (canvas, url, callbacks, options) {
    var player = new HybridWebCodecsPlayer(canvas, url, callbacks, options);
    await player.init();
    return player;
  };

  HybridWebCodecsPlayer.prototype.markTiming = function (name, extra) {
    var mark = Object.assign({
      name: name,
      ms: Math.round(performance.now() - (this.timing.startedAt || 0)),
      at: Date.now()
    }, extra || {});
    this.timing.marks.push(mark);
    this.timing.last = mark;
    window.__mpvwasm_hybrid_timing = this.timing;
    if (window.__MPV_WASM_DEBUG) console.log('[mpvwasm-hybrid-timing]', mark);
  };

  HybridWebCodecsPlayer.prototype.init = async function () {
    this.timing.startedAt = performance.now();
    this.markTiming('init-start');
    this.markTiming('ensure-demuxer-start');
    await ensureDemuxer();
    this.markTiming('ensure-demuxer-done');
    if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') {
      throw new Error('WebCodecs VideoDecoder is not available');
    }

    call(this.callbacks, 'status', 'hybrid demux open');
    this.markTiming('demux-open-start');
    this.session = window.MpvWasmDemuxer.openWorker ? await window.MpvWasmDemuxer.openWorker(this.url) : await window.MpvWasmDemuxer.open(this.url);
    this.timing.worker = this.session.workerTiming || this.session.info.workerTiming || null;
    this.markTiming('demux-open-done', { worker: this.timing.worker });
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

    this.markTiming('webcodecs-probe-start', { codec: this.videoTrack.codecName, width: this.videoTrack.width, height: this.videoTrack.height });
    this.config = await supportedConfig(this.videoTrack);
    if (!this.config) throw new Error('WebCodecs unsupported for ' + (this.videoTrack.codecName || 'video'));
    this.markTiming('webcodecs-probe-done', { config: this.config.codec });

    this.markTiming('video-config-start');
    this.configureVideoDecoder();
    this.markTiming('video-config-done');
    this.markTiming('audio-config-start');
    await this.configureAudio();
    this.markTiming('audio-config-done');
    this.findSubtitleNode();

    call(this.callbacks, 'duration', this.duration);
    call(this.callbacks, 'videoSize', { width: this.videoTrack.width || 0, height: this.videoTrack.height || 0 });
    call(this.callbacks, 'audioTracks', this.audioTracks);
    call(this.callbacks, 'subtitleTracks', this.subtitleTracks);
    call(this.callbacks, 'status', 'hybrid using ' + this.config.codec);

    this.startLoops();
    this.markTiming('loops-started');
  };

  HybridWebCodecsPlayer.prototype.configureVideoDecoder = function () {
    var self = this;
    if (this.videoDecoder) {
      try { this.videoDecoder.close(); } catch (_) { }
    }
    this.videoDecoder = new VideoDecoder({
      output: function (frame) {
        self.decodedFrames++;
        if (!self.timing.firstVideoFrameAt) {
          self.timing.firstVideoFrameAt = Date.now();
          self.markTiming('first-video-frame', { timestamp: Number(frame.timestamp || 0) });
        }
        if (self.seekTargetUs && Number(frame.timestamp || 0) < self.seekTargetUs - 120000) {
          self.seekDroppedFrames++;
          try { frame.close(); } catch (_) { }
          return;
        }
        self.frameQueue.push(frame);
        while (self.frameQueue.length > self.maxFrameQueue()) {
          self.droppedFrames++;
          try { self.frameQueue.shift().close(); } catch (_) { }
        }
        self.maybeReady();
        self.maybeResumeBuffering();
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
      self.audioClockWallAt = performance.now();
      self.audioPlayedSamples = Number(data.playedSamples || 0);
      self.audioBufferUs = Number(data.bufferUs || 0);
      self.emitElapsed(false);
      self.updateDebug();
    };
    this.audioNode.connect(this.audioContext.destination);
    await this.audioContext.suspend();
    await this.openSelectedAudioDecoder();
    this.resetAudioClock(null);
  };

  HybridWebCodecsPlayer.prototype.openSelectedAudioDecoder = async function () {
    if (!this.audioTrack) return 0;
    await this.closeSelectedAudioDecoder();
    this.audioDecoderConfig = audioCodecConfig(this.audioTrack);
    this.audioDecoderMode = 'wasm';
    if (this.audioDecoderConfig && typeof AudioDecoder === 'function' && typeof EncodedAudioChunk === 'function') {
      try {
        var support = await AudioDecoder.isConfigSupported(this.audioDecoderConfig);
        if (support && support.supported) {
          var self = this;
          this.audioDecoderMode = 'native';
          this.audioDecoder = new AudioDecoder({
            output: function (audioData) { self.handleNativeAudioData(audioData); },
            error: function (error) { call(self.callbacks, 'error', error); }
          });
          this.audioDecoder.configure(support.config || this.audioDecoderConfig);
          this.markTiming('audio-native-open', { codec: this.audioDecoderConfig.codec, channels: this.audioDecoderConfig.numberOfChannels });
          return 0;
        }
      } catch (error) {
        call(this.callbacks, 'status', 'native audio unsupported ' + (error && (error.message || error) || error));
      }
    }
    var ret = await this.session.openAudioDecoder(this.audioTrack.index);
    if (ret < 0) throw new Error('audio decoder open failed: ' + ret);
    this.markTiming('audio-wasm-open', { ret: ret, codec: this.audioTrack.codecName });
    return ret;
  };

  HybridWebCodecsPlayer.prototype.closeSelectedAudioDecoder = async function () {
    if (this.audioDecoder) {
      try { this.audioDecoder.close(); } catch (_) { }
      this.audioDecoder = null;
    }
    if (this.audioDecoderMode === 'wasm' && this.session) {
      try { await this.session.closeAudioDecoder(); } catch (_) { }
    }
    this.audioDecoderMode = 'none';
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
    this.audioClockWallAt = performance.now();
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
    this.audioClockWallAt = performance.now();
    var self = this;
    this.audioContext.resume().catch(function (error) {
      call(self.callbacks, 'error', error);
    });
  };

  HybridWebCodecsPlayer.prototype.pauseAudio = function () {
    if (!this.audioContext || this.destroyed) return;
    this.audioContext.suspend().catch(function () { });
  };

  HybridWebCodecsPlayer.prototype.enterBuffering = function () {
    if (this.buffering || this.destroyed || this.paused) return;
    this.buffering = true;
    this.pauseAudio();
    call(this.callbacks, 'buffering', true);
    call(this.callbacks, 'status', 'hybrid buffering');
    this.updateDebug();
  };

  HybridWebCodecsPlayer.prototype.maybeResumeBuffering = function () {
    if (!this.buffering || this.destroyed || this.paused) return;
    var videoReady = this.frameQueue.length >= 2;
    var audioReady = !this.audioTrack || this.audioBufferUs >= Math.min(500000, this.startupAudioBufferUs());
    if (!videoReady || !audioReady) return;
    this.buffering = false;
    call(this.callbacks, 'buffering', false);
    if (this.wantPlaying) this.resumeAudio();
    call(this.callbacks, 'status', 'hybrid resumed');
    this.updateDebug();
  };

  HybridWebCodecsPlayer.prototype.syncAudioToVideo = function () {
    return;
  };

  HybridWebCodecsPlayer.prototype.maxFrameQueue = function () {
    var width = Number(this.videoTrack && this.videoTrack.width || 0);
    return width >= 3000 ? 48 : 24;
  };

  HybridWebCodecsPlayer.prototype.startupAudioBufferUs = function () {
    var width = Number(this.videoTrack && this.videoTrack.width || 0);
    return width >= 3000 ? 900000 : 500000;
  };

  HybridWebCodecsPlayer.prototype.throttleReason = function () {
    if (this.seekTargetUs && !this.hasFrameNear(this.seekTargetUs, 180000)) return '';
    if (this.videoDecoder && this.videoDecoder.decodeQueueSize > 64) return 'video-decode';
    if (this.frameQueue.length >= this.maxFrameQueue()) return 'video-buffer';
    if (this.audioTrack && this.audioBufferUs > 6000000) return 'audio-buffer';
    if (!this.ready && this.audioTrack && this.audioBufferUs > this.startupAudioBufferUs() + 700000 && this.frameQueue.length > 8) return 'startup-buffer';
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
        var is4k = Number(this.videoTrack && this.videoTrack.width || 0) >= 3000;
        var limit = this.seekTargetUs ? (is4k ? 192 : 48) : (is4k ? 128 : 24);
        while (handled < limit && !this.destroyed && !this.seeking && !this.throttleReason()) {
          var packet = await this.session.readPacket();
          if (!packet) {
            call(this.callbacks, 'fileEnd');
            return;
          }
          if (!this.timing.firstPacketAt) {
            this.timing.firstPacketAt = Date.now();
            this.markTiming('first-packet', { type: packet.type, streamIndex: packet.streamIndex });
          }
          handled++;
          this.packetsRead++;
          await this.handlePacket(packet);
          if (this.videoDecoder && this.videoDecoder.decodeQueueSize > 64 && handled >= 2) break;
        }

        this.maybeReady();
        await sleep(this.videoDecoder && this.videoDecoder.decodeQueueSize > 56 ? 3 : 0);
      }
    } catch (error) {
      if (!this.destroyed) call(this.callbacks, 'error', error);
    } finally {
      this.pumpRunning = false;
    }
  };

  HybridWebCodecsPlayer.prototype.handlePacket = async function (packet) {
    if (packet.streamIndex === this.videoTrack.index) {
      if (!this.timing.firstVideoPacketAt) {
        this.timing.firstVideoPacketAt = Date.now();
        this.markTiming('first-video-packet', { ptsUs: packetTimeUs(packet), keyframe: !!packet.keyframe });
      }
      this.handleVideoPacket(packet);
    } else if (this.audioTrack && packet.streamIndex === this.audioTrack.index) {
      if (!this.timing.firstAudioPacketAt) {
        this.timing.firstAudioPacketAt = Date.now();
        this.markTiming('first-audio-packet', { ptsUs: packetTimeUs(packet) });
      }
      await this.handleAudioPacket(packet);
    } else if (this.subtitleTrack && packet.streamIndex === this.subtitleTrack.index) {
      this.handleSubtitlePacket(packet);
    }
  };

  HybridWebCodecsPlayer.prototype.handleVideoPacket = function (packet) {
    if (!this.videoDecoder || this.videoDecoder.state !== 'configured') return;
    if (this.seenVideoKeyframe && (this.videoDecoder.decodeQueueSize > 96 || this.frameQueue.length >= this.maxFrameQueue())) return;
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

  HybridWebCodecsPlayer.prototype.handleAudioPacket = async function (packet) {
    var ptsUs = packetTimeUs(packet);
    if (this.dropAudioBeforeUs && ptsUs + 50000 < this.dropAudioBeforeUs) return;
    if (this.audioDecoderMode === 'native' && this.audioDecoder && this.audioDecoder.state === 'configured') {
      try {
        this.audioDecoder.decode(new EncodedAudioChunk({
          type: 'key',
          timestamp: ptsUs,
          duration: packet.durationUs > 0 ? packet.durationUs : undefined,
          data: packet.data
        }));
      } catch (error) {
        call(this.callbacks, 'status', 'native audio decode retry ' + (error && (error.message || error) || error));
      }
      return;
    }
    var decoded = packet.decodedAudio || await this.session.decodeCurrentAudioPacket();
    if (!decoded) return;
    if (decoded.error) {
      call(this.callbacks, 'status', 'hybrid audio decode error ' + decoded.error);
      return;
    }
    if (this.audioBasePtsUs === null) this.resetAudioClock(ptsUs);
    if (!this.timing.firstAudioPcmAt) {
      this.timing.firstAudioPcmAt = Date.now();
      this.markTiming('first-audio-pcm', { ptsUs: ptsUs, samples: decoded.samples, channels: decoded.channels });
    }
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

  HybridWebCodecsPlayer.prototype.handleNativeAudioData = function (audioData) {
    var ptsUs = Number(audioData.timestamp || 0);
    if (this.dropAudioBeforeUs && ptsUs + 50000 < this.dropAudioBeforeUs) {
      try { audioData.close(); } catch (_) { }
      return;
    }
    var frames = Number(audioData.numberOfFrames || 0);
    var channels = Number(audioData.numberOfChannels || this.audioDecoderConfig && this.audioDecoderConfig.numberOfChannels || 2);
    var sampleRate = Number(audioData.sampleRate || this.audioDecoderConfig && this.audioDecoderConfig.sampleRate || 48000);
    if (!frames || !channels) {
      try { audioData.close(); } catch (_) { }
      return;
    }
    var pcm = new Float32Array(frames * channels);
    try {
      for (var ch = 0; ch < channels; ch++) {
        var plane = new Float32Array(frames);
        audioData.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
        for (var i = 0; i < frames; i++) pcm[i * channels + ch] = plane[i];
      }
    } catch (planarError) {
      try {
        audioData.copyTo(pcm, { planeIndex: 0, format: 'f32' });
      } catch (packedError) {
        try { audioData.close(); } catch (_) { }
        call(this.callbacks, 'error', packedError);
        return;
      }
    } finally {
      try { audioData.close(); } catch (_) { }
    }
    if (this.audioBasePtsUs === null) this.resetAudioClock(ptsUs);
    if (!this.timing.firstAudioPcmAt) {
      this.timing.firstAudioPcmAt = Date.now();
      this.markTiming('first-audio-pcm', { ptsUs: ptsUs, samples: frames, channels: channels, native: true });
    }
    this.audioQueuedSamples += frames;
    this.audioBufferUs = Math.max(0, Math.round((this.audioQueuedSamples - this.audioPlayedSamples) / Math.max(1, sampleRate) * 1000000));
    if (this.audioNode) {
      this.audioNode.port.postMessage({
        type: 'pcm',
        pcm: pcm.buffer,
        channels: channels,
        sampleRate: sampleRate,
        ptsUs: ptsUs
      }, [pcm.buffer]);
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
    var videoReady = this.seekTargetUs ? this.hasFrameNear(this.seekTargetUs, 180000) && this.frameQueue.length >= 2 : this.frameQueue.length >= 2;
    var audioReady = !this.audioTrack || this.audioBufferUs >= this.startupAudioBufferUs();
    if (!videoReady || !audioReady) return;

    var firstStart = !this.started;
    this.ready = true;
    this.seekTargetUs = 0;
    this.pendingClockUs = 0;
    if (this.seekStartedAt) {
      this.lastSeekReadyMs = Math.round(performance.now() - this.seekStartedAt);
      this.seekStartedAt = 0;
      this.markTiming('seek-ready', { durationMs: this.lastSeekReadyMs, elapsed: this.elapsed, renderedFrames: this.renderedFrames, decodedFrames: this.decodedFrames });
    }
    if (firstStart) {
      this.started = true;
      call(this.callbacks, 'fileStart', { backend: 'hybrid-webcodecs' });
      this.markTiming('ready', { elapsed: this.elapsed, renderedFrames: this.renderedFrames, decodedFrames: this.decodedFrames });
    }
    this.renderFrame(firstStart);
    if (this.wantPlaying) this.resumeAudio();
    this.isPlaying = !!this.wantPlaying;
    this.paused = !this.wantPlaying;
    call(this.callbacks, 'isPlaying', this.isPlaying);
    this.updateDebug();
  };

  HybridWebCodecsPlayer.prototype.currentClockUs = function () {
    if (this.audioTrack && this.audioClockUs) {
      if (!this.paused && this.audioClockWallAt) {
        var advancedUs = Math.max(0, Math.min(250000, Math.round((performance.now() - this.audioClockWallAt) * 1000)));
        return this.audioClockUs + advancedUs;
      }
      return this.audioClockUs;
    }
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
    var maxEarlyUs = force ? 300000 : 12000;
    var maxLateUs = force ? 900000 : (Number(this.videoTrack && this.videoTrack.width || 0) >= 3000 ? 450000 : 250000);
    var frame = null;

    while (this.frameQueue.length) {
      frame = this.frameQueue[0];
      var timestamp = Number(frame.timestamp || 0);
      var starved = !this.lastRenderAt || performance.now() - this.lastRenderAt > 600;
      if (!force && timestamp < clockUs - maxLateUs && (!starved || this.frameQueue.length > 1)) {
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
      if (this.renderer) this.renderer.render(frame, this.videoTrack && this.videoTrack.width, this.videoTrack && this.videoTrack.height);
      else {
        var rect = fitRect(this.canvas, this.videoTrack && this.videoTrack.width || frame.displayWidth || frame.codedWidth, this.videoTrack && this.videoTrack.height || frame.displayHeight || frame.codedHeight);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(frame, rect.x, rect.y, rect.width, rect.height);
      }
      this.lastDrawnFrameUs = Number(frame.timestamp || clockUs);
      var renderAt = performance.now();
      if (this.lastRenderAt) {
        var intervalMs = renderAt - this.lastRenderAt;
        var idealMs = 1000 / 24;
        this.lastFrameIntervalMs = Math.round(intervalMs * 10) / 10;
        this.maxFrameIntervalMs = Math.max(this.maxFrameIntervalMs * 0.98, intervalMs);
        this.frameIntervalJitterMs = this.frameIntervalJitterMs ? this.frameIntervalJitterMs * 0.85 + Math.abs(intervalMs - idealMs) * 0.15 : Math.abs(intervalMs - idealMs);
      }
      this.lastRenderAt = renderAt;
      this.renderedFrames++;
    } catch (error) {
      var message = String(error && (error.message || error) || '');
      if (this.renderer && !/VideoFrame has been closed/i.test(message)) {
        try { this.renderer.destroy(); } catch (_) { }
        this.renderer = null;
        this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true }) || this.canvas.getContext('2d');
        try {
          var fallbackRect = fitRect(this.canvas, this.videoTrack && this.videoTrack.width || frame.displayWidth || frame.codedWidth, this.videoTrack && this.videoTrack.height || frame.displayHeight || frame.codedHeight);
          this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
          this.ctx.drawImage(frame, fallbackRect.x, fallbackRect.y, fallbackRect.width, fallbackRect.height);
          this.lastDrawnFrameUs = Number(frame.timestamp || clockUs);
          this.lastRenderAt = performance.now();
          this.renderedFrames++;
        } catch (fallbackError) {
          call(this.callbacks, 'error', fallbackError);
        }
      } else if (/VideoFrame has been closed/i.test(message)) {
        this.droppedFrames++;
      } else {
        call(this.callbacks, 'error', error);
      }
    } finally {
      try { frame.close(); } catch (_) { }
    }
  };

  HybridWebCodecsPlayer.prototype.renderSubtitles = function (clockUs) {
    if (!this.subtitleNode || !this.subtitleWrap) return;
    if (!this.subtitleTrack) {
      if (this.subtitleLastText !== '' || this.subtitleLastVisible !== false) {
        this.subtitleNode.textContent = '';
        this.subtitleWrap.classList.add('hide');
        this.subtitleLastText = '';
        this.subtitleLastVisible = false;
      }
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
    var visible = !!active;
    if (active !== this.subtitleLastText) {
      this.subtitleNode.textContent = active;
      this.subtitleLastText = active;
    }
    if (visible !== this.subtitleLastVisible) {
      this.subtitleWrap.classList.toggle('hide', !visible);
      this.subtitleLastVisible = visible;
    }
  };

  HybridWebCodecsPlayer.prototype._renderLoop = function () {
    if (this.destroyed) return;
    if (this.ready && !this.paused && !this.buffering) this.renderFrame(false);
    if (this.ready && !this.paused && !this.buffering && !this.frameQueue.length && (!this.lastRenderAt || performance.now() - this.lastRenderAt > 250)) {
      this.enterBuffering();
    }
    this.maybeResumeBuffering();
    var clockUs = this.currentClockUs();
    this.renderSubtitles(clockUs);
    this.syncAudioToVideo();
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
    var now = performance.now();
    if (!this.statsAt) {
      this.statsAt = now;
      this.statsRenderedFrames = this.renderedFrames;
      this.statsDecodedFrames = this.decodedFrames;
    } else if (now - this.statsAt >= 1000) {
      this.renderFps = Math.round((this.renderedFrames - this.statsRenderedFrames) * 1000 / (now - this.statsAt) * 10) / 10;
      this.decodeFps = Math.round((this.decodedFrames - this.statsDecodedFrames) * 1000 / (now - this.statsAt) * 10) / 10;
      this.statsAt = now;
      this.statsRenderedFrames = this.renderedFrames;
      this.statsDecodedFrames = this.decodedFrames;
    }
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
      seekDroppedFrames: this.seekDroppedFrames,
      renderFps: this.renderFps,
      decodeFps: this.decodeFps,
      packetsRead: this.packetsRead,
      lastSeekReadyMs: this.lastSeekReadyMs,
      videoQueue: this.frameQueue.length,
      decodeQueue: this.videoDecoder ? this.videoDecoder.decodeQueueSize : 0,
      audioBufferUs: this.audioBufferUs,
      frameIntervalMs: this.lastFrameIntervalMs,
      frameJitterMs: Math.round(this.frameIntervalJitterMs * 10) / 10,
      maxFrameIntervalMs: Math.round(this.maxFrameIntervalMs * 10) / 10,
      audioSyncPaused: this.audioSyncPaused,
      buffering: this.buffering,
      audioDecoder: this.audioDecoderMode,
      renderer: this.renderer ? this.renderer.type : '2d',
      timing: this.timing,
      audioTrack: this.audioTrack && this.audioTrack.index,
      subtitleTrack: this.subtitleTrack && this.subtitleTrack.index
    };
  };

  HybridWebCodecsPlayer.prototype.setPause = function (paused) {
    this.paused = !!paused;
    this.wantPlaying = !this.paused;
    this.isPlaying = !this.paused;
    if (this.paused) {
      this.audioSyncPaused = false;
      this.pauseAudio();
    } else if (this.ready) {
      this.audioSyncPaused = false;
      this.resumeAudio();
    }
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
    this.markTiming('seek-start', { targetUs: targetUs, seekUs: seekUs });
    this.seeking = true;
    this.ready = false;
    this.audioSyncPaused = false;
    this.seekStartedAt = performance.now();
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
      try { await this.closeSelectedAudioDecoder(); } catch (_) { }
    }
    this.markTiming('seek-demux-start', { seekUs: seekUs });
    var ret = await this.session.seek(seekUs);
    this.markTiming('seek-demux-done', { ret: ret });
    if (ret < 0) call(this.callbacks, 'status', 'hybrid seek ret ' + ret);
    else call(this.callbacks, 'status', 'hybrid seek ok ' + (seekUs / 1000000).toFixed(3));
    if (this.audioTrack) {
      var audioRet = await this.openSelectedAudioDecoder();
      this.markTiming('seek-audio-open', { ret: audioRet });
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
    try { if (this.renderer) this.renderer.destroy(); } catch (_) { }
    try { await this.closeSelectedAudioDecoder(); } catch (_) { }
    try { if (this.audioNode) this.audioNode.disconnect(); } catch (_) { }
    try { if (this.audioContext) await this.audioContext.close(); } catch (_) { }
    try { if (this.session) await this.session.close(); } catch (_) { }
    this.videoDecoder = null;
    this.renderer = null;
    this.audioNode = null;
    this.audioDecoder = null;
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
