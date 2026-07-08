(function () {
  'use strict';

  var VERSION = '20260708-87-range-cache';

  function append(src, ready) {
    if (ready && ready()) return;
    if (document.querySelector('script[data-mpvwasm-src="' + src + '"]')) return;
    var script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = src;
    script.setAttribute('data-mpvwasm-src', src);
    document.head.appendChild(script);
  }

  if (!window.MpvWasmTest && !window.__mpvwasm_core_loading) {
    window.__mpvwasm_core_loading = true;
    var core = document.createElement('script');
    core.type = 'text/javascript';
    core.src = '/mpvwasm/player.js?v=core-' + VERSION;
    core.onload = function () { window.__mpvwasm_core_loading = false; };
    core.onerror = function () { window.__mpvwasm_core_loading = false; };
    document.head.appendChild(core);
  }

  append('/mpvwasm/assets/mpvwasm-demuxer-wrapper.js?v=' + VERSION, function () {
    return !!window.MpvWasmDemuxer;
  });
  append('/mpvwasm/assets/mpvwasm-hybrid-webcodecs.js?v=' + VERSION, function () {
    return !!(window.HybridWebCodecsBackend && window.HybridWebCodecsBackend.open);
  });
})();

(function () {
  'use strict';

  var VERSION = '20260708-87-range-cache';
  var TORRSERVER_URL = 'https://newgenres.duckdns.org/TS';
  var OLD_TORRSERVER_RE = /^http:\/\/213\.171\.26\.189:2367(?=\/|$)/i;
  var HTTP_TORRSERVER_RE = /^http:\/\/newgenres\.duckdns\.org\/TS(?=\/|$)/i;
  if (window.__mpvwasm_lampa_plugin === VERSION) return;
  window.__mpvwasm_lampa_plugin = VERSION;

  function waitLampa(callback) {
    var timer = setInterval(function () {
      if (window.Lampa && Lampa.Player && Lampa.Player.listener && window.MpvWasmTest) {
        clearInterval(timer);
        callback();
      }
    }, 200);
  }

  function storageBool(name, fallback) {
    try {
      var value = Lampa.Storage.get(name, fallback ? 'true' : 'false');
      return value === true || value === 'true' || value === '1';
    } catch (_) {
      return !!fallback;
    }
  }

  function encodeBase64Url(value) {
    var bytes = new TextEncoder().encode(value);
    var binary = '';
    bytes.forEach(function (b) { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function normalizeUrl(url) {
    return String(url || '')
      .replace(OLD_TORRSERVER_RE, TORRSERVER_URL.replace(/\/+$/, ''))
      .replace(HTTP_TORRSERVER_RE, TORRSERVER_URL.replace(/\/+$/, ''))
      .replace(/&(preload|stat|m3u)(?=&|$)/g, '&play');
  }

  function shouldUseMpvWasm(data) {
    if (!mpvWasmModeEnabled()) return false;
    var url = normalizeUrl(data && data.url);
    if (!url || /\/mpvwasm\//i.test(url) || /\.m3u8($|\?|#)/i.test(url)) return false;
    return /\.(mkv|avi|flv|m2ts|ts)($|\?|#)/i.test(url) || /\/stream\//i.test(url) || /\/lite\/pidtor\//i.test(url);
  }

  function storageField(name, fallback) {
    try {
      if (Lampa.Storage && typeof Lampa.Storage.field === 'function') return Lampa.Storage.field(name);
      return Lampa.Storage.get(name, fallback);
    } catch (_) {
      return fallback;
    }
  }

  function mpvWasmModeEnabled() {
    var mode = mpvWasmPlayerMode();
    return mode === 'mpv' || mode === 'mpv2';
  }

  function mpvWasmPlayerMode() {
    return String(storageField('mpvwasm_player_mode', 'default') || '').toLowerCase();
  }

  function directUrl(raw) {
    raw = normalizeUrl(raw);
    if (/^https:\/\/newgenres\.duckdns\.org\/TS\/+/i.test(raw)) return raw;
    if (/^\/mpvwasm\/proxy/i.test(raw) || /^https?:\/\/[^/]+\/mpvwasm\/proxy/i.test(raw)) return raw;
    return '/mpvwasm/proxy?u=' + encodeURIComponent(encodeBase64Url(raw));
  }

  function proxyUrl(raw) {
    raw = normalizeUrl(raw);
    if (/^\/mpvwasm\/proxy/i.test(raw) || /^https?:\/\/[^/]+\/mpvwasm\/proxy/i.test(raw)) return raw;
    return '/mpvwasm/proxy?u=' + encodeURIComponent(encodeBase64Url(raw));
  }

  function torserverIp() {
    try {
      var tor = (Lampa && Lampa.Torserver) || window.Torserver;
      return tor && tor.ip ? String(tor.ip() || '') : '';
    } catch (_) {
      return '';
    }
  }

  function playerInfoStatData(data) {
    var copy = {};
    Object.keys(data || {}).forEach(function (key) { copy[key] = data[key]; });
    if (copy.url) copy.url = normalizeUrl(copy.url);
    return copy;
  }

  function isHeavyVideoUrl(url) {
    return /(2160p|uhd|4k|hdr|hdr10|dolby[\s._-]*vision|\bdv\b|hevc|h\.?265|x265)/i.test(String(url || ''));
  }

  function videoProbeText(data) {
    if (!data || typeof data !== 'object') return String(data || '');
    var values = [];
    Object.keys(data).forEach(function (key) {
      var value = data[key];
      if (typeof value === 'string' || typeof value === 'number') values.push(String(value));
    });
    return values.join(' ');
  }

  function isHeavyVideoData(data) {
    return isHeavyVideoUrl(videoProbeText(data));
  }

  function isDirectTorrServerUrl(url) {
    return /^https:\/\/newgenres\.duckdns\.org\/TS\/+/i.test(normalizeUrl(url));
  }

  function shouldUseHardwareVideo(data) {
    return isDirectTorrServerUrl(data && data.url) || isHeavyVideoData(data);
  }

  function mpvOptionsFor(data) {
    if (!isHeavyVideoData(data)) return '';
    return 'profile=fast,vd-lavc-fast=yes,vd-lavc-skiploopfilter=all,vd-lavc-skipidct=nonref,vd-lavc-skipframe=nonref,framedrop=vo,video-sync=audio,interpolation=no';
  }

  function fileExtension(url) {
    var clean = String(url || '').split('#')[0].split('?')[0].toLowerCase();
    var match = clean.match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
  }

  function guessContainer(url) {
    var ext = fileExtension(url);
    if (/^(mkv|mk3d|mka)$/.test(ext)) return 'matroska';
    if (/^(mp4|m4v|mov)$/.test(ext)) return 'mp4';
    if (/^(webm)$/.test(ext)) return 'webm';
    if (/^(ts|m2ts)$/.test(ext)) return 'mpegts';
    if (/^(avi)$/.test(ext)) return 'avi';
    return /\/stream\//i.test(String(url || '')) ? 'stream' : ext;
  }

  function guessVideoCodec(data) {
    var text = videoProbeText(data).toLowerCase();
    if (/(av1|av01)/.test(text)) return 'av1';
    if (/(hevc|h\.?265|x265|\bhvc1\b|\bhev1\b|dolby[\s._-]*vision|\bdv\b)/.test(text)) return 'hevc';
    if (/(h\.?264|x264|avc1)/.test(text)) return 'h264';
    if (/(vp9|vp09)/.test(text)) return 'vp9';
    if (/(vp8|vp08)/.test(text)) return 'vp8';
    return '';
  }

  function guessAudioCodec(data) {
    var text = videoProbeText(data).toLowerCase();
    if (/(eac3|e-ac-3|ddp|dd\+|atmos)/.test(text)) return 'eac3';
    if (/(ac3|ac-3|dolby digital)/.test(text)) return 'ac3';
    if (/(dts|truehd)/.test(text)) return text.indexOf('truehd') >= 0 ? 'truehd' : 'dts';
    if (/(aac|mp4a)/.test(text)) return 'aac';
    if (/(opus)/.test(text)) return 'opus';
    if (/(mp3)/.test(text)) return 'mp3';
    return '';
  }

  function buildMediaProbe(data) {
    var url = normalizeUrl(data && data.url);
    return {
      url: url,
      container: guessContainer(url),
      videoCodec: guessVideoCodec(data),
      audioCodec: guessAudioCodec(data),
      heavy: isHeavyVideoData(data),
      directTorrServer: isDirectTorrServerUrl(url),
      hasWebCodecs: typeof window.VideoDecoder === 'function',
      hasAudioDecoder: typeof window.AudioDecoder === 'function',
      hasDemuxOnly: !!(window.MpvWasmDemuxer && typeof window.MpvWasmDemuxer.open === 'function'),
      hasHybridBackend: !!(window.HybridWebCodecsBackend && typeof window.HybridWebCodecsBackend.open === 'function')
    };
  }

  function canPlayNativeSource(probe) {
    try {
      var video = document.createElement('video');
      var container = probe && probe.container;
      if (container === 'mp4') {
        return !!(video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') || video.canPlayType('video/mp4'));
      }
      if (container === 'webm') {
        return !!(video.canPlayType('video/webm; codecs="vp9, opus"') || video.canPlayType('video/webm'));
      }
      if (container === 'matroska') return false;
    } catch (_) { }
    return false;
  }

  function webCodecsCodecString(probe) {
    var codec = probe && probe.videoCodec;
    if (codec === 'h264') return 'avc1.640028';
    if (codec === 'hevc') return 'hvc1.1.6.L153.B0';
    if (codec === 'av1') return 'av01.0.12M.08';
    if (codec === 'vp9') return 'vp09.00.51.08';
    if (codec === 'vp8') return 'vp8';
    return '';
  }

  function canMaybeUseWebCodecs(probe) {
    if (!probe || !probe.hasWebCodecs) return false;
    if (webCodecsCodecString(probe)) return true;
    return /^(matroska|stream|mpegts|avi)$/.test(String(probe.container || ''));
  }

  function selectBackend(data) {
    var probe = buildMediaProbe(data);
    var playerMode = mpvWasmPlayerMode();
    var forced = playerMode === 'mpv2' ? 'hybrid' : String(storageField('mpvwasm_backend_mode', 'auto') || 'auto').toLowerCase();
    var nativePlayable = canPlayNativeSource(probe);
    var webCodecsCandidate = canMaybeUseWebCodecs(probe);
    var decision = {
      selected: 'mpv-wasm-fallback',
      candidate: '',
      reason: '',
      requested: playerMode === 'mpv2' ? 'mpv2' : forced,
      probe: probe
    };

    if (playerMode === 'mpv2') {
      decision.selected = 'hybrid-webcodecs';
      decision.candidate = 'hybrid-webcodecs';
      if (!probe.hasWebCodecs) decision.reason = 'mpv2-requires-webcodecs';
      else if (!probe.hasDemuxOnly) decision.reason = 'mpv2-requires-demux';
      else if (!probe.hasHybridBackend) decision.reason = 'mpv2-requires-hybrid-backend';
      else decision.reason = 'mpv2-strict-hybrid';
      return decision;
    }

    if (forced === 'mpv') {
      decision.reason = 'forced-mpv-wasm';
      return decision;
    }

    if (nativePlayable && forced !== 'hybrid') {
      decision.selected = 'html5';
      decision.reason = 'native-can-play-type';
      return decision;
    }

    if (webCodecsCandidate) {
      decision.candidate = 'hybrid-webcodecs';
      if (forced === 'hybrid' && probe.hasDemuxOnly && probe.hasHybridBackend) {
        decision.selected = 'hybrid-webcodecs';
        decision.reason = 'webcodecs-pipeline-available';
      } else if (forced !== 'hybrid') {
        decision.reason = 'hybrid-disabled-in-auto';
      } else if (probe.hasDemuxOnly) {
        decision.reason = 'webcodecs-pipeline-missing';
      } else {
        decision.reason = 'webcodecs-demux-missing';
      }
      return decision;
    }

    decision.reason = probe.hasWebCodecs ? 'webcodecs-video-codec-unknown' : 'webcodecs-unavailable';
    return decision;
  }

  async function canDecodeVideoWithWebCodecs(probe) {
    if (!probe || typeof window.VideoDecoder !== 'function') return { supported: false, reason: 'no-videodecoder' };
    var codec = webCodecsCodecString(probe);
    if (!codec) return { supported: false, reason: 'unknown-codec' };
    try {
      return await VideoDecoder.isConfigSupported({
        codec: codec,
        codedWidth: probe.width || (probe.heavy ? 3840 : 1920),
        codedHeight: probe.height || (probe.heavy ? 2160 : 1080),
        hardwareAcceleration: 'prefer-hardware'
      });
    } catch (error) {
      return { supported: false, reason: String(error && (error.message || error) || error) };
    }
  }

  function notify(message) {
    try {
      if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message);
      else console.log('[MPV WASM]', message);
    } catch (_) { }
  }

  function numField(object, fields) {
    for (var i = 0; object && i < fields.length; i++) {
      var value = object[fields[i]];
      if (value !== undefined && value !== null && value !== '') {
        var number = parseInt(value, 10);
        if (!isNaN(number)) return number;
      }
    }
    return 0;
  }

  function timelineHash(data) {
    data = data || {};
    if (data.timeline && data.timeline.hash) return data.timeline.hash;
    var explicit = data.timeline_hash || data.timelineHash || data.view_hash || data.viewHash || data.time_hash || data.timeHash;
    if (explicit) return explicit;
    if ((typeof data.hash === 'number') || /^-?\d+$/.test(String(data.hash || ''))) return data.hash;

    var card = data.card || data.movie || data.item || data.object || data;
    var title = card.original_name || card.original_title || data.original_name || data.original_title;
    var season = numField(data, ['season', 'season_number', 'seasonNum', 'season_num', 's']);
    var episode = numField(data, ['episode', 'episode_number', 'episodeNum', 'episode_num', 'e']);
    try {
      if (window.Lampa && Lampa.Utils && Lampa.Utils.hash) {
        if (title && season && episode) return Lampa.Utils.hash([season, season > 10 ? ':' : '', episode, title].join(''));
        if ((card.original_title || data.original_title) && !episode) return Lampa.Utils.hash(card.original_title || data.original_title);
        if (data.url) return Lampa.Utils.hash(normalizeUrl(data.url));
      }
    } catch (_) { }
    return '';
  }

  function resolveTimeline(data) {
    if (data && data.timeline && (data.timeline.handler || data.timeline.time || data.timeline.percent || data.timeline.hash)) return data.timeline;
    var hash = timelineHash(data);
    if (!hash) return data && data.timeline ? data.timeline : null;
    try {
      if (window.Lampa && Lampa.Timeline && Lampa.Timeline.view) return Lampa.Timeline.view(hash);
    } catch (_) { }
    return data && data.timeline ? data.timeline : { hash: hash };
  }

  function addSettings() {
    if (!Lampa.SettingsApi || window.__mpvwasm_settings_ready === VERSION) return;
    window.__mpvwasm_settings_ready = VERSION;

    if (Lampa.Params && Lampa.Params.select) {
      Lampa.Params.select('mpvwasm_player_mode', {
        'default': 'Обычный плеер',
        'mpv': 'MPV WASM',
        'mpv2': 'MPV2 WebCodecs'
      }, 'default');
    }

    Lampa.SettingsApi.addParam({
      component: 'player',
      param: {
        name: 'mpvwasm_player_mode',
        type: 'select',
        values: {
          'default': 'Обычный плеер',
          'mpv': 'MPV WASM',
          'mpv2': 'MPV2 WebCodecs'
        },
        default: 'default'
      },
      field: {
        name: 'Плеер для торрентов',
        description: 'MPV WASM перехватывает запуск только когда здесь выбран MPV WASM'
      }
    });

  }

  var active = null;
  var ignorePlayerDestroyUntil = 0;
  var lastError = '';
  var pooledPlayer = null;
  var pooledCanvas = null;
  var pooledShell = null;
  var pooledReady = null;
  var pooledUrl = '';
  var assetWarmReady = null;

  function removeNode(node) {
    try { if (node && node.parentNode) node.parentNode.removeChild(node); } catch (_) { }
  }

  function cachePlayer(player, canvas, shell, url) {
    if (!player || !canvas) return;
    pooledPlayer = player;
    pooledCanvas = canvas;
    pooledShell = shell || null;
    pooledUrl = url || '';
    try { if (pooledPlayer.setOptions) pooledPlayer.setOptions({}); } catch (_) { }
    try { pooledPlayer.setPause(true); } catch (_) { }
  }

  function discardPooledPlayer() {
    try { if (pooledPlayer) pooledPlayer.destroy(); } catch (_) { }
    removeNode(pooledShell);
    pooledPlayer = null;
    pooledCanvas = null;
    pooledShell = null;
    pooledReady = null;
    pooledUrl = '';
  }

  function clearPooledShell() {
    if (pooledShell && (!pooledCanvas || !pooledShell.contains(pooledCanvas))) removeNode(pooledShell);
    pooledShell = null;
  }

  function prewarmMpvPlayer() {
    if (assetWarmReady || !mpvWasmModeEnabled()) return assetWarmReady;
    var urls = [
      '/mpvwasm/libmpv.js?v=' + VERSION,
      '/mpvwasm/assets/mpvplayer-wrapper.js?v=' + VERSION,
      '/mpvwasm/libmpv.wasm?v=' + VERSION,
      '/mpvwasm/libmpv.data?v=' + VERSION
    ];
    assetWarmReady = Promise.all(urls.map(function (url) {
      return fetch(url, { cache: 'force-cache', credentials: 'same-origin' }).catch(function () { return null; });
    })).then(function () { return true; }, function () { return false; });
    return assetWarmReady;
  }

  function schedulePrewarm() {
    setTimeout(prewarmMpvPlayer, 1200);
  }

  function closeActive() {
    if (!active) return;
    var closing = active;
    try { document.removeEventListener('keydown', active.onKey, true); } catch (_) { }
    try { if (active.onClose) active.onClose(); } catch (_) { }
    if (closing.state && closing.state.hardwareVideo) {
      try { if (closing.player) closing.player.destroy(); } catch (_) { }
    } else if (closing.player && closing.ui && closing.ui.canvas) cachePlayer(closing.player, closing.ui.canvas, null, closing.playUrl);
    else {
      try { if (closing.player) closing.player.destroy(); } catch (_) { }
    }
    removeNode(closing.root);
    try { Lampa.Loading.stop(); } catch (_) { }
    active = null;
    window.__mpvwasm_active = null;
  }

  function button(label, title, click) {
    var node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    node.title = title || label;
    node.addEventListener('click', click);
    return node;
  }

  function openTrackSelect(title, tracks, select) {
    if (!tracks || !tracks.length) {
      notify('Дорожки пока не найдены');
      return;
    }

    var last = Lampa.Controller && Lampa.Controller.enabled ? Lampa.Controller.enabled().name : '';
    Lampa.Select.show({
      title: title,
      items: tracks.map(function (track, index) {
        var text = track.title || track.label || track.lang || ('#' + track.id) || String(index + 1);
        var details = [];
        if (track.lang) details.push(String(track.lang).toUpperCase());
        if (track.codec) details.push(String(track.codec).toUpperCase());
        if (track.audioChannels) details.push(track.audioChannels + 'ch');
        return {
          title: text,
          subtitle: details.join(' • '),
          selected: !!track.selected,
          track: track
        };
      }),
      onSelect: function (item) {
        Lampa.Select.close();
        if (item && item.track) select(item.track);
        try { if (Lampa.Controller) Lampa.Controller.toggle('mpvwasm_panel'); } catch (_) { }
      },
      onBack: function () {
        try { if (Lampa.Controller) Lampa.Controller.toggle(last && last !== 'select' ? last : 'mpvwasm_panel'); } catch (_) { }
      }
    });
  }

  function publishTracks(audioTracks, subtitleTracks) {
    if (!window.Lampa || !Lampa.PlayerPanel) return;

    if (audioTracks && audioTracks.length && Lampa.PlayerPanel.setTracks) {
      Lampa.PlayerPanel.setTracks(audioTracks.map(function (track, index) {
        var elem = {
          index: index,
          language: track.lang || '',
          label: track.title || track.lang || ('Audio #' + track.id),
          selected: !!track.selected
        };
        Object.defineProperty(elem, 'enabled', {
          set: function (value) {
            if (value && active && active.player) active.player.setAudioTrack(track.id);
          },
          get: function () {
            return elem.selected;
          }
        });
        return elem;
      }));
    }

    if (subtitleTracks && subtitleTracks.length && Lampa.PlayerPanel.setSubs) {
      Lampa.PlayerPanel.setSubs(subtitleTracks.map(function (track, index) {
        var elem = {
          index: index,
          language: track.lang || '',
          label: track.title || track.lang || ('Sub #' + track.id),
          selected: !!track.selected
        };
        Object.defineProperty(elem, 'mode', {
          set: function (value) {
            if (value && value !== 'disabled' && active && active.player) active.player.setSubtitleTrack(track.id);
          },
          get: function () {
            return elem.selected ? 'showing' : 'disabled';
          }
        });
        return elem;
      }));
    }
  }

  function templateNode(name, fallback) {
    try {
      if (window.Lampa && Lampa.Template && Lampa.Template.get) {
        var tpl = Lampa.Template.get(name);
        if (tpl && tpl[0]) return tpl[0];
        if (tpl && tpl.nodeType) return tpl;
      }
    } catch (_) { }

    var wrap = document.createElement('div');
    wrap.innerHTML = fallback;
    return wrap.firstElementChild;
  }

  function lang(key, fallback) {
    try {
      var text = Lampa.Lang && Lampa.Lang.translate ? Lampa.Lang.translate(key) : '';
      return text && text !== key ? text : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function triggerNode(node, name) {
    if (!node) return;
    try {
      if (window.$) $(node).trigger(name);
      else node.dispatchEvent(new CustomEvent(name, { bubbles: true }));
    } catch (_) { }
  }

  function debugOverlayEnabled() {
    return !!window.__MPV_WASM_DEBUG || storageBool('mpvwasm_debug_overlay', false);
  }

  function createOverlay(existingCanvas) {
    var root = templateNode('player', '<div class="player"></div>');
    var video = templateNode('player_video', '<div class="player-video"><div class="player-video__display"></div><div class="player-video__loader"></div><div class="player-video__paused hide"></div><div class="player-video__backwork-icon"><i></i><span></span></div><div class="player-video__forward-icon"><span></span><i></i></div><div class="player-video__subtitles hide"><div class="player-video__subtitles-text"></div></div></div>');
    var panel = templateNode('player_panel', '<div class="player-panel"><div class="player-panel__body"><div class="player-panel__timeline selector"><div class="player-panel__peding"></div><div class="player-panel__position"><div></div></div><div class="player-panel__time hide"></div></div><div class="player-panel__line player-panel__line-one"><div class="player-panel__timenow"></div><div class="player-panel__timeend"></div></div><div class="player-panel__line player-panel__line-two"><div class="player-panel__left"></div><div class="player-panel__center"><div class="player-panel__rprev button selector">-</div><div class="player-panel__playpause button selector"><div>play</div><div>pause</div></div><div class="player-panel__rnext button selector">+</div></div><div class="player-panel__right"><div class="player-panel__tracks button selector hide">A</div><div class="player-panel__subs button selector hide">S</div><div class="player-panel__settings button selector">*</div><div class="player-panel__fullscreen button selector">[]</div></div></div></div></div>');
    var style = document.createElement('style');
    var display = video.querySelector('.player-video__display') || video;
    var canvas = existingCanvas || document.createElement('canvas');
    var debug = document.createElement('pre');

    root.classList.add('mpvwasm-lampa-root');
    if (debugOverlayEnabled()) root.classList.add('mpvwasm-debug-enabled');
    canvas.className = 'player-video__video mpvwasm-player-canvas';
    canvas.setAttribute('playsinline', 'playsinline');
    canvas.id = 'canvas';
    debug.className = 'mpvwasm-debug';
    style.textContent = '.mpvwasm-lampa-root{position:fixed;inset:0;z-index:50;background:#000}.mpvwasm-lampa-root .player-video__display{position:fixed;inset:0;background:#000}.mpvwasm-lampa-root .mpvwasm-player-canvas{position:fixed;inset:0;width:100%;height:100%;background:#000;object-fit:contain}.mpvwasm-lampa-root .player-panel__quality{text-transform:uppercase}.mpvwasm-lampa-root .mpvwasm-player__status{display:none}.mpvwasm-lampa-root .mpvwasm-debug{display:none;position:fixed;left:16px;top:16px;z-index:90;max-width:520px;max-height:52vh;overflow:hidden;margin:0;padding:10px 12px;background:rgba(0,0,0,.72);color:#9ff;font:12px/1.35 monospace;white-space:pre-wrap;pointer-events:none}.mpvwasm-lampa-root.mpvwasm-debug-enabled .mpvwasm-debug{display:block}';
    display.appendChild(canvas);
    root.appendChild(style);
    root.appendChild(video);
    root.appendChild(panel);
    root.appendChild(debug);
    try {
      if (window.Lampa && Lampa.PlayerInfo && Lampa.PlayerInfo.render) {
        var info = Lampa.PlayerInfo.render();
        var infoNode = info && (info[0] || info);
        if (infoNode) root.appendChild(infoNode);
      }
    } catch (_) { }
    document.body.appendChild(root);

    return {
      root: root,
      video: video,
      display: display,
      canvas: canvas,
      debug: debug,
      panel: panel,
      status: document.createElement('div'),
      back: root.querySelector('.head-backward'),
      loader: video.querySelector('.player-video__loader'),
      paused: video.querySelector('.player-video__paused'),
      rewindBack: video.querySelector('.player-video__backwork-icon'),
      rewindForward: video.querySelector('.player-video__forward-icon'),
      timeline: panel.querySelector('.player-panel__timeline'),
      timeFloat: panel.querySelector('.player-panel__time'),
      timeNow: panel.querySelector('.player-panel__timenow'),
      timeEnd: panel.querySelector('.player-panel__timeend'),
      position: panel.querySelector('.player-panel__position'),
      peding: panel.querySelector('.player-panel__peding'),
      volume: panel.querySelector('.player-panel__volume-range')
    };
  }

  function createHardwareVideoPlayer(ui, url, callbacks, sidecarUrl) {
    return new Promise(function (resolve) {
      var video = document.createElement('video');
      var timer = 0;
      var tracksTimer = 0;
      var syncTimer = 0;
      var sidecar = null;
      var sidecarReady = false;
      var sidecarPendingSeek = null;
      var sidecarVolume = 1;
      var sidecarCanvas = null;
      var sidecarSeeking = false;
      var sidecarSeekTarget = 0;
      var sidecarSeekAt = 0;
      var sidecarLastElapsed = NaN;
      var sidecarLastWall = 0;
      var sidecarClockMoving = false;
      var sidecarReloading = false;
      var sidecarReloadAt = 0;
      var sidecarStallReloadAt = 0;
      var sidecarStallReloads = 0;
      var sidecarAudioFallback = false;
      video.className = 'player-video__video mpvwasm-player-canvas mpvwasm-hw-video';
      video.playsInline = true;
      video.autoplay = true;
      video.controls = false;
      video.preload = 'auto';
      video.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;background:#000;object-fit:contain';
      if (sidecarUrl) video.muted = true;
      try { ui.canvas.style.display = 'none'; } catch (_) { }
      ui.display.appendChild(video);
      ui.nativeVideo = video;

      function call(name, value) {
        try {
          if (callbacks && typeof callbacks[name] === 'function') callbacks[name](value);
        } catch (_) { }
      }

      function sidecarElapsed() {
        var elapsed = sidecar && Number(sidecar.elapsed || 0);
        return isFinite(elapsed) ? elapsed : NaN;
      }

      function enableBrowserAudio(reason) {
        if (!sidecarUrl || sidecarAudioFallback) return;
        sidecarAudioFallback = true;
        video.muted = sidecarVolume <= 0;
        try { if (sidecar && typeof sidecar.setVolume === 'function') sidecar.setVolume(0); } catch (_) { }
        window.__mpvwasm_audio_fallback = { reason: reason || 'sidecar', at: Date.now() };
        call('status', 'sidecar audio fallback ' + (reason || 'sidecar'));
      }

      function sidecarOptions(start) {
        var target = Math.max(0, Number(start || 0));
        var options = ['vid=no'];
        if (target > 1) options.push('start=' + target.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
        return options.join(',');
      }

      function reloadSidecar(target) {
        if (!sidecar || typeof sidecar.loadUrl !== 'function' || !sidecarUrl) return false;
        var now = Date.now();
        if (sidecarReloading || now - sidecarReloadAt < 1500) return true;
        sidecarReloading = true;
        sidecarReady = false;
        sidecarPendingSeek = null;
        sidecarReloadAt = now;
        var done = function () {
          sidecarReady = true;
          sidecarReloading = false;
          sidecarStallReloads = 0;
          try { sidecar.setVolume(sidecarVolume); } catch (_) { }
          setSidecarPaused(!!video.paused);
        };
        try {
          var promise = sidecar.loadUrl(sidecarUrl, sidecarOptions(target));
          if (promise && typeof promise.then === 'function') promise.then(done, function (error) {
            sidecarReloading = false;
            sidecarReady = true;
            call('status', 'sidecar reload failed ' + (error && (error.message || error) || error));
          });
          else done();
          return true;
        } catch (error) {
          sidecarReloading = false;
          sidecarReady = true;
          call('status', 'sidecar reload failed ' + (error && (error.message || error) || error));
          return false;
        }
      }

      function recreateSidecar(target) {
        if (!sidecarUrl) return false;
        sidecarReloading = true;
        sidecarReloadAt = Date.now();
        sidecarReady = false;
        sidecarPendingSeek = null;
        try { if (sidecar && typeof sidecar.destroy === 'function') sidecar.destroy(); } catch (_) { }
        removeNode(sidecarCanvas);
        sidecar = null;
        sidecarCanvas = null;
        startSidecar(target);
        return true;
      }

      function seekSidecar(target) {
        sidecarPendingSeek = target;
        if (sidecarReady && sidecar && typeof sidecar.seek === 'function') {
          try {
            sidecar.seek(target);
            sidecarPendingSeek = null;
          } catch (_) { }
        }
      }

      function setSidecarPaused(value) {
        if (sidecarReady && sidecar && typeof sidecar.setPause === 'function') {
          try { sidecar.setPause(!!value); } catch (_) { }
        }
      }

      function seekNative(seconds) {
        var target = Math.max(0, Number(seconds || 0));
        var videoTarget = Math.max(0, target - 2);
        var resume = !video.paused;
        try {
          if (typeof video.fastSeek === 'function') video.fastSeek(videoTarget);
          else video.currentTime = videoTarget;
        } catch (_) { }

        sidecarSeeking = !!sidecarUrl;
        sidecarSeekTarget = videoTarget;
        sidecarSeekAt = Date.now();
        sidecarStallReloadAt = 0;
        sidecarStallReloads = 0;
        seekSidecar(videoTarget);
        setSidecarPaused(!resume);

        if (resume) {
          try { video.play().catch(function (error) { call('error', error); }); } catch (_) { }
        }
      }

      function syncSidecar(force) {
        if (sidecarUrl && sidecarReloading && Date.now() - sidecarReloadAt > 60000 && !video.paused) {
          enableBrowserAudio('sidecar-reload-timeout');
        }
        if (!sidecarReady || !sidecar || !sidecarUrl) return;
        try {
          var elapsed = sidecarElapsed();
          var current = Number(video.currentTime || 0);
          var delta = isFinite(elapsed) ? Math.abs(elapsed - current) : 0;
          var now = Date.now();
          if (isFinite(elapsed)) {
            sidecarClockMoving = isFinite(sidecarLastElapsed) && Math.abs(elapsed - sidecarLastElapsed) > 0.08;
            if (sidecarClockMoving || !sidecarLastWall) sidecarLastWall = now;
            sidecarLastElapsed = elapsed;
          }
          var sidecarStalled = isFinite(elapsed) && !sidecarClockMoving && sidecarLastWall && now - sidecarLastWall > 2500 && !video.paused && (sidecarSeeking || current > 3);

          if (sidecarSeeking) {
            var targetDelta = isFinite(elapsed) ? Math.abs(elapsed - sidecarSeekTarget) : 999;
            window.__mpvwasm_sidecar_sync = { state: 'seeking', target: sidecarSeekTarget, elapsed: elapsed, delta: targetDelta, stalled: sidecarStalled, at: now };

            if (sidecarStalled && now - sidecarSeekAt > 2500) {
              if (sidecarStallReloads < 3 && now - sidecarStallReloadAt > 3500) {
                sidecarStallReloadAt = now;
                sidecarStallReloads++;
                recreateSidecar(current);
                return;
              }
              enableBrowserAudio('sidecar-seek-stalled');
              sidecarSeeking = false;
            }

            if (targetDelta < 1.5 || now - sidecarSeekAt > 5000) {
              sidecarSeeking = false;
              if (!sidecarStalled && isFinite(elapsed) && elapsed > 0 && Math.abs(current - elapsed) > 2.5) {
                if (typeof video.fastSeek === 'function') video.fastSeek(elapsed);
                else video.currentTime = elapsed;
              }
            } else {
              return;
            }
          }

          if (force) {
            seekSidecar(current);
          } else if (!sidecarStalled && delta > 2.5 && isFinite(elapsed) && elapsed > 0) {
            if (typeof video.fastSeek === 'function') video.fastSeek(elapsed);
            else video.currentTime = elapsed;
          }
          if (sidecarStalled) {
            if (sidecarStallReloads < 3 && now - sidecarStallReloadAt > 3500) {
              sidecarStallReloadAt = now;
              sidecarStallReloads++;
              recreateSidecar(current);
              return;
            }
            enableBrowserAudio('sidecar-stalled');
          } else {
            sidecarStallReloads = 0;
            if (sidecarAudioFallback) {
              sidecarAudioFallback = false;
              video.muted = !!sidecarUrl || sidecarVolume <= 0;
              try { if (sidecar && typeof sidecar.setVolume === 'function') sidecar.setVolume(sidecarVolume); } catch (_) { }
              window.__mpvwasm_audio_fallback = null;
              call('status', 'sidecar audio recovered');
            }
          }
          window.__mpvwasm_sidecar_sync = { state: sidecarStalled ? 'sidecar-stalled' : 'synced', elapsed: elapsed, video: current, delta: delta, paused: !!video.paused, moving: sidecarClockMoving, at: now };
          setSidecarPaused(!!video.paused);
        } catch (_) { }
      }

      function startSidecar(startAt) {
        if (!sidecarUrl || !window.MpvWasmTest || !window.MpvWasmTest.createPlayer) return;
        sidecarCanvas = document.createElement('canvas');
        sidecarCanvas.width = 2;
        sidecarCanvas.height = 2;
        sidecarCanvas.style.cssText = 'position:fixed;left:-20px;top:-20px;width:2px;height:2px;opacity:0;pointer-events:none';
        ui.root.appendChild(sidecarCanvas);
        var initialStart = Math.max(0, Number(startAt || 0));
        var sideCallbacks = {
          status: function (message) {
            if (window.__MPV_WASM_SIDECAR_STATUS) call('status', 'sidecar ' + message);
          },
          error: function (error) {
            call('status', 'sidecar error ' + (error && (error.error || error.message || error) || error));
            if (!sidecarReady) enableBrowserAudio('sidecar-error');
          },
          audioTracks: function (tracks) {
            call('audioTracks', tracks || []);
          },
          subtitleTracks: function (tracks) {
            call('subtitleTracks', tracks || []);
          },
          duration: function () { },
          elapsed: function () { },
          isPlaying: function () { },
          fileStart: function () {
            sidecarReady = true;
            try { sidecar.setVolume(sidecarVolume); } catch (_) { }
            if (sidecarPendingSeek !== null) {
              seekSidecar(sidecarPendingSeek);
            } else if (!sidecarReloading) {
              syncSidecar(true);
            }
          },
          fileEnd: function () { }
        };
        window.MpvWasmTest.createPlayer(sidecarCanvas, null, sideCallbacks, {
          initialUrl: sidecarUrl,
          initialMpvOptions: sidecarOptions(initialStart)
        }).then(function (player) {
          sidecar = player;
          sidecarReady = true;
          sidecarReloading = false;
          try { sidecar.setVolume(sidecarVolume); } catch (_) { }
          syncSidecar(true);
          try {
            if (sidecar.module && typeof sidecar.module.getTracks === 'function') {
              setTimeout(function () { sidecar.module.getTracks(); }, 800);
            }
          } catch (_) { }
        }).catch(function (error) {
          call('status', 'sidecar failed ' + (error && (error.message || error) || error));
          video.muted = false;
        });
      }

      function publishTracks() {
        var audio = [];
        var subs = [];
        try {
          if (video.audioTracks) {
            for (var i = 0; i < video.audioTracks.length; i++) {
              var item = video.audioTracks[i];
              audio.push({ id: i, type: 'audio', title: item.label || item.language || ('Audio #' + (i + 1)), lang: item.language || '', selected: !!item.enabled });
            }
          }
        } catch (_) { }
        try {
          if (video.textTracks) {
            for (var j = 0; j < video.textTracks.length; j++) {
              var sub = video.textTracks[j];
              subs.push({ id: j, type: 'sub', title: sub.label || sub.language || ('Sub #' + (j + 1)), lang: sub.language || '', selected: sub.mode === 'showing' });
            }
          }
        } catch (_) { }
        if (sidecarUrl && !audio.length && !subs.length) return;
        call('audioTracks', audio);
        call('subtitleTracks', subs);
      }

      function tick() {
        call('duration', isFinite(video.duration) ? video.duration : 0);
        call('elapsed', video.currentTime || 0);
      }

      video.addEventListener('loadedmetadata', function () {
        call('duration', isFinite(video.duration) ? video.duration : 0);
        if (video.videoWidth && video.videoHeight) call('videoSize', { width: video.videoWidth, height: video.videoHeight });
        publishTracks();
      });
      video.addEventListener('loadeddata', function () {
        call('fileStart', { hardware: true });
      });
      video.addEventListener('playing', function () {
        call('isPlaying', true);
        call('fileStart', { hardware: true });
        syncSidecar(false);
      });
      video.addEventListener('pause', function () {
        call('isPlaying', false);
        syncSidecar(false);
      });
      video.addEventListener('seeked', function () {
        syncSidecar(false);
      });
      video.addEventListener('ended', function () { call('fileEnd', { hardware: true }); });
      video.addEventListener('error', function () {
        call('error', video.error ? (video.error.message || ('HTML5 video error ' + video.error.code)) : 'HTML5 video error');
      });
      video.addEventListener('timeupdate', tick);
      video.addEventListener('durationchange', tick);
      timer = setInterval(tick, 500);
      tracksTimer = setInterval(publishTracks, 1500);
      syncTimer = setInterval(function () { syncSidecar(false); }, 700);

      var player = {
        hardware: true,
        video: video,
        duration: 0,
        elapsed: 0,
        audioTracks: [],
        subtitleTracks: [],
        videoTracks: [],
        setPause: function (value) {
          if (value) video.pause();
          else video.play().catch(function (error) { call('error', error); });
          if (sidecarReady && sidecar && typeof sidecar.setPause === 'function') {
            try { sidecar.setPause(!!value); } catch (_) { }
          }
        },
        seek: function (seconds) {
          seekNative(seconds);
          tick();
        },
        seekRelative: function (seconds) {
          var target = Math.max(0, (video.currentTime || 0) + Number(seconds || 0));
          seekNative(target);
          tick();
        },
        setVolume: function (value) {
          var volume = Number(value || 0);
          if (!isFinite(volume)) volume = 1;
          if (volume > 1) volume = volume / 100;
          sidecarVolume = Math.max(0, Math.min(1, volume));
          video.volume = sidecarVolume;
          video.muted = (!!sidecarUrl && !sidecarAudioFallback) || sidecarVolume <= 0;
          if (sidecarReady && sidecar && typeof sidecar.setVolume === 'function') {
            try { sidecar.setVolume(sidecarAudioFallback ? 0 : sidecarVolume); } catch (_) { }
          }
        },
        setAudioTrack: function (id) {
          if (sidecar && typeof sidecar.setAudioTrack === 'function') {
            try { sidecar.setAudioTrack(id); return; } catch (_) { }
          }
          try {
            if (!video.audioTracks) return;
            for (var i = 0; i < video.audioTracks.length; i++) video.audioTracks[i].enabled = i === Number(id);
            publishTracks();
          } catch (_) { }
        },
        setSubtitleTrack: function (id) {
          if (sidecar && typeof sidecar.setSubtitleTrack === 'function') {
            try { sidecar.setSubtitleTrack(id); return; } catch (_) { }
          }
          try {
            if (!video.textTracks) return;
            for (var i = 0; i < video.textTracks.length; i++) video.textTracks[i].mode = i === Number(id) ? 'showing' : 'disabled';
            publishTracks();
          } catch (_) { }
        },
        destroy: function () {
          clearInterval(timer);
          clearInterval(tracksTimer);
          clearInterval(syncTimer);
          try { if (sidecar && typeof sidecar.destroy === 'function') sidecar.destroy(); } catch (_) { }
          try { video.pause(); } catch (_) { }
          try { video.removeAttribute('src'); video.load(); } catch (_) { }
          removeNode(sidecarCanvas);
          removeNode(video);
        },
        setOptions: function () { }
      };

      startSidecar();
      video.src = url;
      video.play().catch(function (error) { call('error', error); });
      resolve(player);
    });
  }

  function formatTime(value) {
    value = Math.max(0, Math.floor(Number(value || 0)));
    var h = Math.floor(value / 3600);
    var m = Math.floor((value % 3600) / 60);
    var s = value % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function openMpvPlayerLegacy(data) {
    openMpvPlayer(data);
  }

  /*
  function openMpvPlayerLegacyRemoved(data) {
    closeActive();
    lastError = '';
    window.__mpvwasm_last_error = '';

    var ui = createOverlay();
    var state = { audioTracks: [], subtitleTracks: [], duration: 0, elapsed: 0, paused: false };
    var time = document.createElement('div');
    time.className = 'mpvwasm-player__time';

    active = {
      root: ui.root,
      ui: ui,
      player: null,
      state: state,
      onKey: function (event) {
        if (!active) return;
        if (event.key === 'Escape' || event.key === 'Backspace') {
          event.preventDefault();
          closeActive();
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          if (active.player) active.player.seekRelative(-30);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          if (active.player) active.player.seekRelative(30);
        } else if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          state.paused = !state.paused;
          if (active.player) active.player.setPause(state.paused);
        }
      }
    };
    window.__mpvwasm_active = active;

    ui.bar.appendChild(button('×', 'Закрыть', closeActive));
    ui.bar.appendChild(button('−30', 'Назад 30 секунд', function () { if (active && active.player) active.player.seekRelative(-30); }));
    ui.bar.appendChild(button('⏯', 'Пауза/пуск', function () {
      state.paused = !state.paused;
      if (active && active.player) active.player.setPause(state.paused);
    }));
    ui.bar.appendChild(button('+30', 'Вперёд 30 секунд', function () { if (active && active.player) active.player.seekRelative(30); }));
    ui.bar.appendChild(button('Audio', 'Аудиодорожки', function () {
      openTrackSelect('Аудиодорожка', state.audioTracks, function (track) {
        if (active && active.player) active.player.setAudioTrack(track.id);
      });
    }));
    ui.bar.appendChild(button('Subs', 'Субтитры', function () {
      openTrackSelect('Субтитры', state.subtitleTracks, function (track) {
        if (active && active.player) active.player.setSubtitleTrack(track.id);
      });
    }));
    ui.bar.appendChild(time);
    document.addEventListener('keydown', active.onKey, true);

    function refreshTime() {
      time.textContent = formatTime(state.elapsed) + (state.duration ? ' / ' + formatTime(state.duration) : '');
    }

    try { Lampa.Loading.start(function () { }, 'MPV WASM...'); } catch (_) { }

    var callbacks = {
      status: function (message) {
        if (window.__MPV_WASM_UI_STATUS) ui.status.textContent = String(message || '');
      },
      error: function (error) {
        lastError = String(error && (error.error || error.message || error) || error || '');
        window.__mpvwasm_last_error = lastError;
        notify('MPV WASM: ' + (error && error.error || error && error.message || error));
      },
      duration: function (value) {
        state.duration = Number(value || 0);
        refreshTime();
      },
      elapsed: function (value) {
        state.elapsed = Number(value || 0);
        refreshTime();
      },
      isPlaying: function (value) {
        state.paused = !value;
      },
      audioTracks: function (tracks) {
        state.audioTracks = tracks || [];
        publishTracks(state.audioTracks, state.subtitleTracks);
      },
      subtitleTracks: function (tracks) {
        state.subtitleTracks = tracks || [];
        publishTracks(state.audioTracks, state.subtitleTracks);
      },
      fileStart: function () {
        try { Lampa.Loading.stop(); } catch (_) { }
      },
      fileEnd: function () {
        closeActive();
      }
    }, {
      initialUrl: playUrl
    }).then(function (player) {
      if (!active) {
        return;
      }
      active.player = player;
      ui.status.textContent = '';
    }).catch(function (error) {
      try { Lampa.Loading.stop(); } catch (_) { }
      lastError = String(error && (error.stack || error.message || error) || error || '');
      window.__mpvwasm_last_error = lastError;
      notify('MPV WASM error: ' + (error && (error.message || error) || error));
      closeActive();
    });
  }

  */

  function openMpvPlayer(data) {
    closeActive();
    lastError = '';
    window.__mpvwasm_last_error = '';

    var backendDecision = data && data.__mpvwasmBackendDecision || selectBackend(data);
    var useHybridWebCodecs = backendDecision.selected === 'hybrid-webcodecs';
    var hardwareVideo = !useHybridWebCodecs && shouldUseHardwareVideo(data);
    var playUrl = hardwareVideo ? directUrl(data.url) : proxyUrl(data.url);
    var playOptions = hardwareVideo ? '' : mpvOptionsFor(data);
    var reuseSameUrl = !!(pooledPlayer && pooledUrl === playUrl);
    if (useHybridWebCodecs && reuseSameUrl && pooledPlayer && !pooledPlayer.hybridWebCodecs) {
      discardPooledPlayer();
      reuseSameUrl = false;
    }
    if (pooledPlayer && !reuseSameUrl) discardPooledPlayer();
    var reuseCanvas = reuseSameUrl ? pooledCanvas : null;
    var reusePlayer = reuseSameUrl ? pooledPlayer : null;
    pooledCanvas = null;
    pooledPlayer = null;
    pooledReady = null;
    pooledUrl = '';
    var ui = createOverlay(reuseCanvas);
    clearPooledShell();
    var rewindStep = Number(storageField('player_rewind', 10) || 10);
    if (!isFinite(rewindStep) || rewindStep < 5) rewindStep = 10;

    var state = {
      audioTracks: [],
      subtitleTracks: [],
      duration: 0,
      elapsed: 0,
      paused: false,
      panelVisible: false,
      loading: true,
      lastController: '',
      lastFocus: null,
      lastPanelFocus: null,
      hideTimer: 0,
      cursorTimer: 0,
      clickTimer: 0,
      clickCount: 0,
      timeline: resolveTimeline(data),
      heavyVideo: hardwareVideo,
      hardwareVideo: hardwareVideo,
      hybridWebCodecs: useHybridWebCodecs,
      backendDecision: backendDecision,
      timelineContinued: false,
      fileStarted: false,
      pendingSeek: null,
      timelineLastSave: 0,
      resizeTimer: 0
    };

    try {
      if (Lampa.Controller && Lampa.Controller.enabled) state.lastController = Lampa.Controller.enabled().name || '';
    } catch (_) { }

    active = {
      root: ui.root,
      ui: ui,
      player: null,
      playUrl: playUrl,
      state: state,
      onClose: function () {
        clearTimeout(state.hideTimer);
        clearTimeout(state.cursorTimer);
        clearTimeout(state.clickTimer);
        clearTimeout(state.resizeTimer);
        saveTimeline(true);
        window.removeEventListener('resize', resizeCanvas, true);
        document.removeEventListener('fullscreenchange', resizeCanvas, true);
        try { if (Lampa.PlayerInfo) Lampa.PlayerInfo.destroy(); } catch (_) { }
        try {
          if (state.lastController && Lampa.Controller && Lampa.Controller.enabled && /^mpvwasm_/.test(Lampa.Controller.enabled().name || '')) {
            Lampa.Controller.toggle(state.lastController);
          }
        } catch (_) { }
      },
      onKey: function (event) {
        if (!active) return;
        if (event.key === 'Escape' || event.key === 'Backspace') {
          event.preventDefault();
          closeActive();
        } else if (isMpvController() && handleControllerKey(event)) {
          return;
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          seekRelative(-rewindStep);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          seekRelative(rewindStep);
        } else if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          playPause();
        }
      }
    };
    window.__mpvwasm_active = active;

    function q(selector) {
      return ui.root.querySelector(selector);
    }

    function qa(selector) {
      return Array.prototype.slice.call(ui.root.querySelectorAll(selector));
    }

    function setHidden(selector, hidden) {
      qa(selector).forEach(function (node) { node.classList.toggle('hide', !!hidden); });
    }

    function controllerName() {
      try {
        return Lampa.Controller && Lampa.Controller.enabled ? (Lampa.Controller.enabled().name || '') : '';
      } catch (_) {
        return '';
      }
    }

    function isMpvController() {
      return /^mpvwasm_/.test(controllerName());
    }

    function controllerScope() {
      return ui.panel || ui.root;
    }

    function focusControllerNode(node) {
      try {
        if (Lampa.Controller && Lampa.Controller.collectionFocus) {
          Lampa.Controller.collectionFocus(node || false, controllerScope());
          return;
        }
      } catch (_) { }

      if (node) {
        qa('.selector').forEach(function (item) { item.classList.remove('focus'); });
        node.classList.add('focus');
        triggerNode(node, 'hover:focus');
      }
    }

    function setControllerCollection(node) {
      try {
        if (Lampa.Controller && Lampa.Controller.collectionSet) Lampa.Controller.collectionSet(controllerScope());
      } catch (_) { }
      focusControllerNode(node || false);
    }

    function moveFocus(direction) {
      try {
        if (window.Navigator && Navigator.move) {
          Navigator.move(direction);
          return;
        }
      } catch (_) { }
    }

    function markControllerNodes() {
      if (ui.timeline) ui.timeline.setAttribute('data-controller', 'mpvwasm_rewind');

      qa('.player-panel .selector').forEach(function (node) {
        if (node !== ui.timeline) node.setAttribute('data-controller', 'mpvwasm_panel');
      });

      qa('.selector').forEach(function (node) {
        var saveFocus = function () {
          state.lastFocus = node;
          if (node !== ui.timeline) state.lastPanelFocus = node;
        };
        node.addEventListener('hover:focus', saveFocus);
        try { if (window.$) $(node).on('hover:focus', saveFocus); } catch (_) { }
      });
    }

    function handleControllerKey(event) {
      var name = controllerName();
      var key = event.key;
      var handled = false;

      if (name === 'mpvwasm_rewind') {
        if (key === 'ArrowLeft') {
          seekRelative(-rewindStep);
          handled = true;
        } else if (key === 'ArrowRight') {
          seekRelative(rewindStep);
          handled = true;
        } else if (key === 'ArrowDown') {
          showPanel();
          try { Lampa.Controller.toggle('mpvwasm_panel'); } catch (_) { }
          handled = true;
        } else if (key === 'ArrowUp') {
          hidePanel();
          try { Lampa.Controller.toggle('mpvwasm_player'); } catch (_) { }
          handled = true;
        } else if (key === 'Enter' || key === ' ') {
          playPause();
          handled = true;
        }
      } else if (name === 'mpvwasm_panel') {
        if (key === 'ArrowLeft') {
          moveFocus('left');
          handled = true;
        } else if (key === 'ArrowRight') {
          moveFocus('right');
          handled = true;
        } else if (key === 'ArrowUp') {
          showPanel();
          try { Lampa.Controller.toggle('mpvwasm_rewind'); } catch (_) { }
          handled = true;
        } else if (key === 'ArrowDown') {
          showPanel();
          handled = true;
        } else if (key === 'Enter') {
          if (state.lastFocus) triggerNode(state.lastFocus, 'hover:enter');
          else playPause();
          handled = true;
        } else if (key === ' ') {
          playPause();
          handled = true;
        }
      } else if (name === 'mpvwasm_player') {
        if (key === 'ArrowLeft') {
          seekRelative(-rewindStep);
          handled = true;
        } else if (key === 'ArrowRight') {
          seekRelative(rewindStep);
          handled = true;
        } else if (key === 'ArrowDown' || key === 'ArrowUp') {
          showPanel();
          try { Lampa.Controller.toggle(key === 'ArrowDown' ? 'mpvwasm_panel' : 'mpvwasm_rewind'); } catch (_) { }
          handled = true;
        } else if (key === 'Enter' || key === ' ') {
          playPause();
          handled = true;
        }
      }

      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }

      return handled;
    }

    function bind(selector, handler) {
      qa(selector).forEach(function (node) {
        var run = function (event) {
          if (event) {
            event.preventDefault();
            event.stopPropagation();
          }
          handler(event);
          showPanel();
        };
        node.addEventListener('click', run);
        node.addEventListener('hover:enter', run);
        try { if (window.$) $(node).on('hover:enter', run); } catch (_) { }
      });
    }

    function percentFromEvent(event) {
      if (!ui.timeline) return 0;
      var rect = ui.timeline.getBoundingClientRect();
      return Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    }

    function setBarWidth(node, percent) {
      if (!node) return;
      var width = percent + '%';
      node.style.width = width;
      node.style.minWidth = percent > 0 ? '6px' : '0';
      if (node.firstElementChild) node.firstElementChild.style.width = width;
    }

    function updateTimeline() {
      var duration = Math.max(0, Number(state.duration || 0));
      var elapsed = Math.max(0, Number(state.elapsed || 0));
      var percent = duration ? Math.max(0, Math.min(100, elapsed / duration * 100)) : 0;
      if (ui.timeNow) ui.timeNow.textContent = formatTime(elapsed);
      if (ui.timeEnd) ui.timeEnd.textContent = duration ? formatTime(duration) : '00:00';
      setBarWidth(ui.position, percent);
      setBarWidth(ui.peding, 0);
      updateDebugOverlay();
    }

    function updateDebugOverlay() {
      if (!ui.debug || !debugOverlayEnabled()) return;
      var decision = state.backendDecision || {};
      var probe = decision.probe || {};
      var sync = window.__mpvwasm_sidecar_sync || {};
      var fallback = window.__mpvwasm_audio_fallback || null;
      var hybrid = window.__mpvwasm_hybrid_debug || {};
      var drift = sync.delta !== undefined ? Math.round(Number(sync.delta || 0) * 1000) : 0;
      ui.debug.textContent = [
        'backend: ' + (decision.selected || 'unknown'),
        'candidate: ' + (decision.candidate || '-'),
        'reason: ' + (decision.reason || '-'),
        'container: ' + (probe.container || '-'),
        'video: ' + (probe.videoCodec || '-') + ' webcodecs=' + (!!probe.hasWebCodecs),
        'audio: ' + (probe.audioCodec || '-') + ' audiodecoder=' + (!!probe.hasAudioDecoder),
        'demux-only: ' + (!!probe.hasDemuxOnly),
        'size: ' + ((active && active.player && active.player.video && active.player.video.videoWidth) || '-') + 'x' + ((active && active.player && active.player.video && active.player.video.videoHeight) || '-'),
        'time: ' + formatTime(state.elapsed) + ' / ' + formatTime(state.duration),
        'tracks/subs: ' + state.audioTracks.length + '/' + state.subtitleTracks.length,
        'hybrid: ' + (hybrid.codec || '-') + ' q=' + (hybrid.videoQueue || 0) + ' aq=' + Math.round(Number(hybrid.audioBufferUs || 0) / 1000) + 'ms drop=' + (hybrid.droppedFrames || 0),
        'av drift: ' + (hybrid.driftMs !== undefined ? hybrid.driftMs : '-') + 'ms',
        'sidecar: ' + (sync.state || '-') + ' drift_ms=' + drift,
        'audio fallback: ' + (fallback ? fallback.reason : '-'),
        'error: ' + (lastError || '-')
      ].join('\n');
    }

    function saveTimeline(force) {
      if (!state.timeline || !state.timeline.handler || !state.duration) return;
      var now = Date.now();
      if (!force && now - state.timelineLastSave < 15000) return;
      state.timelineLastSave = now;
      state.timeline.percent = Math.round(state.elapsed / state.duration * 100);
      state.timeline.time = state.elapsed;
      state.timeline.duration = state.duration;
      try { state.timeline.handler(state.timeline.percent, state.timeline.time, state.timeline.duration); } catch (_) { }
    }

    function resumeTimeline() {
      if (!state.fileStarted || !state.timeline || state.timelineContinued || !state.duration || !active || !active.player) return;
      state.timelineContinued = true;
      if (String(storageField('player_timecode', 'continue') || '') === 'again') return;
      var exact = parseFloat(state.timeline.time + '');
      var percent = parseFloat(state.timeline.percent + '');
      var pos = !isNaN(exact) && exact > 0 ? exact : (!isNaN(percent) ? Math.round(state.duration * percent / 100) : 0);
      if (pos > 10 && pos < state.duration - 15 && (!percent || percent < 90)) seekTo(pos, true);
    }

    function resizeCanvas() {
      var rect = ui.root.getBoundingClientRect();
      var dpr = state.heavyVideo ? 1 : Math.max(1, Math.min(1.5, window.devicePixelRatio || 1));
      var width = Math.max(320, Math.round((rect.width || window.innerWidth || 1280) * dpr));
      var height = Math.max(180, Math.round((rect.height || window.innerHeight || 720) * dpr));
      try {
        if (ui.canvas.width !== width) ui.canvas.width = width;
        if (ui.canvas.height !== height) ui.canvas.height = height;
      } catch (error) {
        window.__mpvwasm_resize_error = String(error && (error.message || error) || error);
      }
      if (active && active.player && active.player.module && typeof active.player.module.matchWindowScreenSize === 'function') {
        clearTimeout(state.resizeTimer);
        state.resizeTimer = setTimeout(function () {
          try { active.player.module.matchWindowScreenSize(); } catch (_) { }
        }, 150);
      }
    }

    function setLoading(status) {
      state.loading = !!status;
      ui.video.classList.toggle('video--load', state.loading);
    }

    function showPanel() {
      clearTimeout(state.hideTimer);
      state.panelVisible = true;
      ui.panel.classList.add('panel--visible');
      ui.root.classList.add('player--panel-visible');
      try { if (Lampa.PlayerInfo && Lampa.PlayerInfo.toggle) Lampa.PlayerInfo.toggle(true); } catch (_) { }
      updateTimeline();
      if (!state.paused) state.hideTimer = setTimeout(hidePanel, 3000);
    }

    function hidePanel() {
      state.panelVisible = false;
      ui.panel.classList.remove('panel--visible');
      ui.root.classList.remove('player--panel-visible');
      try { if (Lampa.PlayerInfo && Lampa.PlayerInfo.toggle) Lampa.PlayerInfo.toggle(false); } catch (_) { }
    }

    function setPaused(paused, send) {
      state.paused = !!paused;
      ui.panel.classList.toggle('panel--paused', state.paused);
      if (ui.paused) ui.paused.classList.toggle('hide', !state.paused);
      if (send && active && active.player) active.player.setPause(state.paused);
      showPanel();
    }

    function playPause() {
      setPaused(!state.paused, true);
    }

    function flashRewind(seconds) {
      var node = seconds >= 0 ? ui.rewindForward : ui.rewindBack;
      if (!node) return;
      var span = node.querySelector('span');
      if (span) span.textContent = (seconds > 0 ? '+' : '') + Math.round(seconds) + ' sec';
      node.classList.remove('rewind');
      void node.offsetWidth;
      node.classList.add('rewind');
      setTimeout(function () { node.classList.remove('rewind'); }, 750);
    }

    function seekTo(seconds, silent) {
      var target = Number(seconds || 0);
      if (state.duration) target = Math.max(0, Math.min(target, state.duration));
      state.elapsed = target;
      updateTimeline();
      if (active && active.player && state.fileStarted) active.player.seek(target);
      else state.pendingSeek = target;
      if (!silent) saveTimeline(true);
      showPanel();
    }

    function seekRelative(seconds) {
      var value = Number(seconds || 0);
      state.elapsed = Math.max(0, state.duration ? Math.min(state.duration, state.elapsed + value) : state.elapsed + value);
      updateTimeline();
      flashRewind(value);
      if (active && active.player) active.player.seekRelative(value);
      saveTimeline(true);
      showPanel();
    }

    function toggleFullscreen() {
      try {
        if (Lampa.Utils && Lampa.Utils.toggleFullscreen) Lampa.Utils.toggleFullscreen();
        else if (!document.fullscreenElement && ui.root.requestFullscreen) ui.root.requestFullscreen();
        else if (document.exitFullscreen) document.exitFullscreen();
      } catch (_) { }
      setTimeout(resizeCanvas, 250);
    }

    function syncTrackButtons() {
      setHidden('.player-panel__tracks', state.audioTracks.length < 2);
      setHidden('.player-panel__subs', state.subtitleTracks.length < 1);
    }

    function chooseAudio() {
      openTrackSelect(lang('player_tracks', 'Audio tracks'), state.audioTracks, function (track) {
        state.audioTracks.forEach(function (item) { item.selected = item.id === track.id; });
        if (active && active.player) active.player.setAudioTrack(track.id);
      });
    }

    function chooseSubs() {
      var off = { id: -1, title: lang('player_disabled', 'Disabled'), selected: !state.subtitleTracks.some(function (item) { return item.selected; }) };
      openTrackSelect(lang('player_subs', 'Subtitles'), [off].concat(state.subtitleTracks), function (track) {
        state.subtitleTracks.forEach(function (item) { item.selected = item.id === track.id; });
        if (active && active.player) active.player.setSubtitleTrack(track.id);
      });
    }

    function selectSize() {
      var selected = String(storageField('player_size', 'default') || 'default');
      Lampa.Select.show({
        title: lang('player_video_size', 'Video size'),
        items: [
          { title: lang('player_size_default_title', 'Default'), value: 'default', selected: selected === 'default' },
          { title: lang('player_size_cover_title', 'Cover'), value: 'cover', selected: selected === 'cover' },
          { title: lang('player_size_fill_title', 'Fill'), value: 'fill', selected: selected === 'fill' }
        ],
        onSelect: function (item) {
          try { Lampa.Storage.set('player_size', item.value); } catch (_) { }
          ui.canvas.style.objectFit = item.value === 'default' ? 'contain' : 'cover';
        },
        onBack: openSettings
      });
    }

    function openSettings() {
      Lampa.Select.show({
        title: lang('title_settings', 'Settings'),
        items: [
          { title: lang('player_tracks', 'Audio tracks'), trigger: chooseAudio, ghost: state.audioTracks.length < 2, noenter: state.audioTracks.length < 2 },
          { title: lang('player_subs', 'Subtitles'), trigger: chooseSubs, ghost: state.subtitleTracks.length < 1, noenter: state.subtitleTracks.length < 1 },
          { title: lang('player_video_size', 'Video size'), trigger: selectSize },
          { title: lang('player_fullscreen', 'Fullscreen'), trigger: toggleFullscreen }
        ],
        onSelect: function (item) {
          if (item && item.trigger) item.trigger();
        },
        onBack: function () {
          try { if (Lampa.Controller) Lampa.Controller.toggle('mpvwasm_panel'); } catch (_) { }
        }
      });
    }

    function installController() {
      if (!Lampa.Controller || !Lampa.Controller.add) return;
      Lampa.Controller.add('mpvwasm_player', {
        invisible: true,
        hover: showPanel,
        toggle: function () {
          hidePanel();
        },
        up: function () {
          showPanel();
          try { Lampa.Controller.toggle('mpvwasm_rewind'); } catch (_) { }
        },
        down: function () {
          showPanel();
          try { Lampa.Controller.toggle('mpvwasm_panel'); } catch (_) { }
        },
        left: function () { seekRelative(-rewindStep); },
        right: function () { seekRelative(rewindStep); },
        enter: playPause,
        playpause: playPause,
        play: function () { setPaused(false, true); },
        pause: function () { setPaused(true, true); },
        stop: closeActive,
        back: closeActive
      });
      Lampa.Controller.add('mpvwasm_rewind', {
        toggle: function () {
          showPanel();
          setControllerCollection(ui.timeline || state.lastFocus || false);
        },
        up: function () {
          hidePanel();
          try { Lampa.Controller.toggle('mpvwasm_player'); } catch (_) { }
        },
        down: function () {
          showPanel();
          try { Lampa.Controller.toggle('mpvwasm_panel'); } catch (_) { }
        },
        left: function () { seekRelative(-rewindStep); },
        right: function () { seekRelative(rewindStep); },
        enter: playPause,
        playpause: playPause,
        play: function () { setPaused(false, true); },
        pause: function () { setPaused(true, true); },
        stop: closeActive,
        gone: function () { qa('.selector').forEach(function (node) { node.classList.remove('focus'); }); },
        back: closeActive
      });
      Lampa.Controller.add('mpvwasm_panel', {
        toggle: function () {
          showPanel();
          setControllerCollection(state.lastPanelFocus || q('.player-panel__playpause') || state.lastFocus || false);
        },
        up: function () {
          showPanel();
          try { Lampa.Controller.toggle('mpvwasm_rewind'); } catch (_) { }
        },
        down: showPanel,
        left: function () { moveFocus('left'); },
        right: function () { moveFocus('right'); },
        enter: function () {
          if (state.lastFocus) triggerNode(state.lastFocus, 'hover:enter');
          else playPause();
        },
        playpause: playPause,
        play: function () { setPaused(false, true); },
        pause: function () { setPaused(true, true); },
        stop: closeActive,
        gone: function () { qa('.selector').forEach(function (node) { node.classList.remove('focus'); }); },
        back: closeActive
      });
      try { Lampa.Controller.toggle('mpvwasm_rewind'); } catch (_) { }
    }

    function clickVideo(event) {
      if (event.target.closest && event.target.closest('.player-panel')) return;
      clearTimeout(state.clickTimer);
      state.clickCount++;
      if (state.clickCount === 1) {
        state.clickTimer = setTimeout(function () {
          state.clickCount = 0;
          if (state.panelVisible) playPause();
          else showPanel();
        }, 300);
        return;
      }
      state.clickTimer = setTimeout(function () {
        var third = window.innerWidth / 3;
        var seconds = (state.clickCount - 1) * 10;
        if (event.clientX > third * 2) seekRelative(seconds);
        else if (event.clientX < third) seekRelative(-seconds);
        else toggleFullscreen();
        state.clickCount = 0;
      }, 300);
    }

    markControllerNodes();
    setHidden('.player-panel__prev,.player-panel__next,.player-panel__playlist,.player-panel__flow,.player-panel__pip', true);
    var quality = q('.player-panel__quality');
    if (quality) quality.textContent = state.hybridWebCodecs ? 'mpv webcodecs' : (state.hardwareVideo ? 'mpv hw' : 'mpv');

    bind('.player-panel__playpause', playPause);
    bind('.player-panel__rprev', function () { seekRelative(-rewindStep); });
    bind('.player-panel__rnext', function () { seekRelative(rewindStep); });
    bind('.player-panel__tstart', function () { seekTo(0); });
    bind('.player-panel__tend', function () { seekTo(state.duration ? Math.max(0, state.duration - 3) : 0); });
    bind('.player-panel__fullscreen', toggleFullscreen);
    bind('.player-panel__tracks', chooseAudio);
    bind('.player-panel__subs', chooseSubs);
    bind('.player-panel__settings,.player-panel__quality', openSettings);
    bind('.head-backward', closeActive);

    if (ui.volume) {
      function applyVolume() {
        try { Lampa.Storage.set('player_volume', ui.volume.value); } catch (_) { }
        if (active && active.player) active.player.setVolume(ui.volume.value);
      }
      try { ui.volume.value = Lampa.Storage.get('player_volume', '1'); } catch (_) { }
      ui.volume.addEventListener('input', applyVolume);
      ui.volume.addEventListener('change', applyVolume);
    }

    if (ui.timeline) {
      ui.timeline.addEventListener('mousemove', function (event) {
        var percent = percentFromEvent(event);
        if (ui.timeFloat) {
          ui.timeFloat.textContent = formatTime(percent * (state.duration || 0));
          ui.timeFloat.style.left = (percent * 100) + '%';
          ui.timeFloat.classList.remove('hide');
        }
      });
      ui.timeline.addEventListener('mouseout', function () {
        if (ui.timeFloat) ui.timeFloat.classList.add('hide');
      });
      ui.timeline.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        seekTo(percentFromEvent(event) * (state.duration || 0));
      });
    }

    ui.video.addEventListener('click', clickVideo);
    ui.root.addEventListener('mousemove', function () {
      ui.root.style.cursor = 'default';
      showPanel();
      clearTimeout(state.cursorTimer);
      state.cursorTimer = setTimeout(function () {
        if (!state.panelVisible) ui.root.style.cursor = 'none';
      }, 3000);
    });
    ui.root.addEventListener('animationend', function (event) {
      if (event.target && event.target.classList) event.target.classList.remove('rewind');
    });
    document.addEventListener('keydown', active.onKey, true);
    window.addEventListener('resize', resizeCanvas, true);
    document.addEventListener('fullscreenchange', resizeCanvas, true);
    installController();
    resizeCanvas();
    setLoading(true);
    updateTimeline();
    showPanel();

    try { Lampa.Loading.start(function () { }, 'MPV WASM...'); } catch (_) { }
    try {
      if (Lampa.PlayerInfo) {
        if (Lampa.PlayerInfo.loading) Lampa.PlayerInfo.loading();
        if (Lampa.PlayerInfo.set) {
          Lampa.PlayerInfo.set('name', data.title || data.name || 'MPV');
          // Lampa.PlayerInfo stat calls the globally configured TorrServer /cache endpoint.
          // On HTTPS setups with legacy http/ip TorrServer settings it blocks the MPV player
          // with repeated mixed-content/SSL failures, while playback itself works via data.url.
        }
      }
    } catch (_) { }

    var hardwareVideo = state.hardwareVideo;
    var playUrl = hardwareVideo ? directUrl(data.url) : proxyUrl(data.url);
    var playOptions = hardwareVideo ? '' : mpvOptionsFor(data);
    var sidecarUrl = hardwareVideo ? proxyUrl(data.url) : '';
    var callbacks = {
      status: function (message) {
        if (window.__MPV_WASM_UI_STATUS) ui.status.textContent = String(message || '');
      },
      error: function (error) {
        lastError = String(error && (error.error || error.message || error) || error || '');
        window.__mpvwasm_last_error = lastError;
        try { if (Lampa.PlayerInfo && Lampa.PlayerInfo.set) Lampa.PlayerInfo.set('error', lastError); } catch (_) { }
        notify('MPV WASM: ' + (error && error.error || error && error.message || error));
      },
      duration: function (value) {
        state.duration = Number(value || 0);
        updateTimeline();
        if (state.fileStarted) resumeTimeline();
      },
      elapsed: function (value) {
        state.elapsed = Number(value || 0);
        updateTimeline();
        if (state.fileStarted) resumeTimeline();
        saveTimeline(false);
      },
      isPlaying: function (value) {
        setPaused(!value, false);
      },
      audioTracks: function (tracks) {
        state.audioTracks = tracks || [];
        syncTrackButtons();
      },
      subtitleTracks: function (tracks) {
        state.subtitleTracks = tracks || [];
        syncTrackButtons();
      },
      videoSize: function (value) {
        var width = Number(value && (value.width || value.w) || 0);
        var height = Number(value && (value.height || value.h) || 0);
        try { if (Lampa.PlayerInfo && Lampa.PlayerInfo.set && width && height) Lampa.PlayerInfo.set('size', { width: width, height: height }); } catch (_) { }
      },
      fileStart: function () {
        try { Lampa.Loading.stop(); } catch (_) { }
        state.fileStarted = true;
        setLoading(false);
        if (state.pendingSeek !== null) {
          var target = state.pendingSeek;
          state.pendingSeek = null;
          seekTo(target, true);
        } else {
          resumeTimeline();
        }
        showPanel();
      },
      fileEnd: function () {
        closeActive();
      }
    };

    function createFreshPlayer() {
      return window.MpvWasmTest.createPlayer(ui.canvas, null, callbacks, {
        initialUrl: playUrl,
        initialMpvOptions: playOptions
      });
    }

    function loadWithPlayer(player) {
      if (!player) return createFreshPlayer();
      try { if (player.setOptions) player.setOptions(callbacks); else player.options = callbacks; } catch (_) { }
      if (active) active.player = player;
      return player.loadUrl(playUrl, playOptions).then(function () { return player; });
    }

    function resumeWithPlayer(player) {
      try { if (player.setOptions) player.setOptions(callbacks); else player.options = callbacks; } catch (_) { }
      if (active) active.player = player;
      try { callbacks.fileStart({ cached: true }); } catch (_) { }
      try { callbacks.duration(player.duration || 0); } catch (_) { }
      try { callbacks.elapsed(player.elapsed || 0); } catch (_) { }
      try { callbacks.audioTracks(player.audioTracks || []); } catch (_) { }
      try { callbacks.subtitleTracks(player.subtitleTracks || []); } catch (_) { }
      try {
        var video = player.videoTracks && player.videoTracks[0];
        if (video) callbacks.videoSize({ width: video.width || video.w || video.demuxW || video.codecW, height: video.height || video.h || video.demuxH || video.codecH });
      } catch (_) { }
      return Promise.resolve(player);
    }

    function createHybridPlayer() {
      var strictHybrid = state.backendDecision && state.backendDecision.requested === 'mpv2';
      if (!window.HybridWebCodecsBackend || typeof window.HybridWebCodecsBackend.open !== 'function') {
        if (strictHybrid) {
          state.backendDecision.selected = 'hybrid-webcodecs';
          state.backendDecision.reason = 'hybrid-backend-not-loaded';
          return Promise.reject(new Error('MPV2 hybrid backend not loaded'));
        }
        state.backendDecision.selected = 'mpv-wasm-fallback';
        state.backendDecision.reason = 'hybrid-backend-not-loaded';
        return createFreshPlayer();
      }
      return window.HybridWebCodecsBackend.open(ui.canvas, proxyUrl(data.url), callbacks, {
        data: data,
        debug: debugOverlayEnabled()
      }).catch(function (error) {
        if (strictHybrid) {
          state.backendDecision.selected = 'hybrid-webcodecs';
          state.backendDecision.reason = 'hybrid-open-failed';
          lastError = String(error && (error.message || error) || error || '');
          throw error;
        }
        state.backendDecision.selected = 'mpv-wasm-fallback';
        state.backendDecision.reason = 'hybrid-open-failed';
        lastError = String(error && (error.message || error) || error || '');
        callbacks.status('hybrid fallback ' + lastError);
        return createFreshPlayer();
      });
    }

    var playerReady = state.hybridWebCodecs ? (reusePlayer && reusePlayer.hybridWebCodecs ? resumeWithPlayer(reusePlayer) : createHybridPlayer()) : (state.hardwareVideo ? createHardwareVideoPlayer(ui, playUrl, callbacks, sidecarUrl) : (reusePlayer ? resumeWithPlayer(reusePlayer) : createFreshPlayer()));

    playerReady.then(function (player) {
      if (!active || active.ui !== ui) {
        cachePlayer(player, ui.canvas);
        return;
      }
      active.player = player;
      if (ui.volume) {
        try { player.setVolume(ui.volume.value); } catch (_) { }
      }
      if (reusePlayer) {
        try { player.setPause(false); } catch (_) { }
        setPaused(false, false);
      }
      resizeCanvas();
      if (state.fileStarted) resumeTimeline();
      try { if (player.module && typeof player.module.getTracks === 'function') setTimeout(function () { player.module.getTracks(); }, 800); } catch (_) { }
      ui.status.textContent = '';
    }).catch(function (error) {
      try { Lampa.Loading.stop(); } catch (_) { }
      lastError = String(error && (error.stack || error.message || error) || error || '');
      window.__mpvwasm_last_error = lastError;
      notify('MPV WASM error: ' + (error && (error.message || error) || error));
      closeActive();
    });
  }

  function install() {
    addSettings();
    window.MpvWasmLampa = {
      version: VERSION,
      open: openMpvPlayer,
      close: closeActive,
      activeInfo: function () {
        return {
          active: !!active,
          hasPlayer: !!(active && active.player),
          tracks: active && active.state ? active.state.audioTracks.length : 0,
          subs: active && active.state ? active.state.subtitleTracks.length : 0,
          duration: active && active.state ? active.state.duration : 0,
          elapsed: active && active.state ? active.state.elapsed : 0,
          paused: active && active.state ? active.state.paused : false,
          timelineHash: active && active.state && active.state.timeline ? active.state.timeline.hash : '',
          canvas: active && active.root ? (function () {
            var c = active.root.querySelector('canvas');
            return c ? { width: c.width, height: c.height } : null;
          })() : null,
          pooled: !!pooledPlayer,
          prewarming: !!pooledReady,
          ignoreDestroy: ignorePlayerDestroyUntil > Date.now(),
          backend: active && active.state ? active.state.backendDecision : null,
          activeBackend: active && active.player ? (active.player.hybridWebCodecs ? 'hybrid-webcodecs' : (active.player.hardware ? 'html5-sidecar' : 'mpv-wasm-fallback')) : '',
          state: active && active.state ? active.state : null,
          player: active && active.player ? active.player : null,
          lastError: lastError || window.__mpvwasm_last_error || ''
        };
      },
      normalizeUrl: normalizeUrl,
      directUrl: directUrl,
      proxyUrl: proxyUrl,
      buildMediaProbe: buildMediaProbe,
      selectBackend: selectBackend,
      canDecodeVideoWithWebCodecs: canDecodeVideoWithWebCodecs,
      prewarm: prewarmMpvPlayer
    };
    if (window.__mpvwasm_player_hooked) return;
    window.__mpvwasm_player_hooked = true;

    Lampa.Player.listener.follow('create', function (event) {
      if (!event || !event.data || !shouldUseMpvWasm(event.data)) return;
      var backendDecision = selectBackend(event.data);
      window.__mpvwasm_backend_decision = backendDecision;
      if (backendDecision.selected === 'html5') return;
      event.data.__mpvwasmBackendDecision = backendDecision;
      if (event.abort) event.abort();
      if (event.preventDefault) event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
      event.cancel = true;
      ignorePlayerDestroyUntil = Date.now() + 30000;
      try { Lampa.Player.close(); } catch (_) { }
      openMpvPlayer(event.data);
    });

    Lampa.Player.listener.follow('destroy', function () {
      if (ignorePlayerDestroyUntil > Date.now()) return;
      closeActive();
    });

    schedulePrewarm();
  }

  waitLampa(install);
})();
