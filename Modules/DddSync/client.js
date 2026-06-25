(function () {
  'use strict';

  var VERSION = 'v1.1.0-cwu-bridge';
  var READY_KEY = '__DDD_SYNC_CLIENT_READY__';
  var VERSION_KEY = '__DDD_SYNC_CLIENT_VERSION__';

  if (window[READY_KEY] && window[VERSION_KEY] === VERSION) return;

  var DEVICE_KEY = 'ddd_sync_device_id_v1';
  var CURSOR_KEY = 'ddd_sync_cursor_v1';
  var SEEN_KEY = 'ddd_sync_timeline_seen_v1';
  var LAST_ITEMS_KEY = 'ddd_sync_last_items_v1';
  var CW_STORAGE_BASE_KEY = 'continue_watch_params';

  var lastItems = [];
  var originalPlay = null;
  var patchedPlayer = false;
  var lastLaunchByKey = {};

  function now() {
    return Date.now ? Date.now() : new Date().getTime();
  }

  function log(message, error) {
    try {
      if (window.console && console.log) console.log(message, error || '');
    } catch (e) { }
  }

  function isObject(value) {
    return value && typeof value === 'object';
  }

  function firstNonEmpty() {
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== '') return arguments[i];
    }
    return '';
  }

  function safeNumber(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : Number(fallback || 0);
  }

  function clamp(value, min, max) {
    value = safeNumber(value, 0);
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function storageGet(key, fallback) {
    try {
      var value = localStorage.getItem(key);
      return value == null ? fallback : value;
    } catch (e) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { }
  }

  function hashString(value) {
    value = String(value || '');

    try {
      if (window.Lampa && Lampa.Utils && Lampa.Utils.hash) return String(Lampa.Utils.hash(value));
    } catch (e) { }

    var hash = 0;
    for (var i = 0; i < value.length; i++) {
      hash = ((hash << 5) - hash) + value.charCodeAt(i);
      hash = hash & hash;
    }
    return String(Math.abs(hash));
  }

  function getDeviceId() {
    var id = storageGet(DEVICE_KEY, '');
    if (id) return id;

    id = 'lampa_' + hashString([
      window.location && window.location.host || '',
      navigator && navigator.userAgent || '',
      now(),
      Math.random()
    ].join('|'));

    storageSet(DEVICE_KEY, id);
    return id;
  }

  function scriptBase() {
    var src = '';
    try {
      src = document.currentScript && document.currentScript.src || '';
      if (!src) {
        var scripts = document.getElementsByTagName('script');
        for (var i = scripts.length - 1; i >= 0; i--) {
          if ((scripts[i].src || '').indexOf('/ddd-sync/v1/client.js') >= 0) {
            src = scripts[i].src;
            break;
          }
        }
      }
      if (src) {
        var a = document.createElement('a');
        a.href = src;
        return a.protocol + '//' + a.host + '/ddd-sync/v1';
      }
    } catch (e) { }

    return window.location.protocol + '//' + window.location.host + '/ddd-sync/v1';
  }

  var BASE = scriptBase();

  function remoteEventsUrl() {
    return BASE + '/events';
  }

  function remoteLatestUrl() {
    return BASE + '/latest';
  }

  function stripFragment(url) {
    url = String(url || '');
    var pos = url.indexOf('#');
    return pos >= 0 ? url.slice(0, pos) : url;
  }

  function decodePart(value) {
    try { return decodeURIComponent(String(value || '').replace(/\+/g, ' ')); } catch (e) { return String(value || ''); }
  }

  function encodePart(value) {
    return encodeURIComponent(String(value == null ? '' : value));
  }

  function parseFragment(fragment) {
    var result = [];
    var parts = String(fragment || '').replace(/^#/, '').split('&');

    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;

      var eq = parts[i].indexOf('=');
      result.push({
        key: decodePart(eq >= 0 ? parts[i].slice(0, eq) : parts[i]),
        value: decodePart(eq >= 0 ? parts[i].slice(eq + 1) : '')
      });
    }

    return result;
  }

  function setFragmentParam(params, key, value) {
    if (value === undefined || value === null || value === '') return;

    for (var i = 0; i < params.length; i++) {
      if (params[i].key === key) {
        params[i].value = value;
        return;
      }
    }

    params.push({ key: key, value: value });
  }

  function buildFragment(params) {
    var out = [];
    for (var i = 0; i < params.length; i++) {
      if (!params[i].key) continue;
      out.push(encodePart(params[i].key) + '=' + encodePart(params[i].value));
    }
    return out.join('&');
  }

  function appendFragmentParams(url, paramsMap) {
    var raw = String(url || '');
    if (!raw) return raw;

    var hashIndex = raw.indexOf('#');
    var base = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
    var fragment = hashIndex >= 0 ? raw.slice(hashIndex + 1) : '';
    var params = parseFragment(fragment);

    for (var key in paramsMap) {
      if (Object.prototype.hasOwnProperty.call(paramsMap, key)) setFragmentParam(params, key, paramsMap[key]);
    }

    var built = buildFragment(params);
    return built ? base + '#' + built : base;
  }

  function queryParam(url, key) {
    var re = new RegExp('[?&]' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^&#]*)');
    var match = String(url || '').match(re);
    return match ? decodePart(match[1]) : '';
  }

  function parseStreamUrl(url) {
    url = stripFragment(url || '');

    var fileMatch = url.match(/\/stream\/([^?]+)/);
    var link = queryParam(url, 'link');
    var index = queryParam(url, 'index');

    if (!fileMatch && !link) return null;

    return {
      file_name: fileMatch ? decodePart(fileMatch[1]).replace(/\+/g, ' ') : '',
      torrent_link: link,
      file_index: index !== '' ? safeNumber(index, 0) : 0
    };
  }

  function streamIdentity(url) {
    var parsed = parseStreamUrl(url);
    if (parsed) return [parsed.torrent_link || '', parsed.file_index || 0, parsed.file_name || ''].join('|');
    return stripFragment(url || '');
  }

  function getActivityMovie() {
    try {
      var activity = window.Lampa && Lampa.Activity && Lampa.Activity.active ? Lampa.Activity.active() : null;
      if (activity && activity.movie) return activity.movie;
      if (activity && activity.card) return activity.card;
      if (activity && activity.params && activity.params.movie) return activity.params.movie;
    } catch (e) { }
    return null;
  }

  function getMovieFromData(data) {
    data = data || {};
    return data.card || data.movie || data.card_data || data.data || getActivityMovie() || data;
  }

  function getMovieTitle(movie) {
    movie = movie || {};
    return String(firstNonEmpty(
      movie.original_name,
      movie.original_title,
      movie.name,
      movie.title,
      movie.originalName,
      movie.originalTitle
    ));
  }

  function getMediaKind(movie) {
    movie = movie || {};
    var media = String(firstNonEmpty(movie.media_type, movie.mediaType)).toLowerCase();
    if (media === 'movie' || media === 'film') return 'movie';
    if (media === 'tv' || media === 'show' || media === 'series') return 'tv';
    if (movie.number_of_seasons || movie.number_of_episodes || movie.seasons || movie.episodes || movie.original_name) return 'tv';
    return 'movie';
  }

  function getPlaylistIndex(data, playlist, url) {
    data = data || {};
    if (data.playlist_index !== undefined) return safeNumber(data.playlist_index, 0);
    if (data.start_index !== undefined) return safeNumber(data.start_index, 0);
    if (data.windowIndex !== undefined) return safeNumber(data.windowIndex, 0);

    var parsed = parseStreamUrl(url);
    if (parsed) return safeNumber(parsed.file_index, 0);

    return 0;
  }

  function getPlaylistItem(data, index) {
    data = data || {};
    if (data.currentItem) return data.currentItem;
    if (data.item) return data.item;
    if (data.file) return data.file;
    if (data.playlist && data.playlist.length) {
      index = safeNumber(index, 0);
      if (index < 0) index = 0;
      if (index >= data.playlist.length) index = data.playlist.length - 1;
      return data.playlist[index] || null;
    }
    return null;
  }

  function extractSEFromText(text, fallbackSeason) {
    text = decodePart(text || '').replace(/\+/g, ' ');
    var m = text.match(/\bS(?:eason)?\s*0?(\d{1,2})\s*[\.\-_: ]*\s*E(?:p(?:isode)?)?\s*0?(\d{1,3})\b/i);
    if (m) return { season: safeNumber(m[1], 0), episode: safeNumber(m[2], 0) };

    m = text.match(/\b0?(\d{1,2})\s*[xX]\s*0?(\d{1,3})\b/);
    if (m) return { season: safeNumber(m[1], 0), episode: safeNumber(m[2], 0) };

    m = text.match(/(?:episode|ep\.?)\s*[-_: ]*0?(\d{1,3})/i);
    if (m && fallbackSeason) return { season: fallbackSeason, episode: safeNumber(m[1], 0) };

    return { season: 0, episode: 0 };
  }

  function inferSeasonEpisode(data, movie, item, playlistIndex, url) {
    data = data || {};
    item = item || {};

    var season = safeNumber(firstNonEmpty(data.season, data.season_number, data.s, item.season, item.season_number, item.s), 0);
    var episode = safeNumber(firstNonEmpty(data.episode, data.episode_number, data.e, item.episode, item.episode_number, item.e), 0);

    if (season && episode) return { season: season, episode: episode };

    var fallbackSeason = season || (getMediaKind(movie) === 'tv' ? 1 : 0);
    var text = [
      item.title,
      item.name,
      item.filename,
      item.file_name,
      data.title,
      data.episode_title,
      url
    ].join(' ');
    var parsed = extractSEFromText(text, fallbackSeason);

    if (parsed.season && parsed.episode) return parsed;
    if (getMediaKind(movie) === 'tv' && playlistIndex >= 0) return { season: fallbackSeason || 1, episode: safeNumber(playlistIndex, 0) + 1 };

    return { season: 0, episode: 0 };
  }

  function generateTimelineHash(movie, season, episode) {
    var title = getMovieTitle(movie);
    if (!title) return '';

    season = safeNumber(season, 0);
    episode = safeNumber(episode, 0);

    if (season > 0 && episode > 0) {
      return hashString([season, season > 10 ? ':' : '', episode, title].join(''));
    }

    return hashString(title);
  }

  function timelineView(hash) {
    try {
      if (hash && window.Lampa && Lampa.Timeline && Lampa.Timeline.view) return Lampa.Timeline.view(hash);
    } catch (e) { }
    return null;
  }

  function timelinePayload(hash, data) {
    var timeline = timelineView(hash) || (data && data.timeline) || {};
    var time = safeNumber(timeline.time, safeNumber(data && data.time, 0));
    var duration = safeNumber(timeline.duration, safeNumber(data && data.duration, 0));
    var percent = safeNumber(timeline.percent, safeNumber(data && data.percent, 0));

    if (!percent && time && duration) percent = Math.round(time / duration * 100);

    return {
      position: Math.max(0, Math.round(time * 1000)),
      duration: Math.max(0, Math.round(duration * 1000)),
      percent: clamp(percent, 0, 100)
    };
  }

  function buildContentKey(movie, season, episode, timelineHash, url) {
    movie = movie || {};
    var id = firstNonEmpty(movie.id, movie.movie_id, movie.tmdb_id, movie.tmdbId);

    if (id) {
      if (season && episode) return 'tmdb:' + id + ':s' + season + ':e' + episode;
      return 'tmdb:' + id;
    }

    if (timelineHash) return 'timeline:' + timelineHash;
    if (url) return 'url:' + hashString(streamIdentity(url));
    return '';
  }

  function buildMetadata(input, overrides) {
    input = input || {};
    overrides = overrides || {};

    var data = isObject(input) ? input : { url: String(input || '') };
    var url = stripFragment(firstNonEmpty(overrides.url, data.url, data.uri, data.src));
    var movie = overrides.movie || getMovieFromData(data);
    var playlist = data.playlist || [];
    var playlistIndex = safeNumber(firstNonEmpty(overrides.playlistIndex, data.playlist_index, data.start_index, data.windowIndex), 0);

    if (playlistIndex === 0 && url) playlistIndex = getPlaylistIndex(data, playlist, url);

    var item = overrides.currentItem || getPlaylistItem(data, playlistIndex) || {};
    if (!url) url = stripFragment(firstNonEmpty(item.url, item.uri, item.src));

    var se = inferSeasonEpisode(data, movie, item, playlistIndex, url);
    var parsed = parseStreamUrl(url);
    var timelineHash = firstNonEmpty(
      overrides.timelineHash,
      data.timelineHash,
      data.ddd_timeline_hash,
      data.timeline && data.timeline.hash,
      generateTimelineHash(movie, se.season, se.episode)
    );

    var road = timelinePayload(timelineHash, data);
    var filename = firstNonEmpty(overrides.filename, data.filename, data.file_name, item.filename, item.file_name, parsed && parsed.file_name);
    var title = firstNonEmpty(overrides.title, data.title, data.episode_title, item.title, item.name, getMovieTitle(movie), filename);
    var sourceKey = firstNonEmpty(overrides.sourceKey, data.sourceKey, data.ddd_source_key, url ? streamIdentity(url) : '');

    var meta = {
      deviceId: getDeviceId(),
      sessionId: firstNonEmpty(overrides.sessionId, data.sessionId, data.ddd_sid, data.bridge_session_id, 'lampa_' + hashString([timelineHash, sourceKey, now()].join('|'))),
      contentKey: firstNonEmpty(overrides.contentKey, data.contentKey, data.ddd_content_key, buildContentKey(movie, se.season, se.episode, timelineHash, url)),
      sourceKey: sourceKey,
      timelineHash: timelineHash,
      sourceKind: firstNonEmpty(overrides.sourceKind, data.sourceKind, data.ddd_source_kind, parsed ? 'torrserver' : 'stream'),
      uri: url,
      title: title,
      filename: filename,
      position: road.position,
      duration: road.duration,
      percent: road.percent,
      windowIndex: playlistIndex,
      playlistSize: playlist && playlist.length ? playlist.length : safeNumber(data.playlistSize, 0),
      season: se.season,
      episode: se.episode,
      movieId: firstNonEmpty(movie && movie.id, movie && movie.movie_id, movie && movie.tmdb_id, movie && movie.tmdbId),
      mediaType: getMediaKind(movie)
    };

    return meta;
  }

  function payloadFromMetadata(meta, reason) {
    return {
      position: safeNumber(meta.position, 0),
      duration: safeNumber(meta.duration, 0),
      windowIndex: safeNumber(meta.windowIndex, 0),
      playlistSize: safeNumber(meta.playlistSize, 0),
      isPlaying: false,
      reason: reason || 'lampa_launch',
      percent: safeNumber(meta.percent, 0)
    };
  }

  function contextFromMetadata(meta) {
    return {
      contentKey: meta.contentKey || '',
      sourceKey: meta.sourceKey || '',
      timelineHash: meta.timelineHash || '',
      sourceKind: meta.sourceKind || '',
      uri: meta.uri || '',
      title: meta.title || '',
      filename: meta.filename || ''
    };
  }

  function postJson(path, body, callback) {
    var xhr;
    try {
      xhr = new XMLHttpRequest();
      xhr.open('POST', BASE + path, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        var json = null;
        try { json = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (e) { }
        if (callback) callback(xhr.status >= 200 && xhr.status < 300 ? null : new Error('HTTP ' + xhr.status), json);
      };
      xhr.onerror = function () {
        if (callback) callback(new Error('network error'), null);
      };
      xhr.send(JSON.stringify(body));
    } catch (e) {
      if (callback) callback(e, null);
    }
  }

  function sendEvent(type, input, payload, callback) {
    var meta = buildMetadata(input || {});
    if (!meta.contentKey && !meta.sourceKey && !meta.uri) {
      if (callback) callback(new Error('missing content identity'), null);
      return false;
    }

    payload = payload || payloadFromMetadata(meta, type === 'session_started' ? 'lampa_launch' : type);

    postJson('/events', {
      schema: 1,
      deviceId: meta.deviceId,
      events: [{
        schema: 1,
        type: type || 'session_started',
        client: 'lampa',
        sessionId: meta.sessionId,
        ts: now(),
        context: contextFromMetadata(meta),
        payload: payload
      }]
    }, callback);

    return true;
  }

  function sendLaunchState(input) {
    var meta = buildMetadata(input || {});
    var key = [meta.deviceId, meta.contentKey || meta.sourceKey || meta.uri, meta.sessionId].join('|');
    var current = now();

    if (lastLaunchByKey[key] && current - lastLaunchByKey[key] < 2000) return false;

    lastLaunchByKey[key] = current;
    return sendEvent('session_started', meta, payloadFromMetadata(meta, 'lampa_launch'));
  }

  function launchParams(meta) {
    return {
      ddd_remote_events_url: remoteEventsUrl(),
      ddd_remote_latest_url: remoteLatestUrl(),
      ddd_remote_schema: 1,
      ddd_device_id: meta.deviceId || getDeviceId(),
      ddd_content_key: meta.contentKey,
      ddd_source_key: meta.sourceKey,
      ddd_timeline_hash: meta.timelineHash,
      ddd_source_kind: meta.sourceKind,
      ddd_title: meta.title,
      ddd_filename: meta.filename,
      ddd_lampa_position: meta.position,
      ddd_lampa_duration: meta.duration,
      ddd_lampa_percent: meta.percent
    };
  }

  function appendLaunchParams(url, metadata) {
    var meta = buildMetadata(metadata || { url: url }, { url: stripFragment(url) });
    return appendFragmentParams(url, launchParams(meta));
  }

  function prepareLaunch(url, metadata) {
    var meta = buildMetadata(metadata || { url: url }, { url: stripFragment(url) });
    sendLaunchState(meta);
    return appendFragmentParams(url, launchParams(meta));
  }

  function patchPlaylist(data, parentMeta) {
    if (!data || !data.playlist || !data.playlist.length) return;

    for (var i = 0; i < data.playlist.length; i++) {
      var item = data.playlist[i];
      if (!item || typeof item !== 'object') continue;

      var itemUrl = item.url || item.uri || item.src || '';
      if (!itemUrl) continue;

      var meta = buildMetadata(data, {
        url: stripFragment(itemUrl),
        currentItem: item,
        playlistIndex: i,
        sessionId: parentMeta.sessionId
      });
      var patched = appendFragmentParams(itemUrl, launchParams(meta));

      if (item.url !== undefined) item.url = patched;
      else if (item.uri !== undefined) item.uri = patched;
      else if (item.src !== undefined) item.src = patched;
    }
  }

  function patchLampaPlayer() {
    if (patchedPlayer) return true;
    if (!window.Lampa || !Lampa.Player || !Lampa.Player.play) return false;
    if (Lampa.Player.__DddSyncPatched) {
      patchedPlayer = true;
      return true;
    }

    originalPlay = Lampa.Player.play;

    Lampa.Player.play = function (data) {
      try {
        data = data || {};
        var meta = buildMetadata(data);

        data.ddd_remote_events_url = remoteEventsUrl();
        data.ddd_remote_latest_url = remoteLatestUrl();
        data.ddd_device_id = meta.deviceId;
        data.ddd_content_key = meta.contentKey;
        data.ddd_source_key = meta.sourceKey;
        data.ddd_timeline_hash = meta.timelineHash;

        if (data.url) data.url = appendFragmentParams(data.url, launchParams(meta));
        if (data.uri) data.uri = appendFragmentParams(data.uri, launchParams(meta));
        if (data.src) data.src = appendFragmentParams(data.src, launchParams(meta));

        patchPlaylist(data, meta);
        sendLaunchState(meta);
      } catch (e) {
        log('[DddSync] player patch failed', e && e.message || e);
      }

      return originalPlay.apply(this, arguments);
    };

    Lampa.Player.__DddSyncPatched = true;
    Lampa.Player.__DddSyncOriginalPlay = originalPlay;
    patchedPlayer = true;
    return true;
  }

  function readSeen() {
    try { return JSON.parse(storageGet(SEEN_KEY, '{}')) || {}; } catch (e) { return {}; }
  }

  function writeSeen(seen) {
    storageSet(SEEN_KEY, JSON.stringify(seen || {}));
  }

  function toSeconds(ms) {
    var n = safeNumber(ms, 0);
    if (n < 0) return 0;
    return Math.round(n / 1000);
  }

  function percent(position, duration, finished) {
    if (finished) return 100;
    var p = safeNumber(position, 0);
    var d = safeNumber(duration, 0);
    if (!d) return 0;
    return clamp(Math.round(p / d * 100), 0, 100);
  }

  function sameTimeline(local, value) {
    if (!local) return false;
    return safeNumber(local.percent, 0) === safeNumber(value.percent, 0) &&
      safeNumber(local.time, 0) === safeNumber(value.time, 0) &&
      safeNumber(local.duration, 0) === safeNumber(value.duration, 0);
  }

  function updateTimeline(item, seen) {
    if (!item || !item.timelineHash) return false;
    if (!window.Lampa || !Lampa.Timeline || !Lampa.Timeline.update) return false;

    var hash = item.timelineHash;
    var updatedAt = safeNumber(item.updatedAt, 0);
    var value = {
      hash: hash,
      percent: percent(item.position, item.duration, item.finished),
      time: toSeconds(item.position),
      duration: toSeconds(item.duration),
      received: true
    };

    try {
      var local = Lampa.Timeline.view ? Lampa.Timeline.view(hash) : null;
      if (seen[hash] && updatedAt && safeNumber(seen[hash], 0) >= updatedAt && sameTimeline(local, value)) return false;

      Lampa.Timeline.update(value);
      seen[hash] = updatedAt || now();
      return true;
    } catch (e) {
      log('[DddSync] timeline update failed', e && e.message || e);
      return false;
    }
  }

  function parseContentKey(contentKey) {
    var out = { movieId: '', season: 0, episode: 0, mediaType: '' };
    var m = String(contentKey || '').match(/^tmdb:([^:]+)(?::s(\d+):e(\d+))?/i);
    if (!m) return out;

    out.movieId = m[1] || '';
    out.season = safeNumber(m[2], 0);
    out.episode = safeNumber(m[3], 0);
    out.mediaType = out.season && out.episode ? 'tv' : 'movie';
    return out;
  }

  function getContinueWatchStorageKey() {
    var base = CW_STORAGE_BASE_KEY;

    try {
      if (window.ContinueWatchUniversal && ContinueWatchUniversal.config && ContinueWatchUniversal.config.storageBaseKey) {
        base = ContinueWatchUniversal.config.storageBaseKey;
      }
    } catch (e) { }

    try {
      if (
        window.Lampa &&
        Lampa.Account &&
        Lampa.Account.Permit &&
        Lampa.Account.Permit.sync &&
        Lampa.Account.Permit.account &&
        Lampa.Account.Permit.account.profile &&
        Lampa.Account.Permit.account.profile.id !== undefined
      ) {
        return base + '_' + Lampa.Account.Permit.account.profile.id;
      }
    } catch (e2) { }

    return base;
  }

  function saveContinueWatchRecord(item) {
    if (!item || !item.timelineHash || !window.Lampa || !Lampa.Storage) return false;

    var key = getContinueWatchStorageKey();
    var parsedKey = parseContentKey(item.contentKey);
    var stream = parseStreamUrl(item.uri || '');
    var time = toSeconds(item.position);
    var duration = toSeconds(item.duration);
    var pct = percent(item.position, item.duration, item.finished);
    var hash = item.timelineHash;

    try { Lampa.Storage.sync(key, 'object_object'); } catch (e) { }

    try {
      var params = Lampa.Storage.get(key, {}) || {};
      var old = params[hash] || {};
      var record = {};

      for (var prop in old) {
        if (Object.prototype.hasOwnProperty.call(old, prop)) record[prop] = old[prop];
      }

      record.url = stripFragment(item.uri || old.url || '');
      record.uri = record.url;
      record.src = record.url;
      record.title = item.title || old.title || '';
      record.episode_title = item.title || old.episode_title || '';
      record.movie_id = parsedKey.movieId || old.movie_id || old.tmdb_id || '';
      record.tmdb_id = parsedKey.movieId || old.tmdb_id || old.movie_id || '';
      record.media_type = parsedKey.mediaType || old.media_type || '';
      record.season = parsedKey.season || old.season || 0;
      record.episode = parsedKey.episode || old.episode || 0;
      record.playlist_index = safeNumber(item.windowIndex, safeNumber(old.playlist_index, 0));
      record.file_index = stream ? stream.file_index : safeNumber(item.windowIndex, safeNumber(old.file_index, 0));
      record.file_name = item.filename || (stream && stream.file_name) || old.file_name || '';
      record.torrent_link = stream ? stream.torrent_link : old.torrent_link || '';
      record.time = time;
      record.duration = duration;
      record.percent = pct;
      record.last_source = 'ddd-sync';
      record.last_event_type = item.reason || '';
      record.last_reason = item.endBy || item.reason || '';
      record.timestamp = safeNumber(item.updatedAt, now());
      if (!record.original_timestamp) record.original_timestamp = record.timestamp;

      params[hash] = record;

      if (record.movie_id) {
        if (!params.__last_by_movie) params.__last_by_movie = {};
        params.__last_by_movie['id:' + record.movie_id] = {
          hash: hash,
          season: safeNumber(record.season, 0),
          episode: safeNumber(record.episode, 0),
          media_type: record.media_type || '',
          timestamp: record.timestamp
        };
      }

      Lampa.Storage.set(key, params);
      return true;
    } catch (err) {
      log('[DddSync] continue storage update failed', err && err.message || err);
      return false;
    }
  }

  function fetchJson(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;

        var data = {};
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch (e) {
          reject(new Error('invalid JSON response'));
          return;
        }

        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(data && data.error ? data.error : ('HTTP ' + xhr.status)));
          return;
        }

        resolve(data);
      };
      xhr.onerror = function () { reject(new Error('network error')); };
      xhr.send(null);
    });
  }

  function reconcile(options) {
    options = options || {};

    var since = options.incremental ? safeNumber(storageGet(CURSOR_KEY, '0'), 0) : 0;
    var limit = safeNumber(options.limit, 200) || 200;
    var url = BASE + '/latest?since=' + encodePart(since) + '&limit=' + encodePart(limit);

    return fetchJson(url).then(function (data) {
      var items = data.items || [];
      var seen = readSeen();

      lastItems = items;
      storageSet(LAST_ITEMS_KEY, JSON.stringify(items));

      for (var i = 0; i < items.length; i++) {
        if (items[i].timelineHash) updateTimeline(items[i], seen);
        saveContinueWatchRecord(items[i]);
      }

      writeSeen(seen);
      if (data.cursor) storageSet(CURSOR_KEY, String(data.cursor));
      return items;
    }).catch(function (e) {
      log('[DddSync] reconcile failed', e && e.message || e);
      return [];
    });
  }

  function latestItems() {
    if (lastItems.length) return lastItems.slice();
    try { return JSON.parse(storageGet(LAST_ITEMS_KEY, '[]')) || []; } catch (e) { return []; }
  }

  function boot() {
    patchLampaPlayer();
    reconcile({ full: true });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) reconcile({ full: true });
    });

    window.addEventListener('focus', function () {
      reconcile({ full: true });
    });
  }

  window.DddSync = {
    version: VERSION,
    baseUrl: function () { return BASE; },
    getDeviceId: getDeviceId,
    getRemoteEventsUrl: remoteEventsUrl,
    getRemoteLatestUrl: remoteLatestUrl,
    buildMetadata: buildMetadata,
    appendLaunchParams: appendLaunchParams,
    prepareLaunch: prepareLaunch,
    sendLaunchState: sendLaunchState,
    sendEvent: sendEvent,
    reconcile: reconcile,
    getLatestItems: latestItems,
    latestItems: latestItems,
    patchLampaPlayer: patchLampaPlayer
  };

  window[READY_KEY] = true;
  window[VERSION_KEY] = VERSION;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
