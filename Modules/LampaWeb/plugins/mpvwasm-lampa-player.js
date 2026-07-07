(function () {
  'use strict';

  if (window.MpvWasmTest || window.__mpvwasm_core_loading) return;
  window.__mpvwasm_core_loading = true;

  var script = document.createElement('script');
  script.type = 'text/javascript';
  script.src = '/mpvwasm/player.js?v=core-20260707-34-hw4k';
  script.onload = function () { window.__mpvwasm_core_loading = false; };
  script.onerror = function () { window.__mpvwasm_core_loading = false; };
  document.head.appendChild(script);
})();

(function () {
  'use strict';

  var VERSION = '20260707-34-hw4k';
  var TORRSERVER_URL = 'https://newgenres.duckdns.org/TS';
  var OLD_TORRSERVER_RE = /^http:\/\/213\.171\.26\.189:2367(?=\/|$)/i;
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
    return String(storageField('mpvwasm_player_mode', 'default') || '').toLowerCase() === 'mpv';
  }

  function proxyUrl(raw) {
    raw = normalizeUrl(raw);
    if (/^https:\/\/newgenres\.duckdns\.org\/TS\/+/i.test(raw)) return raw;
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
    var ip = torserverIp();
    if (ip && copy.url) {
      copy.url = String(copy.url).replace(/^https:\/\/newgenres\.duckdns\.org\/TS\/+/i, 'http://' + ip + '/');
    }
    return copy;
  }

  function isHeavyVideoUrl(url) {
    return /(2160p|uhd|4k|hdr|hdr10|dolby[\s._-]*vision|\bdv\b|hevc|h\.?265|x265)/i.test(String(url || ''));
  }

  function mpvOptionsFor(data) {
    var url = data && data.url || data || '';
    if (!isHeavyVideoUrl(url)) return '';
    return 'profile=fast,vd-lavc-fast=yes,vd-lavc-skiploopfilter=all,vd-lavc-skipidct=nonref,vd-lavc-skipframe=nonref,framedrop=vo,video-sync=audio,interpolation=no';
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
    if (data && data.timeline && data.timeline.handler) return data.timeline;
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
        'mpv': 'MPV WASM'
      }, 'default');
    }

    Lampa.SettingsApi.addParam({
      component: 'player',
      param: {
        name: 'mpvwasm_player_mode',
        type: 'select',
        values: {
          'default': 'Обычный плеер',
          'mpv': 'MPV WASM'
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
        try { if (Lampa.Controller) Lampa.Controller.toggle('mpvwasm_player'); } catch (_) { }
      },
      onBack: function () {
        try { if (Lampa.Controller) Lampa.Controller.toggle(last && last !== 'select' ? last : 'mpvwasm_player'); } catch (_) { }
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

  function createOverlay(existingCanvas) {
    var root = templateNode('player', '<div class="player"></div>');
    var video = templateNode('player_video', '<div class="player-video"><div class="player-video__display"></div><div class="player-video__loader"></div><div class="player-video__paused hide"></div><div class="player-video__backwork-icon"><i></i><span></span></div><div class="player-video__forward-icon"><span></span><i></i></div><div class="player-video__subtitles hide"><div class="player-video__subtitles-text"></div></div></div>');
    var panel = templateNode('player_panel', '<div class="player-panel"><div class="player-panel__body"><div class="player-panel__timeline selector"><div class="player-panel__peding"></div><div class="player-panel__position"><div></div></div><div class="player-panel__time hide"></div></div><div class="player-panel__line player-panel__line-one"><div class="player-panel__timenow"></div><div class="player-panel__timeend"></div></div><div class="player-panel__line player-panel__line-two"><div class="player-panel__left"></div><div class="player-panel__center"><div class="player-panel__rprev button selector">-</div><div class="player-panel__playpause button selector"><div>play</div><div>pause</div></div><div class="player-panel__rnext button selector">+</div></div><div class="player-panel__right"><div class="player-panel__tracks button selector hide">A</div><div class="player-panel__subs button selector hide">S</div><div class="player-panel__settings button selector">*</div><div class="player-panel__fullscreen button selector">[]</div></div></div></div></div>');
    var style = document.createElement('style');
    var display = video.querySelector('.player-video__display') || video;
    var canvas = existingCanvas || document.createElement('canvas');

    root.classList.add('mpvwasm-lampa-root');
    canvas.className = 'player-video__video mpvwasm-player-canvas';
    canvas.setAttribute('playsinline', 'playsinline');
    canvas.id = 'canvas';
    style.textContent = '.mpvwasm-lampa-root{position:fixed;inset:0;z-index:50;background:#000}.mpvwasm-lampa-root .player-video__display{position:fixed;inset:0;background:#000}.mpvwasm-lampa-root .mpvwasm-player-canvas{position:fixed;inset:0;width:100%;height:100%;background:#000;object-fit:contain}.mpvwasm-lampa-root .player-panel__quality{text-transform:uppercase}.mpvwasm-lampa-root .mpvwasm-player__status{display:none}';
    display.appendChild(canvas);
    root.appendChild(style);
    root.appendChild(video);
    root.appendChild(panel);
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

  function createHardwareVideoPlayer(ui, url, callbacks) {
    return new Promise(function (resolve) {
      var video = document.createElement('video');
      var timer = 0;
      var tracksTimer = 0;
      video.className = 'player-video__video mpvwasm-player-canvas mpvwasm-hw-video';
      video.playsInline = true;
      video.autoplay = true;
      video.controls = false;
      video.preload = 'auto';
      video.crossOrigin = 'anonymous';
      video.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;background:#000;object-fit:contain';
      try { ui.canvas.style.display = 'none'; } catch (_) { }
      ui.display.appendChild(video);
      ui.nativeVideo = video;

      function call(name, value) {
        try {
          if (callbacks && typeof callbacks[name] === 'function') callbacks[name](value);
        } catch (_) { }
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
      });
      video.addEventListener('pause', function () { call('isPlaying', false); });
      video.addEventListener('ended', function () { call('fileEnd', { hardware: true }); });
      video.addEventListener('error', function () {
        call('error', video.error ? (video.error.message || ('HTML5 video error ' + video.error.code)) : 'HTML5 video error');
      });
      video.addEventListener('timeupdate', tick);
      video.addEventListener('durationchange', tick);
      timer = setInterval(tick, 500);
      tracksTimer = setInterval(publishTracks, 1500);

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
        },
        seek: function (seconds) {
          try { video.currentTime = Math.max(0, Number(seconds || 0)); } catch (_) { }
          tick();
        },
        seekRelative: function (seconds) {
          try { video.currentTime = Math.max(0, (video.currentTime || 0) + Number(seconds || 0)); } catch (_) { }
          tick();
        },
        setVolume: function (value) {
          var volume = Number(value || 0);
          if (!isFinite(volume)) volume = 1;
          if (volume > 1) volume = volume / 100;
          video.volume = Math.max(0, Math.min(1, volume));
          video.muted = video.volume <= 0;
        },
        setAudioTrack: function (id) {
          try {
            if (!video.audioTracks) return;
            for (var i = 0; i < video.audioTracks.length; i++) video.audioTracks[i].enabled = i === Number(id);
            publishTracks();
          } catch (_) { }
        },
        setSubtitleTrack: function (id) {
          try {
            if (!video.textTracks) return;
            for (var i = 0; i < video.textTracks.length; i++) video.textTracks[i].mode = i === Number(id) ? 'showing' : 'disabled';
            publishTracks();
          } catch (_) { }
        },
        destroy: function () {
          clearInterval(timer);
          clearInterval(tracksTimer);
          try { video.pause(); } catch (_) { }
          try { video.removeAttribute('src'); video.load(); } catch (_) { }
          removeNode(video);
        },
        setOptions: function () { }
      };

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

    var playUrl = proxyUrl(data.url);
    var playOptions = mpvOptionsFor(data);
    var reuseSameUrl = !!(pooledPlayer && pooledUrl === playUrl);
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
      hideTimer: 0,
      cursorTimer: 0,
      clickTimer: 0,
      clickCount: 0,
      timeline: resolveTimeline(data),
      heavyVideo: isHeavyVideoUrl(data && data.url),
      hardwareVideo: isHeavyVideoUrl(data && data.url),
      timelineContinued: false,
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
          if (state.lastController && Lampa.Controller && Lampa.Controller.enabled && Lampa.Controller.enabled().name === 'mpvwasm_player') {
            Lampa.Controller.toggle(state.lastController);
          }
        } catch (_) { }
      },
      onKey: function (event) {
        if (!active) return;
        if (event.key === 'Escape' || event.key === 'Backspace') {
          event.preventDefault();
          closeActive();
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
      if (!state.timeline || state.timelineContinued || !state.duration || !active || !active.player) return;
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
      if (active && active.player) active.player.seek(target);
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
          try { if (Lampa.Controller) Lampa.Controller.toggle('mpvwasm_player'); } catch (_) { }
        }
      });
    }

    function installController() {
      if (!Lampa.Controller || !Lampa.Controller.add) return;
      Lampa.Controller.add('mpvwasm_player', {
        invisible: true,
        hover: showPanel,
        toggle: showPanel,
        up: showPanel,
        down: showPanel,
        left: function () { seekRelative(-rewindStep); },
        right: function () { seekRelative(rewindStep); },
        enter: playPause,
        playpause: playPause,
        play: function () { setPaused(false, true); },
        pause: function () { setPaused(true, true); },
        stop: closeActive,
        back: closeActive
      });
      try { Lampa.Controller.toggle('mpvwasm_player'); } catch (_) { }
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

    setHidden('.player-panel__prev,.player-panel__next,.player-panel__playlist,.player-panel__flow,.player-panel__pip', true);
    var quality = q('.player-panel__quality');
    if (quality) quality.textContent = state.hardwareVideo ? 'mpv hw' : 'mpv';

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
          if (data.torrent_hash || /[?&]link=/.test(String(data.url || ''))) Lampa.PlayerInfo.set('stat', playerInfoStatData(data));
        }
      }
    } catch (_) { }

    var playUrl = proxyUrl(data.url);
    var playOptions = mpvOptionsFor(data);
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
        resumeTimeline();
      },
      elapsed: function (value) {
        state.elapsed = Number(value || 0);
        updateTimeline();
        resumeTimeline();
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
        setLoading(false);
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

    var playerReady = state.hardwareVideo ? createHardwareVideoPlayer(ui, playUrl, callbacks) : (reusePlayer ? resumeWithPlayer(reusePlayer) : createFreshPlayer());

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
      resumeTimeline();
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
          lastError: lastError || window.__mpvwasm_last_error || ''
        };
      },
      normalizeUrl: normalizeUrl,
      proxyUrl: proxyUrl,
      prewarm: prewarmMpvPlayer
    };
    if (window.__mpvwasm_player_hooked) return;
    window.__mpvwasm_player_hooked = true;

    Lampa.Player.listener.follow('create', function (event) {
      if (!event || !event.data || !shouldUseMpvWasm(event.data)) return;
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
