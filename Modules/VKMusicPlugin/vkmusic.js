(function() {
  'use strict';

  var VERSION = '0.3.0-vk-standalone';
  var DEFAULT_API_BASE = '';
  var SOURCE = 'lampac_vk_music';
  var COMPONENT = 'lampac_vk_music_album';
  var CATALOG_COMPONENT = 'lampac_vk_music_catalog';
  var SETUP_COMPONENT = 'lampac_vk_music_setup';
  var PAGE_SIZE = 30;
  var RUNTIME_KEY = '__lampacVkMusicRuntime';
  var CONTINUE_KEY = 'lampac_vk_music_continue';

  if (window.lampacVkMusicPluginReady) return;
  window.lampacVkMusicPluginReady = true;

  var runtime = window[RUNTIME_KEY] || {
    cardCache: {},
    lastFullCard: null,
    searchSource: null,
    observer: null
  };
  window[RUNTIME_KEY] = runtime;

  var musicPlayer = (function() {
    var powtwo = 1024;
    var audio = null;
    var context = null;
    var source = null;
    var gain = null;
    var analyser = null;
    var freq = new Uint8Array(powtwo);
    var hasFreq = false;
    var fakeFreq = 0;
    var state = 'stop';
    var current = null;
    var panel = null;
    var raf = 0;
    var playToken = 0;

    function setup() {
      if (audio) return;

      audio = new Audio();
      audio.preload = 'auto';

      try {
        context = new (window.AudioContext || window.webkitAudioContext)();
        source = context.createMediaElementSource(audio);
        analyser = context.createAnalyser();
        gain = context.createGain();
        analyser.fftSize = powtwo;
        source.connect(analyser);
        source.connect(gain);
        gain.connect(context.destination);
      } catch (e) {
        context = null;
        analyser = null;
        gain = null;
      }

      ['play', 'waiting', 'playing', 'pause', 'ended', 'stalled', 'error'].forEach(function(event) {
        audio.addEventListener(event, function() {
          if (!audio.src) state = 'stop';
          else if (event == 'playing') state = 'play';
          else if (event == 'waiting' || event == 'stalled') state = 'loading';
          else if (event == 'pause') state = audio.src && !audio.ended ? 'pause' : 'stop';
          else if (event == 'ended' || event == 'error') state = 'stop';
          render();
        });
      });
    }

    function streamUrl(url) {
      if (/vkmusic/i.test(url)) return apiUrl('/vkmusic/vk/stream', { url: url });
      if (/^https?:\/\//i.test(url)) return apiUrl('/vkmusic/audio', { url: url });
      return url;
    }

    function value() {
      if (!analyser) {
        fakeFreq = state == 'play' ? Math.min(.7, fakeFreq + .025) : Math.max(0, fakeFreq - .025);
        return fakeFreq;
      }

      analyser.getByteFrequencyData(freq);
      var v = Math.floor(freq[4] | 0) / 255;
      if (!hasFreq && v) hasFreq = true;
      if (hasFreq) return v;

      fakeFreq = state == 'play' ? Math.min(.7, fakeFreq + .025) : Math.max(0, fakeFreq - .025);
      return fakeFreq;
    }

    function tick() {
      if (!panel || !panel.length) return;
      var level = value();
      panel.find('.lampac-music-wave i').each(function(index) {
        var height = 20 + Math.round(level * 54 * ((index % 5) + 1) / 5);
        this.style.height = height + '%';
      });
      raf = requestAnimationFrame(tick);
    }

    function render() {
      if (!panel || !panel.length) return;
      panel.removeClass('is-play is-loading is-pause is-stop').addClass('is-' + state);
      panel.find('.lampac-music-player__title').text(current && current.title || 'Выберите трек');
      panel.find('.lampac-music-player__artist').text(current && current.artist || 'ВК Музыка');
      panel.find('.lampac-music-player__time').text(current && current.duration || '');
      panel.find('.lampac-music-player__button span').text(state == 'play' ? 'Пауза' : 'Play');
      if (current && current.img) panel.find('.lampac-music-player__cover img').attr('src', current.img);
      renderProgress();
    }

    function formatClock(seconds) {
      seconds = Math.max(0, Math.floor(seconds || 0));
      var minutes = Math.floor(seconds / 60);
      var rest = seconds % 60;
      return minutes + ':' + (rest < 10 ? '0' : '') + rest;
    }

    function renderProgress() {
      if (!panel || !panel.length) return;
      var progress = panel.find('.lampac-music-progress');
      if (!progress.length) return;

      var currentTime = audio && audio.src ? audio.currentTime || 0 : 0;
      var duration = audio && isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      var percent = duration ? Math.min(100, Math.max(0, currentTime / duration * 100)) : 0;
      var text = duration ? formatClock(currentTime) + ' / ' + formatClock(duration) : '';
      progress.find('i').css('width', percent + '%');
      progress.find('span').text(text);
      panel.find('.lampac-music-player__time').text(text || current && current.duration || '');
    }

    function setCurrent(track, card) {
      track = track || {};
      card = card || {};
      current = {
        title: track.title || card.title || 'Трек',
        artist: track.artist || card.music_artist || card.original_title || '',
        duration: track.duration || card.music_duration || '',
        img: track.preview || track.img || card.music_preview || card.img || card.poster || './img/img_broken.svg'
      };
    }

    function show(track, card) {
      setup();
      playToken++;
      if (audio) {
        try { audio.pause(); } catch (e) {}
        try {
          audio.removeAttribute('src');
          audio.load();
        } catch (e) {}
      }
      setCurrent(track, card);
      state = 'stop';
      hasFreq = false;
      fakeFreq = 0;
      render();
    }

    function stop() {
      playToken++;
      setup();

      if (audio) {
        try { audio.pause(); } catch (e) {}
        try {
          audio.removeAttribute('src');
          audio.load();
        } catch (e) {}
      }

      state = 'stop';
      hasFreq = false;
      fakeFreq = 0;
      render();
    }

    function attach(element, album, card) {
      panel = element;
      if (!panel || !panel.length) return;

      panel.html(
        '<div class="lampac-music-player__cover"><img src="' + escapeHtml((album && album.preview) || (card && (card.img || card.poster)) || './img/img_broken.svg') + '"></div>' +
        '<div class="lampac-music-player__main">' +
          '<div class="lampac-music-player__title">Выберите трек</div>' +
          '<div class="lampac-music-player__artist">ВК Музыка</div>' +
          '<div class="lampac-music-wave">' + new Array(18).fill(0).map(function() { return '<i></i>'; }).join('') + '</div>' +
          '<div class="lampac-music-progress"><i></i><span></span></div>' +
        '</div>' +
        '<div class="lampac-music-player__time"></div>' +
        '<div class="lampac-music-player__button selector"><span>Play</span></div>'
      );

      panel.find('.lampac-music-player__button').off('.lampac-music').on('hover:enter.lampac-music', function(e) {
        e.stopPropagation();
        toggle();
      });
      panel.find('.lampac-music-progress').off('.lampac-music').on('click.lampac-music', function(e) {
        if (!audio || !audio.src || !isFinite(audio.duration) || audio.duration <= 0) return;
        var rect = this.getBoundingClientRect();
        var left = rect.left || 0;
        var width = rect.width || 1;
        var x = Math.min(width, Math.max(0, (e.clientX || left) - left));
        audio.currentTime = audio.duration * x / width;
        renderProgress();
      });
      panel.find('img').on('error', function() {
        this.style.display = 'none';
      });

      render();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    }

    function play(track, card) {
      setup();
      if (!track || !track.url) return false;
      var token = ++playToken;

      setCurrent(track, card);

      state = 'loading';
      render();

      if (context && context.state == 'suspended') {
        try { context.resume(); } catch (e) {}
      }

      try { audio.pause(); } catch (e) {}
      audio.src = streamUrl(track.url);
      audio.play().catch(function(error) {
        if (token != playToken) return;
        if (error && error.name == 'AbortError') return;
        if (audio && !audio.paused) return;
        state = 'pause';
        render();
        Lampa.Noty.show('Не удалось запустить трек');
      });

      return true;
    }

    function toggle() {
      setup();
      if (!audio || !audio.src) return;

      if (audio.paused) {
        state = 'loading';
        render();
        if (context && context.state == 'suspended') {
          try { context.resume(); } catch (e) {}
        }
        audio.play().catch(function() {
          state = 'pause';
          render();
        });
      } else {
        try { audio.pause(); } catch (e) {}
        state = 'pause';
        render();
      }
    }

    function seek(delta) {
      setup();
      if (!audio || !audio.src || !isFinite(audio.duration) || audio.duration <= 0) return false;
      audio.currentTime = Math.min(audio.duration, Math.max(0, (audio.currentTime || 0) + delta));
      renderProgress();
      return true;
    }

    function hasFocus() {
      return !!(panel && panel.length && panel.find('.lampac-music-player__button.focus,.lampac-music-progress.focus').length);
    }

    return {
      attach: attach,
      play: play,
      show: show,
      toggle: toggle,
      seek: seek,
      hasFocus: hasFocus,
      stop: stop
    };
  })();

  window.lampacVkMusicPlayer = musicPlayer;
  if (!window.lampacVkMusicPlayerClickBound) {
    window.lampacVkMusicPlayerClickBound = true;
    document.addEventListener('click', function(e) {
      var target = e.target;
      var button = target && target.closest ? target.closest('.lampac-music-player__button') : null;
      if (!button) return;

      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      musicPlayer.toggle();
    }, true);
  }

  function cleanApiBase(value) {
    return (value || '').toString().replace(/\/$/, '');
  }

  function scriptApiBase() {
    var src = '';
    var scripts;
    var match;

    if (document.currentScript && document.currentScript.src) src = document.currentScript.src;

    if (!src) {
      scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i--) {
        if (scripts[i].src && scripts[i].src.indexOf('music') >= 0) {
          src = scripts[i].src;
          break;
        }
      }
    }

    match = src.match(/[?&](?:api|server)=([^&#]+)/i);
    if (!match || !match[1]) return '';

    try {
      return cleanApiBase(decodeURIComponent(match[1]));
    } catch (e) {
      return cleanApiBase(match[1]);
    }
  }

  function detectApiBase() {
    var explicit = cleanApiBase(window.lampacVkMusicApiBase || '');
    var fromScript = scriptApiBase();
    var pageOrigin = '';

    if (explicit) return explicit;
    if (fromScript) return fromScript;
    if (window.location && window.location.origin) {
      pageOrigin = cleanApiBase(window.location.origin);
      if (/^https?:\/\/(?:www\.)?lampac\.fun(?::\d+)?$/i.test(pageOrigin)) return pageOrigin;
    }

    return cleanApiBase(DEFAULT_API_BASE);
  }

  var API_BASE = detectApiBase();
  window.lampacVkMusicApiBase = API_BASE;

  function addParam(url, key, value) {
    if (value === undefined || value === null || value === '') return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + encodeURIComponent(key) + '=' + encodeURIComponent(value);
  }

  function apiUrl(path, params) {
    var url = /^https?:\/\//i.test(path) ? path : API_BASE + path;

    params = params || {};
    for (var key in params) {
      if (params.hasOwnProperty(key)) url = addParam(url, key, params[key]);
    }

    if (window.Lampa && Lampa.Storage && Lampa.Storage.get) {
      var uid = Lampa.Storage.get('lampac_unic_id', '') || '';
      var email = Lampa.Storage.get('account_email', '') || '';
      var profile = Lampa.Storage.get('lampac_profile_id', '') || '';
      if (uid && url.indexOf('uid=') < 0) url = addParam(url, 'uid', uid);
      if (email && url.indexOf('account_email=') < 0) url = addParam(url, 'account_email', email);
      if (profile && url.indexOf('profile_id=') < 0) url = addParam(url, 'profile_id', profile);
    }

    return url;
  }

  function callbackUrl() {
    return apiUrl('/vkmusic-callback.html');
  }

  function requestJSON(url, onComplete, onError, timeout) {
    var network = new Lampa.Reguest();
    network.timeout(timeout || 30000);
    network.native(url, function(data) {
      onComplete(data || {});
    }, function(a, c) {
      if (onError) onError(a, c);
    });
    return network;
  }

  function checkVkToken(onReady, onMissing, onError) {
    requestJSON(apiUrl('/vkmusic/vk/auth/status'), function(data) {
      if (data && data.token) {
        if (onReady) onReady(data);
      } else if (onMissing) {
        onMissing(data || {});
      }
    }, function(a, c) {
      if (onError) onError(a, c);
      else if (onMissing) onMissing({});
    }, 15000);
  }

  function escapeHtml(value) {
    return $('<div>').text(value || '').html();
  }

  function shortText(value, length) {
    value = (value || '').replace(/\s+/g, ' ').trim();
    if (value.length <= length) return value;
    return value.slice(0, Math.max(0, length - 1)) + '…';
  }

  function ensureLampaCardDefaults(card) {
    card = card || {};
    if (!Array.isArray(card.genres)) card.genres = [];
    if (!Array.isArray(card.genre_ids)) card.genre_ids = [];
    if (!Array.isArray(card.production_countries)) card.production_countries = [];
    if (!Array.isArray(card.origin_country)) card.origin_country = [];
    if (!Array.isArray(card.spoken_languages)) card.spoken_languages = [];
    if (!Array.isArray(card.production_companies)) card.production_companies = [];
    if (!Array.isArray(card.countries)) card.countries = [];
    if (!Array.isArray(card.seasons)) card.seasons = [];
    card.runtime = parseInt(card.runtime || 0, 10) || 0;
    card.vote_average = parseFloat(card.vote_average || 0) || 0;
    card.vote_count = parseInt(card.vote_count || 0, 10) || 0;
    card.popularity = parseFloat(card.popularity || 0) || 0;
    card.budget = parseInt(card.budget || 0, 10) || 0;
    card.revenue = parseInt(card.revenue || 0, 10) || 0;
    card.number_of_episodes = parseInt(card.number_of_episodes || 0, 10) || 0;
    card.number_of_seasons = parseInt(card.number_of_seasons || 0, 10) || 0;
    card.tagline = card.tagline || '';
    card.status = card.status || '';
    card.homepage = card.homepage || '';
    card.adult = !!card.adult;
    return card;
  }

  function cacheCard(card) {
    if (!card) return card;
    ensureLampaCardDefaults(card);
    runtime.cardCache[card.id] = card;
    if (card.music_id) runtime.cardCache[card.music_id] = card;
    return card;
  }

  function storedCards() {
    var value = [];

    try {
      value = Lampa.Storage && Lampa.Storage.get ? Lampa.Storage.get(CONTINUE_KEY, []) : [];
      if (typeof value == 'string') value = JSON.parse(value || '[]');
    } catch (e) {
      value = [];
    }

    return Array.isArray(value) ? value : [];
  }

  function rememberMusicCard(card) {
    if (!isMusicCard(card) || !Lampa.Storage || !Lampa.Storage.set) return;

    try {
      var clone = JSON.parse(JSON.stringify(card));
      var id = clone.id || clone.music_id || clone.music_track_url || clone.title;
      var list = storedCards().filter(function(item) {
        return (item.id || item.music_id || item.music_track_url || item.title) != id;
      });

      list.unshift(clone);
      Lampa.Storage.set(CONTINUE_KEY, list.slice(0, 30));
    } catch (e) {}
  }

  function continueRow() {
    var results = storedCards().map(cacheCard).filter(isMusicCard).slice(0, PAGE_SIZE);
    if (!results.length) return null;

    return {
      url: 'lampac-music-continue',
      title: 'Продолжить прослушивание',
      source: SOURCE,
      page: 1,
      pages: 1,
      total_pages: 1,
      total_results: results.length,
      more: false,
      nomore: true,
      results: results,
      card_events: musicCardEvents()
    };
  }

  function isMusicCard(card) {
    return !!(card && (card.source == SOURCE || card.music_id || card.music_source));
  }

  function cardFromAny(card) {
    card = card || {};
    if (card.music_album) return cacheCard(card);

    var cached = runtime.cardCache[card.id] || runtime.cardCache[card.music_id] || {};
    return cacheCard(Object.assign({}, cached, card));
  }

  function cardImage(card) {
    card = card || {};
    return card.music_preview || card.img || card.poster || card.background_image || './img/img_broken.svg';
  }

  function cardArtist(card) {
    card = card || {};
    return card.music_artist || card.original_title || card.original_name || '';
  }

  function cardMeta(card) {
    var meta = [];
    card = card || {};
    if (cardArtist(card)) meta.push(cardArtist(card));
    if (card.music_year) meta.push(card.music_year);
    return meta.join(' / ');
  }

  function ensureHorizontalVisible(item) {
    var node = item && item[0];
    var row = item && item.closest('.lampac-music-catalog-row__items')[0];
    var left;
    var right;
    var viewLeft;
    var viewRight;

    if (!node || !row) return;

    left = node.offsetLeft;
    right = left + node.offsetWidth;
    viewLeft = row.scrollLeft;
    viewRight = viewLeft + row.clientWidth;

    if (left < viewLeft) row.scrollLeft = Math.max(0, left - 24);
    else if (right > viewRight) row.scrollLeft = right - row.clientWidth + 24;
  }

  function ensureVerticalVisible(item) {
    var node = item && item[0];
    var rect;

    if (!node) return;

    try {
      rect = node.getBoundingClientRect();
      if (rect.top < 120 || rect.bottom > window.innerHeight - 60) {
        node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      }
    } catch (e) {
      try { node.scrollIntoView(false); } catch (ignore) {}
    }
  }

  function focusCatalogItem(item, scroll, lastSetter) {
    item = item && item.length ? item : $();
    if (!item.length) return false;

    if (lastSetter) lastSetter(item[0]);
    Lampa.Controller.collectionSet(scroll.render());
    Lampa.Controller.collectionFocus(item[0], scroll.render());
    ensureVerticalVisible(item);
    ensureHorizontalVisible(item);
    scroll.update(item, true);

    var card = item.data('music-card') || {};
    Lampa.Background.immediately(cardImage(card));
    return true;
  }

  function moveCatalogHorizontal(last, scroll, lastSetter, direction) {
    var item = last ? $(last).closest('.lampac-music-card') : $();
    var next;

    if (!item.length) item = $('.lampac-music-card.focus').first();
    if (!item.length) item = $('.lampac-music-card').first();
    if (!item.length) return false;

    next = direction > 0 ? item.next('.lampac-music-card') : item.prev('.lampac-music-card');
    if (!next.length) return false;

    return focusCatalogItem(next, scroll, lastSetter);
  }

  function moveCatalogVertical(last, scroll, lastSetter, direction) {
    var item = last ? $(last).closest('.lampac-music-card') : $();
    var row;
    var nextRow;
    var index;
    var next;

    if (!item.length) item = $('.lampac-music-card.focus').first();
    if (!item.length) item = $('.lampac-music-card').first();
    if (!item.length) return false;

    row = item.closest('.lampac-music-catalog-row');
    nextRow = direction > 0 ? row.nextAll('.lampac-music-catalog-row').first() : row.prevAll('.lampac-music-catalog-row').first();
    if (!nextRow.length) return false;

    index = Math.max(0, parseInt(item.attr('data-index') || '0', 10) || 0);
    next = nextRow.find('.lampac-music-card').eq(index);
    if (!next.length) next = nextRow.find('.lampac-music-card').last();

    return focusCatalogItem(next, scroll, lastSetter);
  }

  function musicQuery(card, track) {
    var parts = [];
    card = card || {};
    track = track || {};
    if (track.artist) parts.push(track.artist);
    else if (card.music_artist || card.original_title) parts.push(card.music_artist || card.original_title);
    if (track.title) parts.push(track.title);
    else if (card.music_title || card.title) parts.push(card.music_title || card.title);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function musicCardEvents() {
    return {
      onMenu: function() {},
      onEnter: function(element, data) {
        var card = data || element;
        if (card && card.nodeType) card = null;
        if (card) openAlbum(card);
      }
    };
  }

  function sourceList(params, onComplete, onError) {
    params = params || {};
    var rawQuery = params.query || params.search || '';
    var query = '';
    var page = parseInt(params.page || 1, 10) || 1;

    try {
      query = decodeURIComponent(rawQuery || '');
    } catch (e) {
      query = rawQuery || '';
    }

    requestJSON(apiUrl('/vkmusic/catalog', {
      query: query,
      page: page,
      limit: PAGE_SIZE
    }), function(row) {
      row = row || {};
      row.source = SOURCE;
      row.card_events = musicCardEvents();
      row.results = (row.results || []).map(cacheCard);
      onComplete(row);
    }, onError, 45000);
  }

  function sourceCategory(params, onComplete, onError) {
    params = params || {};

    if (params.query || params.search || (parseInt(params.page || 1, 10) || 1) > 1) {
      sourceList({
        page: params.page || 1,
        query: params.query || params.search || ''
      }, function(row) {
        row.title = row.title || 'ВК Музыка';
        onComplete([row]);
      }, onError);
      return;
    }

    requestJSON(apiUrl('/vkmusic/home', { limit: PAGE_SIZE }), function(rows) {
      rows = Array.isArray(rows) ? rows : [];
      rows = rows.map(function(row) {
        row = row || {};
        row.source = SOURCE;
        row.card_events = musicCardEvents();
        row.results = (row.results || []).map(cacheCard);
        return row;
      }).filter(function(row) {
        return row.results && row.results.length;
      });

      var local = continueRow();
      if (local) rows.splice(rows.length ? 1 : 0, 0, local);

      onComplete(rows);
    }, onError, 60000);
  }

  function sourceFull(params, onComplete, onError) {
    params = params || {};
    var card = cardFromAny(params.card || {});

    requestJSON(apiUrl('/vkmusic/full', {
      id: card.music_id || '',
      title: card.title || card.name || '',
      artist: card.music_artist || card.original_title || card.original_name || '',
      year: card.music_year || '',
      preview: card.music_preview || card.img || card.poster || '',
      source: card.music_source || '',
      track_url: card.music_track_url || '',
      duration: card.music_duration || ''
    }), function(data) {
      var movie = cacheCard(data && data.movie || card);
      runtime.lastFullCard = movie;
      if (onComplete) onComplete({ movie: movie });
      setTimeout(repairFullButtons, 250);
      setTimeout(repairFullButtons, 900);
    }, onError, 45000);
  }

  function sourceMenu(params, onComplete) {
    onComplete([{ title: 'Треки', id: 'vkmusic' }]);
  }

  function registerMusicSource() {
    if (!Lampa.Api || !Lampa.Api.sources) return false;

    Lampa.Api.sources[SOURCE] = {
      _lampacVersion: VERSION,
      main: sourceCategory,
      category: sourceCategory,
      list: sourceList,
      full: sourceFull,
      menu: sourceMenu,
      person: function(params, onComplete, onError) {
        if (Lampa.Api.sources.tmdb && Lampa.Api.sources.tmdb.person) Lampa.Api.sources.tmdb.person(params, onComplete, onError);
        else if (onError) onError();
      },
      clear: function() {}
    };

    try {
      if (Lampa.Params && Lampa.Params.values && Lampa.Params.values.source) {
        Lampa.Params.values.source[SOURCE] = 'ВК Музыка';
      }
    } catch (e) {}

    return true;
  }

  function registerSearchSource() {
    if (!Lampa.Search || !Lampa.Search.addSource) return false;

    if (runtime.searchSource && Lampa.Search.removeSource) {
      try { Lampa.Search.removeSource(runtime.searchSource); } catch (e) {}
    }

    runtime.searchSource = {
      title: 'ВК Музыка',
      search: function(params, onComplete) {
        var query = params && params.query ? params.query : '';
        if (!query) {
          onComplete([]);
          return;
        }

        sourceList({ page: 1, query: query }, function(row) {
          row.title = 'ВК Музыка';
          row.source = SOURCE;
          onComplete(row.results && row.results.length ? [row] : []);
        }, function() {
          onComplete([]);
        });
      },
      onCancel: function() {},
      params: {
        lazy: true,
        align_left: true,
        card_events: { onMenu: function() {} }
      },
      onMore: function(params, close) {
        if (close) close();
        Lampa.Activity.push({
          url: 'vkmusic',
          title: 'ВК Музыка',
          component: CATALOG_COMPONENT,
          source: SOURCE,
          card_type: true,
          page: 1,
          search: params && params.query || '',
          query: params && params.query || '',
          card_events: musicCardEvents()
        });
      },
      onSelect: function(params, close) {
        var element = params && params.element;
        if (close) close();
        if (!element) return;
        openAlbum(cacheCard(element));
      }
    };

    Lampa.Search.addSource(runtime.searchSource);
    return true;
  }

  function pushCatalog() {
    registerMusicSource();
    Lampa.Activity.push({
      url: 'vkmusic',
      title: 'ВК Музыка',
      component: CATALOG_COMPONENT,
      source: SOURCE,
      card_type: true,
      page: 1,
      search: '',
      card_events: musicCardEvents()
    });
  }

  function openSetup() {
    registerMusicSource();
    Lampa.Activity.push({
      url: 'vkmusic-setup',
      title: 'ВК Музыка',
      component: SETUP_COMPONENT,
      source: SOURCE,
      card_type: false,
      noinfo: true
    });
  }

  function openCatalog() {
    registerMusicSource();
    checkVkToken(pushCatalog, openSetup, openSetup);
  }

  function playTrack(track, card) {
    var url = track && track.url || '';
    if (!url) {
      musicPlayer.show(track, card);
      Lampa.Noty.show('Поток для трека не найден');
      return;
    }

    if (card) rememberMusicCard(card);
    if (Lampa.Favorite && Lampa.Favorite.add && card) Lampa.Favorite.add('history', card, 100);

    musicPlayer.play(track, card);
  }

  function playOnline(track, card, row, album) {
    var query = musicQuery(card, track);
    row = row || $();
    track = track || {
      title: album && album.title || card && (card.music_title || card.title) || '',
      artist: album && album.artist || card && (card.music_artist || card.original_title) || '',
      duration: card && card.music_duration || '',
      preview: album && album.preview || card && (card.music_preview || card.img || card.poster) || ''
    };
    track.preview = track.preview || album && album.preview || card && (card.music_preview || card.img || card.poster) || '';

    if (track && track.url) {
      playTrack(track, card);
      return;
    }

    if (card && card.music_track_url) {
      playTrack({
        title: card.music_title || card.title,
        artist: card.music_artist || card.original_title,
        duration: card.music_duration || '',
        url: card.music_track_url
      }, card);
      return;
    }

    musicPlayer.show(track, card);
    row.addClass('is-loading');

    requestJSON(apiUrl('/vkmusic/resolve', {
      artist: track && track.artist || album && album.artist || card && (card.music_artist || card.original_title) || '',
      title: track && track.title || album && album.title || card && (card.music_title || card.title) || '',
      query: query
    }), function(result) {
      row.removeClass('is-loading');
      if (result && result.found && result.track && result.track.url) {
        track.url = result.track.url;
        track.source = result.track.source || 'online';
        track.preview = album && album.preview || card && (card.img || card.poster) || result.track.preview || '';
        playTrack(track, card);
      } else {
        musicPlayer.show(track, card);
        Lampa.Noty.show('Источник для трека не найден');
      }
    }, function() {
      row.removeClass('is-loading');
      musicPlayer.show(track, card);
      Lampa.Noty.show('Проверка источника не ответила');
    }, 20000);
  }

  function openTorrentSearch(card, query) {
    card = cardFromAny(card || runtime.lastFullCard || {});
    query = query || musicQuery(card);

    if (window.lmeMusicSearch_ready) {
      Lampa.Activity.push({
        url: '',
        title: 'Музыкальные торренты',
        component: 'lmeMusicSearch',
        search: query,
        from_search: true,
        noinfo: true,
        movie: card
      });
      return;
    }

    Lampa.Activity.push({
      url: '',
      title: 'Торренты',
      component: 'torrents',
      search: query,
      from_search: true,
      noinfo: true,
      movie: card
    });
  }

  function openAlbum(card) {
    card = cardFromAny(card || runtime.lastFullCard || {});
    runtime.lastFullCard = card;
    Lampa.Activity.push({
      url: '',
      title: card.title || card.name || 'Музыка',
      component: COMPONENT,
      source: SOURCE,
      card: card,
      movie: card
    });
  }

  function VKMusicSetupComponent(object) {
    var scroll = new Lampa.Scroll({ mask: false, over: true });
    var html = $('<div></div>');
    var body = $('<div class="lampac-music-catalog"></div>');
    var authUrl = '';
    var authMode = 'blank';
    var authRedirectUri = '';
    var pollTimer = 0;
    var _this = this;

    this.create = function() {
      scroll.append(body);
      html.append(scroll.render());
      this.activity.loader(false);
      this.renderSetup();
      return this.render();
    };

    this.renderSetup = function() {
      body.html(
        '<div class="lampac-music-catalog__head">' +
          '<div class="lampac-music-catalog__title">ВК Музыка</div>' +
        '</div>' +
        '<div class="lampac-vk-setup" style="padding:1.2em;max-width:56em">' +
          '<div style="font-size:1.2em;margin-bottom:.7em">Нужна авторизация VK</div>' +
          '<div class="lampac-vk-setup__hint" style="opacity:.76;line-height:1.45;margin-bottom:1em">Нажмите кнопку и подтвердите доступ на странице VK. Если сервер настроен на callback, токен сохранится автоматически. Иначе VK откроет blank.html, адрес нужно вставить один раз здесь с компьютера или телефона.</div>' +
          '<div class="selector lampac-vk-setup__auth" style="display:inline-flex;padding:.72em 1em;border-radius:.45em;background:#4f8cff;color:#fff;font-weight:700;margin:0 .7em .9em 0">Войти через VK</div>' +
          '<div class="selector lampac-vk-setup__status" style="display:inline-flex;padding:.72em 1em;border-radius:.45em;background:#263244;color:#fff;font-weight:700;margin-bottom:.9em">Проверить статус</div>' +
          '<div class="lampac-vk-setup__message" style="white-space:pre-wrap;line-height:1.45;margin:.5em 0 1em;opacity:.82">Проверяю токен...</div>' +
          '<div class="lampac-vk-setup__manual">' +
            '<textarea class="lampac-vk-setup__redirect" style="display:block;width:100%;min-height:5.5em;box-sizing:border-box;padding:.72em;border-radius:.45em;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.28);color:#fff;margin:.7em 0" placeholder="Вставьте сюда URL вида https://oauth.vk.com/blank.html#access_token=..."></textarea>' +
            '<div class="selector lampac-vk-setup__save" style="display:inline-flex;padding:.72em 1em;border-radius:.45em;background:#2c8f5a;color:#fff;font-weight:700;margin:0 .7em .9em 0">Сохранить токен</div>' +
          '</div>' +
          '<div style="opacity:.62;font-size:.9em;margin:.7em 0">Если VK не открылся, ссылка появится ниже:</div>' +
          '<div class="lampac-vk-setup__url" style="word-break:break-word;opacity:.74;font-size:.86em"></div>' +
        '</div>'
      );

      body.find('.lampac-vk-setup__auth').on('hover:enter click', function() {
        _this.openAuth();
      });

      body.find('.lampac-vk-setup__status').on('hover:enter click', function() {
        _this.loadStatus(true);
      });

      body.find('.lampac-vk-setup__save').on('hover:enter click', function() {
        _this.saveToken();
      });

      this.loadAuthUrl();
      this.loadStatus(false);
    };

    this.loadAuthUrl = function() {
      requestJSON(apiUrl('/vkmusic/vk/auth/url'), function(data) {
        authUrl = data && data.url || '';
        authMode = data && data.auth_mode || 'blank';
        authRedirectUri = data && data.redirect_uri || '';
        if (authMode == 'callback') {
          body.find('.lampac-vk-setup__manual').hide();
          body.find('.lampac-vk-setup__hint').text('Нажмите кнопку и подтвердите доступ на странице VK. После подтверждения VK вернёт вас на Lampac, сервер сохранит токен сам, а каталог откроется без повторной настройки.');
        } else {
          body.find('.lampac-vk-setup__manual').show();
          body.find('.lampac-vk-setup__hint').text('Нажмите кнопку и подтвердите доступ на странице VK. Для общего client_id VK открывает oauth.vk.com/blank.html: скопируйте адрес целиком и вставьте его сюда один раз с компьютера или телефона.');
        }
        body.find('.lampac-vk-setup__url').text(authUrl);
      }, function() {
        body.find('.lampac-vk-setup__url').text('Не удалось получить OAuth URL');
      }, 15000);
    };

    this.openAuth = function() {
      if (!authUrl) {
        this.loadAuthUrl();
        Lampa.Noty.show('OAuth URL ещё загружается');
        return;
      }

      try {
        window.open(authUrl, '_blank', 'noopener,noreferrer');
      } catch (e) {
        window.location.href = authUrl;
      }

      if (authMode == 'callback') {
        body.find('.lampac-vk-setup__message').text('Открыл VK. После подтверждения сервер сохранит токен автоматически.');
      } else {
        body.find('.lampac-vk-setup__message').text('Открыл VK. После подтверждения скопируйте адрес страницы oauth.vk.com/blank.html целиком и вставьте его здесь один раз.');
      }
      this.startPolling();
    };

    this.saveToken = function() {
      var value = (body.find('.lampac-vk-setup__redirect').val() || '').toString().trim();
      var url = apiUrl('/vkmusic/vk/auth/save', { redirect_url: value });

      if (!value) {
        Lampa.Noty.show('Вставьте URL с access_token');
        return;
      }

      requestJSON(url, function(data) {
        if (data && data.saved) {
          body.find('.lampac-vk-setup__message').text('Токен сохранён. Открываю каталог ВК Музыка...');
          Lampa.Noty.show('ВК токен сохранён');
          setTimeout(pushCatalog, 500);
        } else {
          body.find('.lampac-vk-setup__message').text('Не удалось сохранить токен:\n' + JSON.stringify(data || {}, null, 2));
        }
      }, function() {
        body.find('.lampac-vk-setup__message').text('Не удалось сохранить токен. Проверьте, что URL содержит #access_token=...');
      }, 20000);
    };

    this.loadStatus = function(showReadyNotice) {
      checkVkToken(function(data) {
        body.find('.lampac-vk-setup__message').text('Токен сохранён. Открываю каталог ВК Музыка...');
        if (showReadyNotice) Lampa.Noty.show('ВК токен подключён');
        setTimeout(pushCatalog, 500);
      }, function() {
        body.find('.lampac-vk-setup__message').text(authMode == 'callback'
          ? 'Токен пока не подключён. Нажмите "Войти через VK"; после подтверждения он сохранится сам.'
          : 'Токен пока не подключён. Нажмите "Войти через VK", затем вставьте URL с access_token и сохраните.');
      }, function() {
        body.find('.lampac-vk-setup__message').text('Не удалось проверить токен. Попробуйте ещё раз.');
      });
    };

    this.startPolling = function() {
      if (pollTimer) clearInterval(pollTimer);
      var attempts = 0;
      pollTimer = setInterval(function() {
        attempts++;
        _this.loadStatus(false);
        if (attempts > 24) {
          clearInterval(pollTimer);
          pollTimer = 0;
        }
      }, 5000);
    };

    this.start = function() {
      var first = body.find('.selector').eq(0);
      if (first.length) {
        Lampa.Controller.collectionSet(scroll.render());
        Lampa.Controller.collectionFocus(first[0], scroll.render());
      }
    };

    this.pause = function() {};
    this.stop = function() {};

    this.destroy = function() {
      if (pollTimer) clearInterval(pollTimer);
      if (scroll && scroll.destroy) scroll.destroy();
      html.remove();
    };

    this.render = function() {
      return html;
    };
  }

  function MusicCatalogComponent(object) {
    object = object || {};

    var scroll = new Lampa.Scroll({ mask: false, over: true });
    var html = $('<div></div>');
    var body = $('<div class="lampac-music-catalog"></div>');
    var query = (object.search || object.query || '').toString();
    var last;
    var network;
    var _this = this;

    this.create = function() {
      scroll.append(body);
      html.append(scroll.render());
      this.activity.loader(true);
      this.load();
      return this.render();
    };

    this.load = function() {
      if (network && network.clear) network.clear();

      if (query) {
        network = requestJSON(apiUrl('/vkmusic/catalog', {
          query: query,
          page: 1,
          limit: PAGE_SIZE
        }), function(row) {
          _this.renderRows([normalizeMusicRow(row)]);
        }, function() {
          _this.empty();
        }, 45000);
        return;
      }

      network = requestJSON(apiUrl('/vkmusic/home', { limit: PAGE_SIZE }), function(rows) {
        rows = Array.isArray(rows) ? rows.map(normalizeMusicRow) : [];

        var local = continueRow();
        if (local) rows.splice(rows.length ? 1 : 0, 0, normalizeMusicRow(local));

        _this.renderRows(rows.filter(function(row) {
          return row.results && row.results.length;
        }));
      }, function() {
        _this.empty();
      }, 60000);
    };

    function normalizeMusicRow(row) {
      row = row || {};
      row.source = SOURCE;
      row.card_events = musicCardEvents();
      row.results = (row.results || []).map(cacheCard).filter(isMusicCard);
      return row;
    }

    this.renderRows = function(rows) {
      body.empty();
      body.append(
        '<div class="lampac-music-catalog__head">' +
          '<div class="lampac-music-catalog__title">' + escapeHtml(query ? 'РџРѕРёСЃРє: ' + query : (object.title || 'РњСѓР·С‹РєР°')) + '</div>' +
        '</div>'
      );

      rows.forEach(function(row) {
        if (!row || !row.results || !row.results.length) return;
        body.append(renderCatalogRow(row));
      });

      last = body.find('.lampac-music-card').eq(0)[0] || false;

      if (!last) {
        _this.empty();
        return;
      }

      _this.activity.loader(false);
      _this.activity.toggle();
    };

    function renderCatalogRow(row) {
      var section = $(
        '<div class="lampac-music-catalog-row">' +
          '<div class="lampac-music-catalog-row__title">' + escapeHtml(row.title || 'РњСѓР·С‹РєР°') + '</div>' +
          '<div class="lampac-music-catalog-row__items"></div>' +
        '</div>'
      );
      var items = section.find('.lampac-music-catalog-row__items');

      row.results.forEach(function(sourceCard, index) {
        var card = cacheCard(sourceCard);
        var image = cardImage(card);
        var item = $(
          '<div class="selector lampac-music-card">' +
            '<div class="lampac-music-card__cover">' +
              '<img src="' + escapeHtml(image) + '">' +
            '</div>' +
            '<div class="lampac-music-card__title">' + escapeHtml(card.title || card.name || 'РђР»СЊР±РѕРј') + '</div>' +
            '<div class="lampac-music-card__meta">' + escapeHtml(cardMeta(card)) + '</div>' +
          '</div>'
        );
        item.attr('data-index', index).data('music-card', card);

        item.on('hover:focus', function(e) {
          last = e.target;
          ensureHorizontalVisible(item);
          scroll.update(item, true);
          Lampa.Background.immediately(image);
        }).on('hover:enter click', function(e) {
          if (e && e.preventDefault) e.preventDefault();
          openAlbum(card);
        });

        items.append(item);
        item.find('img').on('error', function() {
          this.style.display = 'none';
          item.find('.lampac-music-card__cover').addClass('is-missing');
        });
      });

      return section;
    }

    this.empty = function() {
      var empty = new Lampa.Empty();
      body.empty().append(empty.render());
      this.activity.loader(false);
      this.activity.toggle();
    };

    this.back = function() {
      Lampa.Activity.backward();
    };

    this.start = function() {
      if (Lampa.Activity.active().activity !== this.activity) return;
      Lampa.Background.immediately('./img/background.png');
      Lampa.Controller.add('content', {
        toggle: function() {
          Lampa.Controller.collectionSet(scroll.render());
          Lampa.Controller.collectionFocus(last || false, scroll.render());
          if (last) scroll.update($(last), true);
        },
        left: function() {
          if (musicPlayer.hasFocus() && musicPlayer.seek(-15)) return;
          if (moveCatalogHorizontal(last, scroll, function(value) { last = value; }, -1)) return;
          if (Navigator.canmove('left')) Navigator.move('left');
          else Lampa.Controller.toggle('menu');
        },
        right: function() {
          if (musicPlayer.hasFocus() && musicPlayer.seek(15)) return;
          if (moveCatalogHorizontal(last, scroll, function(value) { last = value; }, 1)) return;
          if (Navigator.canmove('right')) Navigator.move('right');
        },
        up: function() {
          if (moveCatalogVertical(last, scroll, function(value) { last = value; }, -1)) return;
          if (Navigator.canmove('up')) Navigator.move('up');
          else Lampa.Controller.toggle('head');
        },
        down: function() {
          if (moveCatalogVertical(last, scroll, function(value) { last = value; }, 1)) return;
          if (Navigator.canmove('down')) Navigator.move('down');
        },
        back: this.back
      });
      Lampa.Controller.toggle('content');
    };

    this.pause = function() {};
    this.stop = function() {};
    this.render = function() { return html; };
    this.destroy = function() {
      if (network && network.clear) network.clear();
      scroll.destroy();
      html.remove();
    };
  }

  function MusicSquareCatalogComponent(object) {
    object = object || {};

    var scroll = new Lampa.Scroll({ mask: false, over: true });
    var html = $('<div></div>');
    var body = $('<div class="lampac-music-catalog"></div>');
    var query = (object.search || object.query || '').toString();
    var last;
    var network;
    var _this = this;

    this.create = function() {
      scroll.append(body);
      html.append(scroll.render());
      this.activity.loader(true);
      this.load();
      return this.render();
    };

    this.load = function() {
      if (network && network.clear) network.clear();

      if (query) {
        network = requestJSON(apiUrl('/vkmusic/catalog', {
          query: query,
          page: 1,
          limit: PAGE_SIZE
        }), function(row) {
          _this.renderRows([normalizeMusicRow(row)]);
        }, function() {
          _this.empty();
        }, 45000);
        return;
      }

      network = requestJSON(apiUrl('/vkmusic/home', { limit: PAGE_SIZE }), function(rows) {
        rows = Array.isArray(rows) ? rows.map(normalizeMusicRow) : [];

        var local = continueRow();
        if (local) rows.splice(rows.length ? 1 : 0, 0, normalizeMusicRow(local));

        _this.renderRows(rows.filter(function(row) {
          return row.results && row.results.length;
        }));
      }, function() {
        _this.empty();
      }, 60000);
    };

    function normalizeMusicRow(row) {
      row = row || {};
      row.source = SOURCE;
      row.card_events = musicCardEvents();
      row.results = (row.results || []).map(cacheCard).filter(isMusicCard);
      return row;
    }

    this.renderRows = function(rows) {
      body.empty();
      body.append(
        '<div class="lampac-music-catalog__head">' +
          '<div class="lampac-music-catalog__title">' + escapeHtml(query || object.title || 'Music') + '</div>' +
        '</div>'
      );

      rows.forEach(function(row) {
        if (!row || !row.results || !row.results.length) return;
        body.append(renderCatalogRow(row));
      });

      last = body.find('.lampac-music-card').eq(0)[0] || false;

      if (!last) {
        _this.empty();
        return;
      }

      _this.activity.loader(false);
      _this.activity.toggle();
    };

    function renderCatalogRow(row) {
      var section = $(
        '<div class="lampac-music-catalog-row">' +
          '<div class="lampac-music-catalog-row__title">' + escapeHtml(row.title || 'Music') + '</div>' +
          '<div class="lampac-music-catalog-row__items"></div>' +
        '</div>'
      );
      var items = section.find('.lampac-music-catalog-row__items');

      row.results.forEach(function(sourceCard, index) {
        var card = cacheCard(sourceCard);
        var image = cardImage(card);
        var item = $(
          '<div class="selector lampac-music-card">' +
            '<div class="lampac-music-card__cover">' +
              '<img src="' + escapeHtml(image) + '">' +
            '</div>' +
            '<div class="lampac-music-card__title">' + escapeHtml(card.title || card.name || 'Album') + '</div>' +
            '<div class="lampac-music-card__meta">' + escapeHtml(cardMeta(card)) + '</div>' +
          '</div>'
        );
        item.attr('data-index', index).data('music-card', card);

        item.on('hover:focus', function(e) {
          last = e.target;
          ensureHorizontalVisible(item);
          scroll.update(item, true);
          Lampa.Background.immediately(image);
        }).on('hover:enter click', function(e) {
          if (e && e.preventDefault) e.preventDefault();
          openAlbum(card);
        });

        items.append(item);
        item.find('img').on('error', function() {
          this.style.display = 'none';
          item.find('.lampac-music-card__cover').addClass('is-missing');
        });
      });

      return section;
    }

    this.empty = function() {
      var empty = new Lampa.Empty();
      body.empty().append(empty.render());
      this.activity.loader(false);
      this.activity.toggle();
    };

    this.back = function() {
      Lampa.Activity.backward();
    };

    this.start = function() {
      if (Lampa.Activity.active().activity !== this.activity) return;
      Lampa.Controller.add('content', {
        toggle: function() {
          Lampa.Controller.collectionSet(scroll.render());
          Lampa.Controller.collectionFocus(last || false, scroll.render());
          if (last) scroll.update($(last), true);
        },
        left: function() {
          if (musicPlayer.hasFocus() && musicPlayer.seek(-15)) return;
          if (moveCatalogHorizontal(last, scroll, function(value) { last = value; }, -1)) return;
          if (Navigator.canmove('left')) Navigator.move('left');
          else Lampa.Controller.toggle('menu');
        },
        right: function() {
          if (musicPlayer.hasFocus() && musicPlayer.seek(15)) return;
          if (moveCatalogHorizontal(last, scroll, function(value) { last = value; }, 1)) return;
          if (Navigator.canmove('right')) Navigator.move('right');
        },
        up: function() {
          if (moveCatalogVertical(last, scroll, function(value) { last = value; }, -1)) return;
          if (Navigator.canmove('up')) Navigator.move('up');
          else Lampa.Controller.toggle('head');
        },
        down: function() {
          if (moveCatalogVertical(last, scroll, function(value) { last = value; }, 1)) return;
          if (Navigator.canmove('down')) Navigator.move('down');
        },
        back: this.back
      });
      Lampa.Controller.toggle('content');
    };

    this.pause = function() {};
    this.stop = function() {};
    this.render = function() { return html; };
    this.destroy = function() {
      if (network && network.clear) network.clear();
      scroll.destroy();
      html.remove();
    };
  }

  function MusicAlbumComponent(object) {
    var scroll = new Lampa.Scroll({ mask: false, over: true });
    var html = $('<div></div>');
    var body = $('<div class="lampac-music-page"></div>');
    var card = cardFromAny(object.card || object.movie || {});
    var last;
    var network;
    var _this = this;

    this.create = function() {
      scroll.append(body);
      html.append(scroll.render());
      this.activity.loader(true);
      this.load();
      return this.render();
    };

    this.load = function() {
      if (network && network.clear) network.clear();
      network = requestJSON(apiUrl('/vkmusic/album', {
        id: card.music_id || '',
        title: card.title || card.name || '',
        artist: card.music_artist || card.original_title || '',
        year: card.music_year || '',
        preview: card.music_preview || card.img || card.poster || '',
        source: card.music_source || '',
        track_url: card.music_track_url || '',
        duration: card.music_duration || ''
      }), function(album) {
        _this.activity.loader(false);
        _this.renderAlbum(album || {});
      }, function() {
        _this.activity.loader(false);
        _this.empty();
      }, 45000);
    };

    this.renderAlbum = function(album) {
      var cover = album.preview || card.img || card.poster || './img/img_broken.svg';
      var tracks = album.tracks || [];
      body.css('background-image', 'linear-gradient(90deg, rgba(9,16,19,.92), rgba(13,31,18,.76)), url("' + cover + '")');
      var header = $(
        '<div class="lampac-music-head">' +
          '<div class="lampac-music-head__cover"><img src="' + escapeHtml(cover) + '"></div>' +
          '<div class="lampac-music-head__body">' +
            '<div class="lampac-music-head__title">' + escapeHtml(album.title || card.title || 'Музыка') + '</div>' +
            '<div class="lampac-music-head__artist">' + escapeHtml(album.artist || card.music_artist || card.original_title || '') + '</div>' +
            '<div class="lampac-music-head__meta">' + escapeHtml([album.year, album.type].filter(Boolean).join(' • ')) + '</div>' +
            '<div class="lampac-music-head__descr">' + escapeHtml(shortText(album.description || card.description || card.overview || '', 260)) + '</div>' +
          '</div>' +
          '<div class="lampac-music-head__actions">' +
            '<div class="lampac-music-action lampac-music-action--play">Слушать</div>' +
          '</div>' +
        '</div>'
      );
      header.find('img').on('error', function() {
        this.style.display = 'none';
      });

      body.empty().append(header).append('<div class="lampac-music-inline-player"></div><div class="lampac-music-tracks"></div>');
      musicPlayer.attach(body.find('.lampac-music-inline-player'), album, card);
      musicPlayer.show((tracks && tracks[0]) || {
        title: album.title || card.music_title || card.title,
        artist: album.artist || card.music_artist || card.original_title,
        duration: card.music_duration || '',
        preview: cover
      }, card);
      last = false;

      header.on('hover:focus', function(e) {
        last = e.target;
        scroll.update(header, true);
      }).on('hover:enter', function() {
        playOnline((tracks && tracks[0]) || { title: album.title, artist: album.artist }, card, header, album);
      });

      header.find('.lampac-music-action--play').on('click hover:enter', function(e) {
        e.stopPropagation();
        playOnline((tracks && tracks[0]) || { title: album.title, artist: album.artist }, card, header, album);
      });

      if (!tracks.length) {
        body.find('.lampac-music-tracks').append('<div class="lampac-music-empty">Треки не найдены. Можно искать альбом в торрентах.</div>');
      }

      tracks.forEach(function(track) {
        var item = $(
          '<div class="lampac-music-track selector">' +
            '<div class="lampac-music-track__num">' + escapeHtml(track.index || '') + '</div>' +
            '<div class="lampac-music-track__title">' + escapeHtml(track.title || 'Трек') + '</div>' +
            '<div class="lampac-music-track__duration">' + escapeHtml(track.duration || '') + '</div>' +
            '<div class="lampac-music-track__play">Play</div>' +
          '</div>'
        );

        item.on('hover:focus', function(e) {
          last = e.target;
          scroll.update(item, true);
        }).on('hover:enter', function() {
          playOnline(track, card, item, album);
        });

        item.find('.lampac-music-track__play').on('click hover:enter', function(e) {
          e.stopPropagation();
          playOnline(track, card, item, album);
        });

        body.find('.lampac-music-tracks').append(item);
      });

      last = body.find('.lampac-music-track').eq(0)[0] || body.find('.lampac-music-player__button').eq(0)[0] || false;
      _this.activity.toggle();
    };

    this.empty = function() {
      var empty = new Lampa.Empty();
      body.empty().append(empty.render());
    };

    this.back = function() {
      Lampa.Activity.backward();
    };

    this.start = function() {
      if (Lampa.Activity.active().activity !== this.activity) return;
      Lampa.Background.immediately(card.img || card.poster || './img/img_broken.svg');
      Lampa.Controller.add('content', {
        toggle: function() {
          Lampa.Controller.collectionSet(scroll.render());
          Lampa.Controller.collectionFocus(last || false, scroll.render());
          if (last) scroll.update($(last), true);
        },
        left: function() {
          if (musicPlayer.hasFocus() && musicPlayer.seek(-15)) return;
          if (Navigator.canmove('left')) Navigator.move('left');
          else Lampa.Controller.toggle('menu');
        },
        right: function() {
          if (musicPlayer.hasFocus() && musicPlayer.seek(15)) return;
          Navigator.move('right');
        },
        up: function() {
          if (Navigator.canmove('up')) Navigator.move('up');
          else Lampa.Controller.toggle('head');
        },
        down: function() {
          if (Navigator.canmove('down')) Navigator.move('down');
        },
        back: this.back
      });
      Lampa.Controller.toggle('content');
    };

    this.pause = function() {};
    this.stop = function() {};
    this.render = function() { return html; };
    this.destroy = function() {
      if (network && network.clear) network.clear();
      scroll.destroy();
      html.remove();
    };
  }

  function currentMusicCard() {
    var active = Lampa.Activity && Lampa.Activity.active ? Lampa.Activity.active() : null;
    var candidates = [
      active && active.card,
      active && active.movie,
      active && active.activity && active.activity.card,
      active && active.activity && active.activity.movie,
      runtime.lastFullCard
    ];

    for (var i = 0; i < candidates.length; i++) {
      if (isMusicCard(candidates[i])) return cardFromAny(candidates[i]);
    }

    return null;
  }

  function makeButton(cls, label) {
    return $('<div class="full-start__button selector ' + cls + ' button--book" data-subtitle="' + label + '" aria-label="' + label + '"><span>' + label + '</span></div>');
  }

  function findButtonsContainer() {
    var selectors = ['.full-start-new__buttons', '.full-start__buttons', '.full-start__buttons-wrap', '.full-start__buttons-container'];

    for (var i = 0; i < selectors.length; i++) {
      var el = $(selectors[i]).filter(function() {
        return !!(this.offsetWidth || this.offsetHeight || this.getClientRects().length);
      }).first();
      if (el.length) return el;
    }

    return $();
  }

  function repairFullButtons() {
    var card = currentMusicCard();
    var container;
    var listen;

    if (!card) return;
    runtime.lastFullCard = card;
    container = findButtonsContainer();
    if (!container.length) return;

    listen = container.find('.view--lampac-music-listen');
    if (!listen.length) {
      listen = makeButton('view--lampac-music-listen', 'Слушать');
      container.prepend(listen);
    }

    listen.off('.lampac-music').on('hover:enter.lampac-music click.lampac-music', function() {
      openAlbum(card);
    });
  }

  function addStyles() {
    $('#lampac-music-style').remove();
    $('body').append(
      '<style id="lampac-music-style">' +
      '.lampac-music-catalog{min-height:100vh;padding:2.2em 0 5em;background:linear-gradient(90deg,rgba(10,16,18,.96),rgba(16,27,22,.86));overflow:visible}' +
      '.lampac-music-catalog__head{padding:0 1.6em;margin-bottom:.8em}' +
      '.lampac-music-catalog__title{font-size:2.05em;line-height:1.15;font-weight:600}' +
      '.lampac-music-catalog-row{margin-bottom:2.1em}' +
      '.lampac-music-catalog-row__title{font-size:1.55em;line-height:1.2;font-weight:500;margin:0 0 .55em 1em}' +
      '.lampac-music-catalog-row__items{display:flex;gap:1.15em;overflow-x:auto;overflow-y:hidden;padding:.65em 1.6em 1.25em;scroll-behavior:smooth;scrollbar-width:none}' +
      '.lampac-music-catalog-row__items::-webkit-scrollbar{display:none}' +
      '.lampac-music-card{width:13em;min-width:13em;flex-shrink:0}' +
      '.lampac-music-card__cover{position:relative;width:100%;padding-bottom:100%;border-radius:.42em;overflow:visible;background:rgba(255,255,255,.12);box-shadow:0 .8em 2em rgba(0,0,0,.22)}' +
      '.lampac-music-card__cover img{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;border-radius:.42em}' +
      '.lampac-music-card.focus .lampac-music-card__cover:after,.lampac-music-card:hover .lampac-music-card__cover:after{content:"";position:absolute;left:-.42em;top:-.42em;right:-.42em;bottom:-.42em;border:.24em solid #fff;border-radius:.82em;box-shadow:0 0 0 .12em rgba(0,0,0,.35)}' +
      '.lampac-music-card__title{font-size:1.05em;line-height:1.22;margin-top:.72em;font-weight:500;max-height:2.55em;overflow:hidden}' +
      '.lampac-music-card__meta{font-size:.84em;line-height:1.25;margin-top:.28em;opacity:.58;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.lampac-music-card.focus .lampac-music-card__title,.lampac-music-card:hover .lampac-music-card__title{font-weight:700}' +
      '.lampac-music-page{min-height:100vh;padding:2.4em 1.6em 5em;background-size:cover;background-position:center;background-attachment:fixed}' +
      '.lampac-music-head{position:relative;display:flex;gap:2em;min-height:12.5em;padding:1.15em 1.4em;border-radius:.5em;background:rgba(255,255,255,.09);border:2px solid transparent;margin-bottom:1.4em;box-shadow:0 1.2em 3em rgba(0,0,0,.22);backdrop-filter:blur(10px)}' +
      '.lampac-music-head.focus,.lampac-music-head:hover{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.32)}' +
      '.lampac-music-head__cover{width:11.5em;min-width:11.5em;height:11.5em;border-radius:.45em;background:rgba(255,255,255,.08);overflow:hidden}' +
      '.lampac-music-head__cover img{width:100%;height:100%;object-fit:cover}' +
      '.lampac-music-head__body{min-width:0;flex:1;padding-right:10em}' +
      '.lampac-music-head__title{font-size:2.1em;line-height:1.12;font-weight:700;margin-bottom:.25em}' +
      '.lampac-music-head__artist{font-size:1.35em;opacity:.75;margin-bottom:.35em}' +
      '.lampac-music-head__meta{font-size:1em;opacity:.52;margin-bottom:.7em}' +
      '.lampac-music-head__descr{font-size:1em;line-height:1.35;opacity:.58}' +
      '.lampac-music-head__actions{display:none!important}' +
      '.lampac-music-action{padding:.72em 1.05em;border-radius:.42em;background:#fff;color:#111;font-weight:800;white-space:nowrap}' +
      '.lampac-music-inline-player{display:flex;align-items:center;gap:1em;margin-bottom:1em;padding:.85em 1em;border-radius:.45em;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.1)}' +
      '.lampac-music-player__cover{width:4em;min-width:4em;height:4em;border-radius:.35em;overflow:hidden;background:rgba(255,255,255,.08)}' +
      '.lampac-music-player__cover img{width:100%;height:100%;object-fit:cover}' +
      '.lampac-music-player__main{min-width:0;flex:1}' +
      '.lampac-music-player__title{font-size:1.15em;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.lampac-music-player__artist{font-size:.9em;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.lampac-music-player__time{width:4.5em;text-align:right;opacity:.65}' +
      '.lampac-music-player__button{width:2.8em;height:2.8em;padding:0;border-radius:.35em;background:#fff;color:#111;font-weight:800;display:flex;align-items:center;justify-content:center;position:relative;flex-shrink:0}' +
      '.lampac-music-player__button span{display:none}' +
      '.lampac-music-player__button:before{content:"";display:block;width:0;height:0;border-top:.48em solid transparent;border-bottom:.48em solid transparent;border-left:.72em solid currentColor;margin-left:.12em}' +
      '.lampac-music-inline-player.is-play .lampac-music-player__button:before{width:.22em;height:1em;border:0;background:currentColor;box-shadow:.44em 0 0 currentColor;margin-left:-.22em}' +
      '.lampac-music-inline-player.is-loading .lampac-music-player__button:before{width:1.05em;height:1.05em;border:.18em solid currentColor;border-right-color:transparent;border-radius:50%;margin:0;animation:lampacMusicSpin .8s linear infinite}' +
      '.lampac-music-player__button.focus,.lampac-music-action.focus{box-shadow:0 0 0 .18em rgba(255,255,255,.55);transform:scale(1.03)}' +
      '.lampac-music-inline-player.is-loading .lampac-music-player__button{opacity:.65}' +
      '.lampac-music-wave{height:1.5em;margin-top:.45em;display:flex;align-items:center;gap:.18em}' +
      '.lampac-music-wave i{display:block;width:.16em;height:20%;background:#fff;opacity:.35;border-radius:.12em;transition:height .08s linear,opacity .12s}' +
      '.lampac-music-inline-player.is-play .lampac-music-wave i{opacity:.9}' +
      '.lampac-music-progress{position:relative;height:.42em;margin-top:.45em;border-radius:.4em;background:rgba(255,255,255,.22);overflow:hidden}' +
      '.lampac-music-progress i{position:absolute;left:0;top:0;bottom:0;width:0;background:#fff;border-radius:inherit}' +
      '.lampac-music-progress span{position:absolute;right:0;top:-1.55em;font-size:.72em;opacity:.55}' +
      '.lampac-music-track{display:flex;align-items:center;gap:1em;padding:.9em 1.1em;border-radius:.25em;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.015)}' +
      '.lampac-music-track.focus,.lampac-music-track:hover{background:#fff;color:#111}' +
      '.lampac-music-track.is-loading{opacity:.65}' +
      '.lampac-music-track__num{width:2.5em;opacity:.6;font-weight:700}' +
      '.lampac-music-track__title{flex:1;min-width:0;font-size:1.08em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.lampac-music-track__duration{width:5em;text-align:right;opacity:.6}' +
      '.lampac-music-track__play{width:2.25em;height:2.25em;padding:0;border-radius:.3em;background:rgba(255,255,255,.16);font-size:0;position:relative;display:flex;align-items:center;justify-content:center;flex-shrink:0}' +
      '.lampac-music-track__play:before{content:"";display:block;width:0;height:0;border-top:.36em solid transparent;border-bottom:.36em solid transparent;border-left:.55em solid currentColor;margin-left:.1em}' +
      '.lampac-music-track.focus .lampac-music-track__play,.lampac-music-track:hover .lampac-music-track__play{background:#111;color:#fff}' +
      '.lampac-music-empty{padding:2em;opacity:.6;text-align:center}' +
      '@keyframes lampacMusicSpin{to{transform:rotate(360deg)}}' +
      '.view--lampac-music-listen{display:flex!important;align-items:center;justify-content:center;opacity:1!important}' +
      '</style>'
    );
  }

  function addMenuButton() {
    var list = $('.menu .menu__list').eq(0);
    if (!list.length || list.find('.menu__item[data-action="lampac-vk-music"]').length) return;

    var icon = '<svg width="60" height="60" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3v10.6A4 4 0 1 0 14 17V7h4V3h-6Z"/></svg>';
    var button = $('<li data-action="lampac-vk-music" class="menu__item selector"><div class="menu__ico">' + icon + '</div><div class="menu__text">ВК Музыка</div></li>');
    button.on('hover:enter', openCatalog);
    list.append(button);
  }

  function installFullWatcher() {
    if (runtime.observer) return;

    runtime.observer = new MutationObserver(function() {
      repairFullButtons();
    });

    try {
      runtime.observer.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}

    Lampa.Listener.follow('full', function() {
      setTimeout(repairFullButtons, 150);
      setTimeout(repairFullButtons, 700);
    });
  }

  function init() {
    addStyles();
    registerMusicSource();
    registerSearchSource();
    Lampa.Component.add(SETUP_COMPONENT, VKMusicSetupComponent);
    Lampa.Component.add(CATALOG_COMPONENT, MusicSquareCatalogComponent);
    Lampa.Component.add(COMPONENT, MusicAlbumComponent);
    addMenuButton();
    installFullWatcher();
    window.lampacVkMusicOpen = openCatalog;
  }

  if (window.appready) {
    init();
  } else {
    Lampa.Listener.follow('app', function(e) {
      if (e.type == 'ready') init();
    });
  }
})();
