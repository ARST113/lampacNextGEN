(function () {
  'use strict';

  var VERSION = '20260723-42-continuous-av';

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
    var profile = Number(track && track.profile || 1);
    if (!isFinite(profile) || profile <= 0) profile = 1;
    var level = Number(track && track.level || 153);
    if (!isFinite(level) || level <= 0) level = 153;
    return 'hvc1.' + profile + '.' + (profile === 2 ? 4 : 6) + '.L' + level + '.B0';
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

  function videoConfigs(track) {
    var description = fromBase64(track.extradata || '');
    var codec = String(track.codecName || '').toLowerCase();
    var base = {
      codedWidth: Number(track.width || 0),
      codedHeight: Number(track.height || 0)
    };

    function candidates(codecName, extra) {
      return ['prefer-hardware', 'no-preference', ''].map(function (hardwareAcceleration) {
        var config = Object.assign({}, base, extra || {}, { codec: codecName });
        if (description && description.length) config.description = description;
        if (hardwareAcceleration) config.hardwareAcceleration = hardwareAcceleration;
        return config;
      });
    }

    if (codec === 'h264') {
      return candidates(avcCodec(track, description), { avc: { format: 'avc' } });
    }
    if (codec === 'hevc') {
      var codecs = [
        hevcCodecFromHvcC(description, 'hvc1'),
        hevcCodecFromHvcC(description, 'hev1'),
        hevcCodec(track),
        hevcCodec(track).replace(/^hvc1/, 'hev1')
      ].filter(function (item, index, list) { return item && list.indexOf(item) === index; });
      return codecs.reduce(function (all, codecName) { return all.concat(candidates(codecName)); }, []);
    }
    if (codec === 'av1') return candidates('av01.0.12M.08');
    if (codec === 'vp9') return candidates('vp09.00.51.08');
    return [];
  }

  async function supportedConfig(track) {
    if (window.HybridWebCodecsBackend && window.HybridWebCodecsBackend.supportedConfig) {
      return window.HybridWebCodecsBackend.supportedConfig(track);
    }
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

  function hevcSampleInfo(data, lengthSize) {
    var empty = { valid: false, keyframe: false, keyData: data };
    if (!data || !data.byteLength) return empty;
    lengthSize = Number(lengthSize || 4);
    if (lengthSize < 1 || lengthSize > 4) lengthSize = 4;
    var offset = 0;
    var units = [];
    while (offset + lengthSize <= data.byteLength) {
      var start = offset;
      var size = 0;
      for (var i = 0; i < lengthSize; i++) size = (size * 256) + data[offset + i];
      offset += lengthSize;
      if (!size || offset + size > data.byteLength) return empty;
      units.push({ start: start, type: (data[offset] >> 1) & 0x3f });
      offset += size;
    }
    if (!units.length || offset !== data.byteLength) return empty;
    var firstIrap = -1;
    for (var j = 0; j < units.length; j++) {
      if (units[j].type >= 16 && units[j].type <= 23) {
        firstIrap = j;
        break;
      }
    }
    return {
      valid: true,
      keyframe: firstIrap >= 0,
      keyData: firstIrap > 0 ? data.subarray(units[firstIrap].start) : data
    };
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
      var hevcInfo = config._mpvwasmHevc
        ? hevcSampleInfo(packet.data, config._mpvwasmNalLengthSize)
        : null;
      var keyframe = hevcInfo && hevcInfo.valid ? hevcInfo.keyframe : !!packet.keyframe;
      if (!seenKeyframe && !keyframe) continue;
      var firstChunk = !seenKeyframe;
      seenKeyframe = true;
      var timestamp = packet.ptsUs > -9000000000000000 ? packet.ptsUs : packet.dtsUs;
      decoder.decode(new EncodedVideoChunk({
        type: keyframe ? 'key' : 'delta',
        timestamp: timestamp,
        duration: packet.durationUs > 0 ? packet.durationUs : undefined,
        data: firstChunk && hevcInfo && hevcInfo.keyframe ? hevcInfo.keyData : packet.data
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
