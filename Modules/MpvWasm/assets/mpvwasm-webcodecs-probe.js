(function () {
  'use strict';

  var VERSION = '20260708-64-hybrid-manual';

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('Unable to load ' + src)); };
      document.head.appendChild(script);
    });
  }

  async function ensureDemuxer() {
    if (!window.MpvWasmDemuxer) {
      await loadScript('/mpvwasm/assets/mpvwasm-demuxer-wrapper.js?v=' + VERSION);
    }
    if (!window.MpvWasmDemuxer) throw new Error('MpvWasmDemuxer was not found');
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

  function avcCodec(track, description) {
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
    var description = fromBase64(track.extradata || '');
    var codec = String(track.codecName || '').toLowerCase();
    var base = {
      codedWidth: Number(track.width || 0),
      codedHeight: Number(track.height || 0),
      description: description,
      hardwareAcceleration: 'prefer-hardware'
    };

    if (codec === 'h264') {
      var avc = Object.assign({}, base, { codec: avcCodec(track, description), avc: { format: 'avc' } });
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

  async function decodeVideoProbe(url, options) {
    options = options || {};
    await ensureDemuxer();
    if (typeof VideoDecoder !== 'function') throw new Error('VideoDecoder is not available');

    var session = await window.MpvWasmDemuxer.open(url);
    var videoTrack = (session.info.tracks || []).find(function (track) { return track.type === 'video'; });
    if (!videoTrack) throw new Error('No video track');

    var config = await supportedConfig(videoTrack);
    if (!config) throw new Error('VideoDecoder unsupported for ' + videoTrack.codecName);

    var canvas = options.canvas || document.createElement('canvas');
    var context = canvas.getContext('2d');
    canvas.width = Number(videoTrack.width || 1280);
    canvas.height = Number(videoTrack.height || 720);

    var decoded = 0;
    var rendered = 0;
    var dropped = 0;
    var firstTimestamp = null;
    var errors = [];

    var decoder = new VideoDecoder({
      output: function (frame) {
        decoded++;
        if (firstTimestamp === null) firstTimestamp = Number(frame.timestamp || 0);
        if (rendered < Number(options.renderFrames || 1)) {
          try {
            context.drawImage(frame, 0, 0, canvas.width, canvas.height);
            rendered++;
          } catch (error) {
            errors.push(String(error && (error.message || error) || error));
          }
        } else {
          dropped++;
        }
        frame.close();
      },
      error: function (error) {
        errors.push(String(error && (error.message || error) || error));
      }
    });

    decoder.configure(config);

    var submitted = 0;
    var seenKeyframe = false;
    var maxPackets = Number(options.maxPackets || 220);
    var maxFrames = Number(options.maxFrames || 8);

    while (submitted < maxPackets && decoded < maxFrames) {
      var packet = session.readPacket();
      if (!packet) break;
      if (packet.streamIndex !== videoTrack.index) continue;
      if (!seenKeyframe && !packet.keyframe) continue;
      seenKeyframe = true;
      var timestamp = packet.ptsUs > -9000000000000000 ? packet.ptsUs : packet.dtsUs;
      decoder.decode(new EncodedVideoChunk({
        type: packet.keyframe ? 'key' : 'delta',
        timestamp: timestamp,
        duration: packet.durationUs > 0 ? packet.durationUs : undefined,
        data: packet.data
      }));
      submitted++;
      if (decoder.decodeQueueSize > 16) await new Promise(function (resolve) { setTimeout(resolve, 0); });
    }

    await decoder.flush();
    decoder.close();
    session.close();

    return {
      track: videoTrack,
      config: { codec: config.codec, codedWidth: config.codedWidth, codedHeight: config.codedHeight, hardwareAcceleration: config.hardwareAcceleration },
      submitted: submitted,
      decoded: decoded,
      rendered: rendered,
      dropped: dropped,
      firstTimestamp: firstTimestamp,
      errors: errors
    };
  }

  window.MpvWasmWebCodecs = {
    version: VERSION,
    supportedConfig: supportedConfig,
    decodeVideoProbe: decodeVideoProbe
  };

  window.HybridWebCodecsBackend = window.HybridWebCodecsBackend || {};
  window.HybridWebCodecsBackend.probeVideo = decodeVideoProbe;
})();
