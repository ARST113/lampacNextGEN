(function () {
  'use strict';

  if (window.pidtor_nextgen_plugin) return;
  window.pidtor_nextgen_plugin = true;
window.pidtor_nextgen_build = '20261001-64-unnamed-voice';

  var API = '{localhost}';
  var TOKEN = '{token}';
  var gstLoading = false;
  var gstWaiters = [];
  var playbackMonitor = null;
  var playerControlsGeneration = 0;
  var activeControlsData = null;
  var playbackRequestGeneration = 0;

  function ownsPlayer(data) {
    return !!data && data === activeControlsData;
  }
  var warmCache = {};
  var warmWaiters = {};
  var verifiedGstCache = {};
  var verifiedGstWaiters = {};
  var failedGstCache = {};
  var directWarmCache = {};
  var directWarmWaiters = {};
  var cardWarmTimer = null;
  var cardWarmGeneration = 0;
  var warmCacheTtl = 10 * 60 * 1000;
  var failedGstCacheTtl = 30 * 1000;
  var apiCache = {};
  var apiCacheTtl = 5 * 60 * 1000;
  var episodeResolutionCache = {};
  var episodeResolutionOrder = [];
  var episodeResolutionCacheTtl = 15 * 60 * 1000;
  var episodeResolutionCacheLimit = 100;
  var probeCache = {};
  var probeOrder = [];
  var probeWaiters = {};
  var probeQueue = [];
  var probeActive = 0;
  var probeCacheTtl = 5 * 60 * 1000;
  var probeFailureTtl = 30 * 1000;
  var probeCacheLimit = 100;

  function cloneMetadata(value) {
    return value ? JSON.parse(JSON.stringify(value)) : value;
  }

  function sourceFile(record) {
    try {
      var base = new URL(String(API).replace(/\/$/, '') + '/');
      var url = new URL(account(record.url), base);
      var path = base.pathname.replace(/\/$/, '') + '/lite/pidtor/s';
      if (url.origin !== base.origin || url.pathname.indexOf(path) !== 0) return null;
      var hash = url.pathname.slice(path.length).toLowerCase();
      if (!/^(?:[a-f0-9]{40}|[a-z2-7]{32})$/.test(hash)) return null;
      var indexValue = url.searchParams.get('tsid');
      if (indexValue === null) indexValue = url.searchParams.get('fileindex');
      if (indexValue === null) indexValue = '1';
      if (!/^[1-9]\d*$/.test(indexValue) || Number(indexValue) > 32767) return null;
      var trackers = url.searchParams.getAll('tr');
      var replica = record.replica_data || (record.replica && typeof record.replica === 'object' ? record.replica : null) || (record.variant && record.variant.replicas || []).filter(function (item) {
        return String(item.infohash || '').toLowerCase() === hash;
      })[0];
      if (replica && replica.trackers) {
        new URLSearchParams(String(replica.trackers).replace(/^[?&]/, '')).getAll('tr').forEach(function (tracker) {
          if (trackers.indexOf(tracker) < 0) trackers.push(tracker);
        });
      }
      return { hash: hash, index: Number(indexValue), key: hash + ':' + Number(indexValue), trackers: trackers, replica: replica };
    } catch (e) { return null; }
  }

  function fileVariant(record) {
    var variant = cloneMetadata(record.variant) || { video: {}, audio: [], subtitles: [] };
    var file = sourceFile(record);
    if (variant.source_file_key && (!file || variant.source_file_key !== file.key)) {
      variant.video = { quality: variant.video && variant.video.quality, source: variant.video && variant.video.source };
      variant.audio = [];
      variant.subtitles = [];
      delete variant.ffprobe;
    }
    if (file) {
      variant.source_file_key = file.key;
      var replica = cloneMetadata(file.replica) || { infohash: file.hash };
      replica.stream_url = record.url;
      variant.replicas = [replica];
    }
    return variant;
  }

  function pumpProbes() {
    while (probeActive < 2 && probeQueue.length) {
      (function (file) {
        var interested = (probeWaiters[file.key] || []).some(function (waiter) { return waiter.deadline > Date.now(); });
        if (!interested) {
          delete probeWaiters[file.key];
          return;
        }
        probeActive++;
        var network = new Lampa.Reguest();
        var settled = false;
        function finish(streams) {
          if (settled) return;
          settled = true;
          probeActive--;
          probeCache[file.key] = { streams: cloneMetadata(streams), expires: Date.now() + (streams ? probeCacheTtl : probeFailureTtl) };
          probeOrder = probeOrder.filter(function (key) { return key !== file.key; });
          probeOrder.push(file.key);
          while (probeOrder.length > probeCacheLimit) delete probeCache[probeOrder.shift()];
          var waiters = probeWaiters[file.key] || [];
          delete probeWaiters[file.key];
          waiters.forEach(function (waiter) {
            if (waiter.deadline > Date.now()) waiter.complete(cloneMetadata(streams));
          });
          pumpProbes();
        }
        var url = API + '/lite/pidtor/probe/' + file.hash + '?index=' + file.index;
        file.trackers.forEach(function (tracker) { url += '&tr=' + encodeURIComponent(tracker); });
        var latestDeadline = Math.max.apply(Math, (probeWaiters[file.key] || []).map(function (waiter) { return waiter.deadline; }));
        network.timeout(Math.max(1, Math.min(90000, latestDeadline - Date.now())));
        network['native'](account(url), function (response) {
          var json = parseJson(response);
          var streams = json && !json.error && Array.isArray(json.streams) ? json.streams : null;
          // Lampac's serializer omits default-valued index:0 on the first stream.
          if (streams && streams.length && streams[0] && typeof streams[0].codec_type === 'string'
              && !Object.prototype.hasOwnProperty.call(streams[0], 'index')) {
            streams = streams.map(function (stream, index) {
              return index === 0 ? Object.assign({}, stream, { index: 0 }) : stream;
            });
          }
          if (!streams || !streams.length || streams.some(function (stream) {
            return !stream || !Number.isInteger(stream.index) || stream.index < 0;
          })) streams = null;
          finish(streams);
        }, function () { finish(null); }, false, { dataType: 'text' });
      })(probeQueue.shift());
    }
  }

  function probeFile(file, complete, deadline) {
    deadline = deadline || Date.now() + 90000;
    var cached = probeCache[file.key];
    if (cached && cached.expires > Date.now()) return complete(cloneMetadata(cached.streams));
    if (cached) delete probeCache[file.key];
    if (probeWaiters[file.key]) {
      probeWaiters[file.key].push({ complete: complete, deadline: deadline });
      return;
    }
    probeWaiters[file.key] = [{ complete: complete, deadline: deadline }];
    probeQueue.push(file);
    pumpProbes();
  }

  function applyProbe(variant, streams) {
    variant.ffprobe = cloneMetadata(streams);
    variant.probe_required = false;
    var video = streams.filter(function (stream) {
      return stream.codec_type === 'video' && !(stream.disposition && stream.disposition.attached_pic === 1);
    })[0];
    if (video) {
      variant.video = Object.assign({}, variant.video || {}, {
        stream_index: video.index, codec: video.codec_name, width: video.width, height: video.height
      });
    }
    ['audio', 'subtitles'].forEach(function (field) {
      var type = field === 'audio' ? 'audio' : 'subtitle';
      var selected = streams.filter(function (stream) { return stream.codec_type === type; });
      variant[field] = selected.map(function (stream) {
        var tags = stream.tags || {};
        var disposition = stream.disposition || {};
        var title = String(tags.title || '').trim();
        var handler = String(tags.handler_name || '').trim();
        var unnamed = !title && (!handler || /^SoundHandler$/i.test(handler));
        title = title || handler;
        var language = String(tags.language || '').trim().toLowerCase();
        if (field === 'audio' && selected.length === 1 && unnamed && (!language || language === 'und')) {
          title = variant.release_voice || title;
        }
        return {
          id: (field === 'audio' ? 'a' : 's') + stream.index,
          stream_index: stream.index, codec: stream.codec_name,
          title: title, language: tags.language || '',
          channels: stream.channels || 0, bitrate: Number(stream.bit_rate) || 0,
          default: disposition.default === 1, forced: disposition.forced === 1
        };
      });
    });
  }

  function resumeSourceKey(key) {
    var file = String(key || '').split('|')[4] || '';
    return /^(?:[a-f0-9]{40}|[a-z2-7]{32}):\d+$/i.test(file) ? file.toLowerCase() : '';
  }

  function preferResolvedFile(resolved, key) {
    var records = (resolved.source_records || []).slice();
    var preferred = records.filter(function (record) { return (sourceFile(record) || {}).key === key; })[0];
    if (!preferred) return resolved;
    records = [preferred].concat(records.filter(function (record) { return record !== preferred; }));
    return Object.assign({}, resolved, { source_records: records, url: preferred.url, preferred_file_key: key });
  }

  function hydrateResolved(resolved, complete, update, deadline, directStart) {
    var records = (resolved.source_records || []).map(function (record) {
      var variant = fileVariant(record);
      if (directStart && record.replica && record.replica.episodes_url && !variant.ffprobe) {
        variant.audio = [];
        variant.subtitles = [];
      }
      return { url: record.url, replica: cloneMetadata(record.replica), variant: variant };
    });
    var remaining = records.length;
    var done = [];
    var active = null;
    var delivered = false;
    var closed = false;
    deadline = deadline || Date.now() + 90000;
    var timer = setTimeout(function () {
      if (closed) return;
      closed = true;
      if (!active && records.length) {
        active = records[0];
        done[0] = true;
      }
      publish();
      pumpProbes();
    }, Math.max(0, deadline - Date.now()));
    function publish() {
      var copy = Object.assign({}, resolved);
      var available = records.filter(function (_, index) { return directStart || done[index]; });
      copy.source_records = available;
      copy.tracks_ready = true;
      copy.probe_pending = !closed && remaining > 0;
      copy.variant = active ? active.variant : fileVariant({ url: resolved.url, variant: resolved.variant });
      copy.url = active ? active.url : resolved.url;
      copy.sources = active ? [active.url] : resolved.sources;
      copy.available_variant_ids = available.map(function (record) { return record.variant.id; }).filter(function (id, index, all) { return id && all.indexOf(id) === index; });
      copy.episodes = (resolved.episodes || []).map(function (episode) {
        var item = Object.assign({}, episode);
        if (parseInt(item.e || 0, 10) === parseInt(resolved.requested_episode || 0, 10)) {
          item.url = copy.url;
          item.pidtor_source_urls = copy.sources;
          item.pidtor_source_records = available;
          item.pidtor_variant = copy.variant;
          item.pidtor_tracks_ready = true;
        }
        return item;
      });
      if (!delivered) {
        delivered = true;
        complete(copy);
      } else if (update) update(copy);
    }
    if (!remaining) {
      clearTimeout(timer);
      closed = true;
      return publish();
    }
    if (directStart) {
      active = records[0];
      publish();
    }
    records.forEach(function (record, index) {
      var file = sourceFile(record);
      function receive(streams) {
        if (closed || done[index]) return;
        if (streams) applyProbe(record.variant, streams);
        done[index] = true;
        remaining--;
        if (!active && (index === 0 || streams && !resolved.preferred_file_key || !remaining)) active = record;
        if (active) publish();
        if (!remaining) {
          closed = true;
          clearTimeout(timer);
        }
      }
      if (!file) receive(null);
      else probeFile(file, receive, deadline);
    });
  }

  function followQualityTracks(resolver, data) {
    var batch = resolver.track_batch || resolver;
    if (!batch.track_targets) Object.defineProperty(batch, 'track_targets', { value: [], configurable: true });
    if (batch.track_targets.indexOf(data) < 0) batch.track_targets.push(data);
  }

  function publishOptionTracks(result, option, resolved) {
    var batch = result.track_batch || result;
    if (batch.failed_files) resolved.source_records = (resolved.source_records || []).filter(function (record) {
      return !batch.failed_files[record.variant.source_file_key || rawGstSource(record.url)];
    });
    result.audio_options = resolvedTrackChoices(option, resolved, 'audio');
    result.subtitle_options = resolvedTrackChoices(option, resolved, 'subtitles');
    result.variant = resolved.variant;
    (batch.track_targets || []).forEach(function (target) {
      if (target.pidtor_quality_key !== result.key) return;
      var quality = (target.pidtor_quality_options || []).filter(function (item) { return item.key === result.key; })[0];
      if (quality) {
        quality.audio_options = result.audio_options;
        quality.subtitle_options = result.subtitle_options;
      }
      target.pidtor_audio_options = result.audio_options;
      target.pidtor_subtitle_options = result.subtitle_options;
      target.pidtor_source_records = resolved.source_records;
      var current = (resolved.source_records || []).filter(function (record) { return sameVariantFile(record.variant, target.pidtor_variant); })[0];
      if (current) {
        target.pidtor_variant = cloneMetadata(current.variant);
        target.ffprobe = variantStreams(current.variant);
      }
      if (!target.pidtor_audio_key && current) {
        var audio = result.audio_options.filter(function (choice) { return sameVariantFile(choice.variant, current.variant); });
        var initial = audio.filter(function (choice) { return choice.track.default === true; })[0] || audio[0];
        if (initial) {
          target.pidtor_audio_key = initial.key;
          target.pidtor_audio_stream_index = parseInt(initial.track.stream_index, 10);
          target.pidtor_audio_ffprobe_index = target.pidtor_audio_stream_index;
        }
      }
      if (target === activeControlsData) installPlayerControls(target);
    });
    if (result.on_tracks_update) result.on_tracks_update(resolved);
  }

  function resolvedTrackChoices(option, resolved, field) {
    return mergedTrackChoices({ variants: (resolved.source_records || []).map(function (record) { return record.variant; }) }, field).map(function (choice) {
      return {
        key: option.key + '|' + field + '|' + choiceIdentity(choice),
        title: choice.title, track: choice.track, variant: choice.variant, order: choice.order,
        resolve: function (complete, error) {
          var records = (resolved.source_records || []).filter(function (record) {
            return record.variant.source_file_key === choice.variant.source_file_key && record.variant.id === choice.variant.id;
          });
          if (!records.length) return error('Дорожка недоступна');
          complete(resolvedWithChoice(Object.assign({}, resolved, {
            url: records[0].url, sources: records.map(function (record) { return record.url; }), source_records: records,
            variant: records[0].variant
          }), choice, field));
        }
      };
    });
  }

  function getEpisodeResolution(key) {
    var cached = episodeResolutionCache[key];
    if (!cached) return null;
    if (cached.expires <= Date.now()) {
      delete episodeResolutionCache[key];
      return null;
    }
    return cached.data;
  }

  function storeEpisodeResolution(key, data) {
    if (!key || !data) return;
    episodeResolutionCache[key] = { data: data, expires: Date.now() + episodeResolutionCacheTtl };
    episodeResolutionOrder = episodeResolutionOrder.filter(function (item) { return item !== key; });
    episodeResolutionOrder.push(key);
    while (episodeResolutionOrder.length > episodeResolutionCacheLimit) {
      delete episodeResolutionCache[episodeResolutionOrder.shift()];
    }
  }

  function ensureGst(complete) {
    if (window.lampac_pidtor_gst_ready) {
      complete();
      return;
    }
    gstWaiters.push(complete);
    if (gstLoading) return;
    gstLoading = true;
    window.pidtor_nextgen_gst_only = true;
    Lampa.Utils.putScriptAsync([API + '/gst.js?pidtor_nextgen=1&v=20260828-22-native-fallback'], function () {
      gstLoading = false;
      var waiters = gstWaiters.splice(0);
      if (window.lampac_pidtor_gst_ready) {
        waiters.forEach(function (waiter) { waiter(); });
      } else {
        Lampa.Noty.show('GStreamer не инициализирован');
      }
    }, function () {
      gstLoading = false;
      var waiters = gstWaiters.splice(0);
      waiters.forEach(function (waiter) { waiter(); });
      Lampa.Noty.show('GStreamer недоступен, используется исходный поток');
    });
  }

  function account(url) {
    url = String(url || '');
    if (/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(url)) {
      url = String(API || '').replace(/\/$/, '') + url.replace(/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/i, '');
    }
    var email = Lampa.Storage.get('account_email', '');
    var uid = Lampa.Storage.get('lampac_unic_id', '');
    if (email && url.indexOf('account_email=') < 0) url = Lampa.Utils.addUrlComponent(url, 'account_email=' + encodeURIComponent(email));
    if (uid && url.indexOf('uid=') < 0) url = Lampa.Utils.addUrlComponent(url, 'uid=' + encodeURIComponent(uid));
    if (TOKEN && url.indexOf('token=') < 0) url = Lampa.Utils.addUrlComponent(url, 'token=' + encodeURIComponent(TOKEN));
    return url;
  }

  function emitResumeState(data) {
    if (!data || !data.pidtor_nextgen) return;
    var detail = {
      pidtor_nextgen: true,
      pidtor_manifest_schema: Number(data.pidtor_manifest_schema || 1),
      pidtor_manifest_url: data.pidtor_manifest_url || '',
      pidtor_quality_key: data.pidtor_quality_key || '',
      pidtor_audio_key: data.pidtor_audio_key || '',
      pidtor_subtitle_key: data.pidtor_subtitle_key || '',
      season: Number(data.season || 0),
      episode: Number(data.episode || 0)
    };
    try {
      window.dispatchEvent(new CustomEvent('pidtor-nextgen-state', { detail: detail }));
    } catch (e) {}
  }

  function preferredStoredChoice(options, key, previous, audio) {
    var exact = (options || []).filter(function (choice) {
      return key && choice.key === key;
    })[0];
    var legacy = (options || []).filter(function (choice) {
      var prefix = choice.key && choice.key.split('|').slice(0, 2).join('|') + '|';
      return key && (key === prefix + normalized(choice.title) + '|' + normalizedLanguage(choice.track && choice.track.language)
        || key === prefix + normalized(choice.title) + '|' + normalized(choice.track && choice.track.language));
    });
    return exact || (legacy.length === 1 ? legacy[0] : null) || preferredChoice(options, previous, audio);
  }

  function sanitizePlaybackSource(source) {
    return String(source || '')
      .replace(/([?&])rjson(?:=[^&#]*)?&?/gi, function (_, prefix) { return prefix === '?' ? '?' : ''; })
      .replace(/\?&/, '?')
      .replace(/[?&]$/, '');
  }

  function sourceWithAudio(source, streamIndex) {
    source = sanitizePlaybackSource(source);
    if (!source || !Number.isFinite(parseInt(streamIndex, 10))) return source;
    source = source
      .replace(/([?&])audio=[^&#]*&?/gi, function (_, prefix) { return prefix === '?' ? '?' : ''; })
      .replace(/\?&/, '?')
      .replace(/[?&]$/, '');
    return Lampa.Utils.addUrlComponent(source, 'audio=' + parseInt(streamIndex, 10));
  }

  function sourceForPlayback(source, useGst, streamIndex) {
    var result = sourceWithAudio(source, streamIndex);
    if (!useGst && /\/lite\/pidtor\/s/i.test(result)) {
      var url = new URL(result, API);
      url.searchParams.delete('.m3u8');
      url.searchParams.delete('raw');
      url.searchParams.set('direct', 'true');
      result = url.toString();
    }
    return result;
  }

  function isSerial(movie) {
    if (!movie) return false;
    var mediaType = String(movie.media_type || movie.type || '').toLowerCase();
    if (mediaType === 'movie' || mediaType === 'film') return false;
    if (mediaType === 'tv' || mediaType === 'serial' || mediaType === 'series') return true;
    if (parseInt(movie.number_of_seasons || 0, 10) > 0) return true;
    if (movie.first_air_date && !movie.release_date) return true;
    return !!(movie.name && !movie.title);
  }

  function isAnimeMedia(movie) {
    if (!movie) return false;
    var keywords = movie.keywords && movie.keywords.results || [];
    if (keywords.some(function (item) { return String(item && item.name || '').toLowerCase() === 'anime'; })) return true;
    var language = String(movie.original_language || '').toLowerCase();
    if (language === 'ja') return true;
    var genres = (movie.genres || []).map(function (item) { return String(item && item.name || item || ''); }).join(',').toLowerCase();
    return language.indexOf('zh') === 0 && /(anime|аниме|animation|мульт)/i.test(genres);
  }

  function storageEnabled(name, fallback) {
    var value = Lampa.Storage.field(name);
    if (typeof value === 'undefined' || value === null || value === '') return fallback === true;
    return value === true || value === 1 || value === '1' || value === 'true';
  }

  function useGstreamer(data) {
    return false;
  }

  function canPlayResolvedNatively(variant, mediaName) {
    var name = String(mediaName || '').split('?')[0].toLowerCase();
    if (!/\.(?:mp4|m4v)$/.test(name)) return false;
    var video = videoCodec(variant);
    if (video && !/(?:h264|avc|x264|h\.264)/.test(video)) return false;
    var audio = variant && variant.audio || [];
    if (!audio.length) return true;
    return audio.some(function (track) {
      return /^(?:aac|mp3|opus)?$/i.test(String(track && track.codec || ''));
    });
  }

  function parseJson(response) {
    if (typeof response !== 'string') return response;
    try { return JSON.parse(response); } catch (e) { return null; }
  }

  function rawGstSource(source) {
    var result = sanitizePlaybackSource(source)
      .replace(/&\.m3u8(?=&|$)/g, '')
      .replace(/([?&])audio=[^&#]*&?/gi, function (_, prefix) { return prefix === '?' ? '?' : ''; })
      .replace(/\?&/, '?')
      .replace(/[?&]$/, '');
    if (/\/lite\/pidtor\/s/i.test(result) && !/[?&]raw=/.test(result)) {
      result = Lampa.Utils.addUrlComponent(result, 'raw=true');
    }
    return account(result);
  }

  function warmKey(source, audioIndex) {
    return rawGstSource(source)
      .replace(/([?&])(account_email|uid|token|nws_id)=[^&#]*&?/gi, function (_, prefix) { return prefix === '?' ? '?' : ''; })
      .replace(/\?&/, '?')
      .replace(/[?&]$/, '') + '|' + parseInt(audioIndex || 0, 10);
  }

  function requestGstWarm(source, audioIndex, complete, error, fresh) {
    var raw = rawGstSource(source);
    var key = warmKey(raw, audioIndex);
    var cached = warmCache[key];
    if (fresh && cached) {
      delete warmCache[key];
      cached = null;
    }
    if (cached && cached.expires > Date.now()) {
      complete(cached.json);
      return;
    }
    if (cached) delete warmCache[key];
    if (warmWaiters[key]) {
      warmWaiters[key].push({ complete: complete, error: error });
      return;
    }
    warmWaiters[key] = [{ complete: complete, error: error }];

    function finish(json, message) {
      var waiters = warmWaiters[key] || [];
      delete warmWaiters[key];
      if (json) warmCache[key] = { json: json, expires: Date.now() + warmCacheTtl };
      waiters.forEach(function (waiter) {
        if (json) waiter.complete(json);
        else if (waiter.error) waiter.error(message);
      });
    }

    var url = API + '/gst/add?linkencode=' + encodeURIComponent(Lampa.Base64.encode(raw)) + '&audio=' + parseInt(audioIndex || 0, 10);

    function shouldRetry(message) {
      return /(?:bad gateway|responseheaders|502)/i.test(String(message || ''));
    }

    function request(attempt) {
      var network = new Lampa.Reguest();
      // A cold torrent-backed probe can fail once while TorrServer is still
      // opening the file. One retry is enough; successful tasks are cached.
      network.timeout(15000);
      network['native'](account(url), function (response) {
        var json = parseJson(response);
        if (json && json.id && json.hls) {
          finish(json);
          return;
        }
        var message = response || 'GStreamer не подготовил поток';
        if (attempt === 0 && shouldRetry(message)) {
          setTimeout(function () { request(1); }, 700);
          return;
        }
        finish(null, message);
      }, function (response) {
        var message = response && (response.responseText || response.statusText) || 'GStreamer недоступен';
        if (attempt === 0 && shouldRetry(message)) {
          setTimeout(function () { request(1); }, 700);
          return;
        }
        finish(null, message);
      }, false, { dataType: 'text' });
    }

    request(0);
  }

  function cachedGstWarm(source, audioIndex) {
    var key = warmKey(source, audioIndex);
    var cached = warmCache[key];
    if (cached && cached.expires > Date.now()) return cached.json;
    if (cached) delete warmCache[key];
    return null;
  }

  function warmResource(url, complete, stage) {
    var xhr = new XMLHttpRequest();
    var target = /\/gst\/\d+\//i.test(String(url || '')) ? String(url) : account(url);
    xhr.open('GET', target, true);
    xhr.timeout = stage === 'master' ? 30000 : 20000;
    function fail(reason) {
      console.warn('[PidTor] GST warm failed:', stage || 'resource', reason, String(target || '').replace(/^https?:\/\/[^/]+/i, '').slice(0, 180));
      complete('', false, reason);
    }
    xhr.onload = function () {
      var ok = xhr.status >= 200 && xhr.status < 300;
      if (ok) complete(xhr.responseText, true, '');
      else fail('HTTP ' + xhr.status);
    };
    xhr.onerror = function () { fail('network'); };
    xhr.ontimeout = function () { fail('timeout'); };
    xhr.send();
  }

  function warmDirectSource(source, complete) {
    var target = rawGstSource(source);
    var key = warmKey(target, -1);
    var cached = directWarmCache[key];
    if (cached && cached.expires > Date.now()) {
      if (complete) complete(true);
      return;
    }
    if (cached) delete directWarmCache[key];
    if (directWarmWaiters[key]) {
      if (complete) directWarmWaiters[key].push(complete);
      return;
    }
    directWarmWaiters[key] = complete ? [complete] : [];

    var xhr = new XMLHttpRequest();
    var finished = false;
    function finish(ok, abort) {
      if (finished) return;
      finished = true;
      if (ok) directWarmCache[key] = { expires: Date.now() + warmCacheTtl };
      var waiters = directWarmWaiters[key] || [];
      delete directWarmWaiters[key];
      if (abort) {
        try { xhr.abort(); } catch (e) {}
      }
      waiters.forEach(function (waiter) { waiter(ok); });
    }

    xhr.open('GET', target, true);
    xhr.responseType = 'arraybuffer';
    xhr.timeout = 6000;
    try { xhr.setRequestHeader('Range', 'bytes=0-262143'); } catch (e) {}
    xhr.onprogress = function (event) {
      if (event.loaded >= 65536) finish(true, true);
    };
    xhr.onload = function () { finish(xhr.status >= 200 && xhr.status < 300, false); };
    xhr.onerror = function () { finish(false, false); };
    xhr.ontimeout = function () { finish(false, true); };
    xhr.onabort = function () { if (!finished) finish(false, false); };
    xhr.send();
  }

  function mediaSegmentForTime(body, targetSeconds) {
    var lines = String(body || '').split(/\r?\n/);
    var elapsed = 0;
    var duration = 0;
    var fallback = '';
    targetSeconds = Math.max(0, parseFloat(targetSeconds || 0));
    for (var i = 0; i < lines.length; i++) {
      var line = String(lines[i] || '').trim();
      if (/^#EXTINF:/i.test(line)) {
        duration = parseFloat(line.replace(/^#EXTINF:/i, '').split(',')[0]) || 0;
        continue;
      }
      if (!line || line.charAt(0) === '#' || !/\.m4s(?:\?|$)/i.test(line)) continue;
      if (!fallback) fallback = line;
      if (targetSeconds < elapsed + duration) return line;
      elapsed += duration;
      duration = 0;
    }
    return fallback;
  }

  function warmGstSource(source, audioIndex, complete, targetSeconds) {
    var verifyKey = warmKey(source, audioIndex);
    var failed = failedGstCache[verifyKey];
    if (failed && failed.expires > Date.now()) {
      if (complete) complete(null);
      return;
    }
    if (failed) delete failedGstCache[verifyKey];
    var verified = verifiedGstCache[verifyKey];
    if (verified && verified.expires > Date.now()) {
      if (complete) complete(verified.json);
      return;
    }
    if (verified) delete verifiedGstCache[verifyKey];
    if (verifiedGstWaiters[verifyKey]) {
      if (complete) verifiedGstWaiters[verifyKey].push(complete);
      return;
    }
    verifiedGstWaiters[verifyKey] = complete ? [complete] : [];

    function finish(json) {
      if (json) {
        verifiedGstCache[verifyKey] = { json: json, expires: Date.now() + warmCacheTtl };
        delete failedGstCache[verifyKey];
      } else {
        failedGstCache[verifyKey] = { expires: Date.now() + failedGstCacheTtl };
      }
      var waiters = verifiedGstWaiters[verifyKey] || [];
      delete verifiedGstWaiters[verifyKey];
      waiters.forEach(function (waiter) { waiter(json); });
    }

    warmDirectSource(source, function (directReady) {
      if (!directReady) {
        finish(null);
        return;
      }
      requestGstWarm(source, audioIndex, function (json) {
      var master = json.hls + '?audio=' + parseInt(audioIndex || 0, 10);

      function warmMaster(attempt) {
        warmResource(master, function (body, masterOk, reason) {
        if (!masterOk) {
          // A newly-created GST task can answer 502 until its first playlist is
          // produced. Keep polling this task instead of discarding a healthy
          // torrent and moving to a worse replica.
          if (attempt < 4 && /(?:HTTP 502|timeout|network)/i.test(String(reason || ''))) {
            setTimeout(function () { warmMaster(attempt + 1); }, 700 + attempt * 600);
            return;
          }
          delete warmCache[warmKey(source, audioIndex)];
          finish(null);
          return;
        }
        var videoPath = String(body || '').split(/\r?\n/).filter(function (line) {
          return line && line.charAt(0) !== '#' && /video\.m3u8/i.test(line);
        })[0];
        if (!videoPath) {
          delete warmCache[warmKey(source, audioIndex)];
          finish(null);
          return;
        }
        var videoUrl = new URL(videoPath, master).href;
        warmResource(videoUrl, function (videoBody, videoOk) {
          if (!videoOk) {
            delete warmCache[warmKey(source, audioIndex)];
            finish(null);
            return;
          }
          var initPath = String(videoBody || '').match(/#EXT-X-MAP:URI="([^"]+)"/i);
          if (!initPath) {
            delete warmCache[warmKey(source, audioIndex)];
            finish(null);
            return;
          }
          // The init request starts the selected audio pipeline. Validate only
          // the first media segment: this rejects dead replicas without
          // duplicating a potentially expensive seek to the resume position.
          warmResource(new URL(initPath[1], videoUrl).href, function (_, initOk) {
            var mediaPath = initOk ? mediaSegmentForTime(videoBody, 0) : '';
            if (!mediaPath) {
              delete warmCache[warmKey(source, audioIndex)];
              finish(null);
              return;
            }
            warmResource(new URL(mediaPath, videoUrl).href, function (_, mediaOk) {
              if (!mediaOk) delete warmCache[warmKey(source, audioIndex)];
              finish(mediaOk ? json : null);
            }, 'segment');
          }, 'init');
        }, 'video');
      }, 'master');
      }

      warmMaster(0);
      }, function () { finish(null); });
    });
  }

  function prepareGstReplica(sources, audioIndex, targetSeconds, complete) {
    var candidates = (sources || []).filter(function (source, index, all) {
      return source && all.indexOf(source) === index;
    }).slice(0, 4);
    var cursor = 0;
    var active = 0;
    var finished = 0;
    var settled = false;
    // A dead top-seeded replica used to block playback for a full GST timeout.
    // Two candidates keep TorrServer load bounded while removing that serial
    // wait; the remaining pair is still available as a second fallback wave.
    var limit = Math.min(2, candidates.length);

    if (!candidates.length) {
      complete(null, '', []);
      return;
    }

    function pump() {
      if (settled) return;
      while (active < limit && cursor < candidates.length) {
        (function (candidate) {
          active++;
          warmGstSource(candidate, audioIndex, function (prepared) {
            active--;
            finished++;
            if (settled) return;
            if (prepared) {
              settled = true;
              complete(prepared, candidate, [candidate].concat(candidates.filter(function (source) {
                return source !== candidate;
              })));
              return;
            }
            if (finished >= candidates.length) {
              settled = true;
              complete(null, '', candidates);
              return;
            }
            pump();
          }, targetSeconds);
        })(candidates[cursor++]);
      }
    }

    pump();
  }

  function query(movie, season, episode) {
    var values = [];
    var serial = isSerial(movie);
    var year = ((movie.release_date || movie.first_air_date || '0000') + '').slice(0, 4);
    var source = movie.source || 'tmdb';
    values.push('id=' + encodeURIComponent(movie.id || 0));
    values.push('tmdb_id=' + encodeURIComponent(movie.tmdb_id || (source === 'tmdb' || source === 'cub' ? movie.id || 0 : 0)));
    if (movie.imdb_id) values.push('imdb_id=' + encodeURIComponent(movie.imdb_id));
    if (movie.kinopoisk_id) values.push('kinopoisk_id=' + encodeURIComponent(movie.kinopoisk_id));
    values.push('source=' + encodeURIComponent(source));
    values.push('title=' + encodeURIComponent(movie.title || movie.name || ''));
    values.push('original_title=' + encodeURIComponent(movie.original_title || movie.original_name || ''));
    values.push('original_language=' + encodeURIComponent(movie.original_language || ''));
    values.push('year=' + encodeURIComponent(year));
    values.push('serial=' + (serial ? 1 : 0));
    if (season > 0) values.push('s=' + season);
    if (episode > 0) values.push('e=' + episode);
    if (season > 0 && Array.isArray(movie.seasons)) {
      var seasonInfo = movie.seasons.filter(function (item) {
        return parseInt(item.season_number || item.number || 0, 10) === season;
      })[0];
      if (seasonInfo) {
        if (seasonInfo.name) values.push('season_title=' + encodeURIComponent(seasonInfo.name));
        if (seasonInfo.air_date) values.push('season_year=' + encodeURIComponent(String(seasonInfo.air_date).slice(0, 4)));
        if (seasonInfo.episode_count) values.push('season_episodes=' + encodeURIComponent(seasonInfo.episode_count));
      }
    }
    if (isAnimeMedia(movie)) values.push('anime=true');
    if (movie.genres) values.push('genres=' + encodeURIComponent(movie.genres.map(function (item) { return item.name || item; }).join(',')));
    return values.join('&');
  }

  function timeline(movie, season, episode) {
    var original = movie.original_title || movie.original_name || movie.title || movie.name || movie.id;
    var hash = season
      ? Lampa.Utils.hash([season, season > 10 ? ':' : '', episode, original].join(''))
      : Lampa.Utils.hash(original);
    return Lampa.Timeline.view(hash);
  }

  function videoCodec(variant) {
    return String(variant && variant.video && variant.video.codec || '').toLowerCase();
  }

  function supportsVariant(variant) {
    var codec = videoCodec(variant);
    if (!/(?:hevc|h265|x265|h\.265)/.test(codec)) return true;
    var video = document.createElement('video');
    return !!(
      video.canPlayType('video/mp4; codecs="hvc1.1.6.L120.B0"') ||
      video.canPlayType('video/mp4; codecs="hev1.1.6.L120.B0"')
    );
  }

  function qualityRank(variant) {
    var quality = String(variant && variant.video && variant.video.quality || '0');
    return parseInt(quality, 10) || 0;
  }

  function qualityName(variant) {
    var video = variant.video || {};
    var quality = video.quality || 'SD';
    var hdr = String(video.hdr || '').toLowerCase();
    if (hdr === 'dolby_vision') quality += ' DV';
    else if (hdr === 'hdr10_plus') quality += ' HDR10+';
    else if (hdr === 'hdr10') quality += ' HDR';
    else if (hdr === 'hlg') quality += ' HLG';
    return quality;
  }

  function qualityLabel(variant) {
    var video = variant.video || {};
    var values = [];
    if (video.source) values.push(video.source);
    if (video.codec) values.push(String(video.codec).toUpperCase());
    if (video.bit_depth > 8) values.push(video.bit_depth + '-bit');
    return values.join(' · ');
  }

  function seeders(variant) {
    return Math.max.apply(Math, (variant.replicas || []).map(function (item) { return parseInt(item.seeders || 0, 10); }).concat([0]));
  }

  function verifiedVariant(variant) {
    if (!variant) return false;
    return (variant.replicas || []).some(function (replica) {
      return !!(replica && (replica.stream_url || replica.episodes_url));
    });
  }

  function variantScore(variant) {
    var audio = variant && Array.isArray(variant.audio) ? variant.audio : [];
    var subtitles = variant && Array.isArray(variant.subtitles) ? variant.subtitles : [];
    var russian = audio.some(function (track) {
      return normalizedLanguage(track && track.language) === 'ru';
    }) ? 1 : 0;
    return russian * 1000000000000 + audio.length * 10000000000 + subtitles.length * 100000000 + playbackPriority(variant) * 1000000 + seeders(variant);
  }

  function playbackPriority(variant) {
    var codec = videoCodec(variant);
    if (/(?:h264|avc|x264|h\.264)/.test(codec)) return 4;
    if (!codec) return 3;
    if (supportsVariant(variant)) return 2;
    return 1;
  }

  function replicaKey(replica) {
    return String(replica.infohash || replica.episodes_url || replica.stream_url || '');
  }

  function qualityOptions(data) {
    var grouped = {};
    var verified = (data.variants || []).filter(verifiedVariant);
    verified.forEach(function (variant) {
      var key = qualityName(variant);
      if (!grouped[key]) grouped[key] = { key: key, label: '', variant: null, variants: [] };
      grouped[key].variants.push(variant);
      if (!grouped[key].variant || variantScore(variant) > variantScore(grouped[key].variant)) {
        grouped[key].variant = variant;
        grouped[key].label = qualityLabel(variant);
      }
    });
    return Object.keys(grouped).map(function (key) {
      var option = grouped[key];
      option.variants.sort(function (a, b) { return variantScore(b) - variantScore(a); });
      option.variant = option.variants[0];
      option.label = qualityLabel(option.variant);
      return option;
    }).sort(function (a, b) {
      return qualityRank(b.variant) - qualityRank(a.variant) || seeders(b.variant) - seeders(a.variant);
    });
  }

  function defaultQuality(options) {
    if (!options || !options.length) return null;
    var selected = options.slice().sort(function (a, b) {
      var aPriority = Math.max.apply(Math, (a.variants || [a.variant]).map(playbackPriority));
      var bPriority = Math.max.apply(Math, (b.variants || [b.variant]).map(playbackPriority));
      return bPriority - aPriority || qualityRank(b.variant) - qualityRank(a.variant) || seeders(b.variant) - seeders(a.variant);
    })[0];
    selected.variant = (selected.variants || [selected.variant]).slice().sort(function (a, b) {
      return playbackPriority(b) - playbackPriority(a) || variantScore(b) - variantScore(a);
    })[0];
    return selected;
  }

  function normalized(value) {
    return String(value || '').toLowerCase().replace(/[\[\](){}]/g, ' ').replace(/[^a-z0-9\u0400-\u04ff]+/g, ' ').trim();
  }

  function trackTitle(track, index, subtitle) {
    var title = String(track && track.title || '').trim();
    var language = String(track && track.language || '').toLowerCase();
    title = title
      .replace(/^\s*\d+\s*[\/.|:_-]+\s*/i, '')
      .replace(/^\s*(?:ru|rus|russian|en|eng|english|ja|jpn|japanese)\s*[\/.|:_-]+\s*/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    var probe = normalized(title);
    if (subtitle) {
      if (track && track.forced === true || /forced|форс/.test(probe)) return 'Forced';
      if (/sdh|hearing|слабослыш/.test(probe)) return 'SDH';
      return 'Full';
    }
    var studios = [
      [/bravo records|movie dubbing/, 'Bravo Records'],
      [/red head sound|\brhs\b/, 'Red Head Sound'],
      [/hdrezka|rezka studio/, 'HDRezka Studio'],
      [/jaskier/, 'Jaskier'],
      [/lost\s*film/, 'LostFilm'],
      [/tv\s*shows/, 'TVShows'],
      [/невaфильм|невафильм|nevafilm/, 'Невафильм'],
      [/newstudio/, 'NewStudio'],
      [/postmodern/, 'Postmodern'],
      [/anilibria|anilibira/, 'AniLibria'],
      [/anidub/, 'AniDub'],
      [/studio\s*band|студийная банда|wakanim/, 'Студийная Банда'],
      [/dream\s*cast/, 'Dream Cast'],
      [/jam\s*club/, 'JAM CLUB'],
      [/кубик в кубе|kubik/, 'Кубик в Кубе'],
      [/serbin|сербин/, 'Юрий Сербин'],
      [/yarotsky|яроцк/, 'Михаил Яроцкий'],
      [/soundhandler/, 'SoundHandler'],
      [/rusatmos/, 'RUSATMOS'],
      [/\bline\b/, 'Line']
    ];
    for (var studioIndex = 0; studioIndex < studios.length; studioIndex++) {
      if (studios[studioIndex][0].test(probe)) return studios[studioIndex][1];
    }
    if (/^(?:en|eng)$/.test(language) || /original|оригинал/.test(probe)) return 'Original';
    if (/^(?:ru|rus)$/.test(language)) {
      if (/^(?:dub|dubbed|дубляж|gy6l|gy6л)$/.test(probe)) return 'Дубляж';
      if (/^(?:mvo|многоголосая|многоголосый)$/.test(probe)) return 'Многоголосая';
      if (/^(?:avo|vo|одноголосая|одноголосый)$/.test(probe)) return 'Авторская';
      if (!probe || /^(?:ru|rus|russian|und)$/.test(probe)) return 'Русская дорожка';
    }
    if (/^(?:uk|ukr)$/.test(language) && (!probe || /^(?:uk|ukr|ukrainian)$/.test(probe))) return 'Українська доріжка';
    if (!title || /^(?:audio|track|sound|subtitle|sub)\s*#?\d*$/i.test(title)) {
      if (/^(?:en|eng)$/.test(language)) title = subtitle ? 'English' : 'Original';
      else if (/^(?:ru|rus)$/.test(language)) title = subtitle ? 'Russian' : 'Russian audio';
      else title = (subtitle ? 'Subtitle #' : 'Audio #') + (index + 1);
    }
    return title;
  }

  function mergedTrackChoices(option, field) {
    var unique = {};
    var choices = [];
    (option.variants || [option.variant]).forEach(function (variant) {
      (variant[field] || []).forEach(function (track, index) {
        var title = trackTitle(track, index, field === 'subtitles');
        var choice = { title: title, track: track, variant: variant, order: index };
        var key = choiceIdentity(choice);
        if (!unique[key]) {
          unique[key] = choice;
          choices.push(choice);
        } else if (seeders(variant) > seeders(unique[key].variant)) {
          Object.assign(unique[key], choice);
        }
      });
    });
    return choices;
  }

  function normalizedLanguage(value) {
    value = normalized(value);
    if (/^(ru|rus|russian)$/.test(value)) return 'ru';
    if (/^(en|eng|english)$/.test(value)) return 'en';
    if (/^(ja|jpn|japanese)$/.test(value)) return 'ja';
    return value;
  }

  function choiceIdentity(choice) {
    if (!choice) return '';
    var track = choice.track || {};
    var variant = choice.variant || {};
    var file = variant.source_file_key || String(variant.id || '') + ':' + (variant.replicas || []).map(replicaKey).sort().join(',');
    return [normalized(choice.title), normalizedLanguage(track.language), file,
      track.stream_index === undefined ? choice.order : track.stream_index,
      normalized(track.codec), Number(track.channels || 0), normalized(track.title), track.forced === true ? 'forced' : ''].join('|');
  }

  function currentChoice(data, field) {
    var options = data['pidtor_' + field + '_options'] || [];
    var key = data['pidtor_' + field + '_key'];
    return options.filter(function (choice) { return choice.key === key; })[0] || null;
  }

  function sameVariantFile(a, b) {
    return !!(a && b && a.id === b.id && a.source_file_key === b.source_file_key);
  }

  function preferredChoice(options, previous, audio) {
    options = options || [];
    if (!options.length) return null;
    if (previous) {
      var exact = options.filter(function (choice) { return choiceIdentity(choice) === choiceIdentity(previous); })[0];
      if (exact) return exact;
      var matchingTitle = options.filter(function (choice) {
        return normalized(choice.title) === normalized(previous.title)
          && normalizedLanguage(choice.track && choice.track.language) === normalizedLanguage(previous.track && previous.track.language);
      });
      if (matchingTitle.length === 1) return matchingTitle[0];
      var previousLanguage = normalizedLanguage(previous.track && previous.track.language);
      var sameLanguage = options.filter(function (choice) {
        return normalizedLanguage(choice.track && choice.track.language) === previousLanguage;
      }).sort(function (a, b) { return seeders(b.variant) - seeders(a.variant); })[0];
      if (sameLanguage) return sameLanguage;
    }
    if (audio) {
      var russian = options.filter(function (choice) {
        return normalizedLanguage(choice.track && choice.track.language) === 'ru';
      }).sort(function (a, b) { return seeders(b.variant) - seeders(a.variant); })[0];
      if (russian) return russian;
    }
    return options.slice().sort(function (a, b) { return seeders(b.variant) - seeders(a.variant); })[0];
  }

  function availableChoices(options, variantIds) {
    var allowed = {};
    (variantIds || []).forEach(function (id) { allowed[String(id)] = true; });
    if (!Object.keys(allowed).length) return options || [];
    return (options || []).filter(function (choice) {
      return choice.variant && allowed[String(choice.variant.id)];
    });
  }

  function resolvedVariantIds(resolved) {
    var ids = resolved && Array.isArray(resolved.available_variant_ids)
      ? resolved.available_variant_ids.filter(function (id, index, all) { return id && all.indexOf(id) === index; })
      : [];
    if (!ids.length && resolved && resolved.variant && resolved.variant.id) ids.push(resolved.variant.id);
    return ids;
  }

  function resolvedWithChoice(resolved, choice, field) {
    if (!choice) return resolved;
    resolved = Object.assign({}, resolved);
    var records = (resolved.source_records || []).filter(function (record) {
      return choice.variant && record.variant.source_file_key === choice.variant.source_file_key && record.variant.id === choice.variant.id;
    });
    if (records.length) {
      resolved.url = records[0].url;
      resolved.sources = records.map(function (record) { return record.url; });
    }
    resolved.variant = choice.variant || resolved.variant;
    if (field === 'audio') {
      resolved.url = sourceWithAudio(resolved.url, choice.track.stream_index);
      resolved.sources = (resolved.sources || [resolved.url]).map(function (source) {
        return sourceWithAudio(source, choice.track.stream_index);
      });
    }
    return resolved;
  }

  function variantStreams(variant) {
    if (variant && Array.isArray(variant.ffprobe)) return cloneMetadata(variant.ffprobe);
    var streams = [];
    if (variant && variant.video) {
      streams.push({
        index: variant.video.stream_index,
        codec_type: 'video',
        codec_name: variant.video.codec,
        width: variant.video.width,
        height: variant.video.height
      });
    }
    (variant && variant.audio || []).forEach(function (track) {
      streams.push({
        index: track.stream_index,
        codec_type: 'audio',
        codec_name: track.codec,
        channels: track.channels,
        bit_rate: String(track.bitrate || ''),
        tags: { language: track.language, title: track.title }
      });
    });
    (variant && variant.subtitles || []).forEach(function (track) {
      streams.push({
        index: track.stream_index,
        codec_type: 'subtitle',
        codec_name: track.codec,
        tags: { language: track.language, title: track.title }
      });
    });
    return streams;
  }

  function streamHash(url) {
    return ((String(url || '').match(/\/s([a-f0-9]{32,40})/i) || [])[1] || '').toLowerCase();
  }

  function videoElement() {
    return Lampa.PlayerVideo && Lampa.PlayerVideo.video ? Lampa.PlayerVideo.video() : null;
  }

  function currentPosition() {
    var video = videoElement();
    return video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
  }

  function restorePosition(seconds, callback, previousSource, owner) {
    owner = owner || activeControlsData;
    var restored = false;
    var attempts = 0;
    var timer = null;
    function finish(cancelled) {
      if (restored) return;
      restored = true;
      Lampa.PlayerVideo.listener.remove('loadeddata', restore);
      if (timer) clearInterval(timer);
      if (!cancelled && callback) callback();
    }
    function restore() {
      if (restored) return;
      if (owner && !ownsPlayer(owner)) return finish(true);
      attempts++;
      var video = videoElement();
      if (previousSource && video && video.currentSrc === previousSource) {
        if (attempts >= 300) finish();
        return;
      }
      if (video && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0) {
        if (seconds > 0) {
          try { video.currentTime = Math.min(seconds, Math.max(0, video.duration - 0.25)); } catch (e) {}
          Lampa.PlayerVideo.to(seconds);
        }
        finish();
        return;
      }
      if (attempts >= 300) finish();
    }
    Lampa.PlayerVideo.listener.follow('loadeddata', restore);
    timer = setInterval(restore, 100);
    restore();
  }

  function selectNativeAudio(order) {
    var video = videoElement();
    if (!video || !video.audioTracks || !video.audioTracks[order]) return false;
    for (var i = 0; i < video.audioTracks.length; i++) {
      video.audioTracks[i].enabled = i === order;
      video.audioTracks[i].selected = i === order;
    }
    return true;
  }

  function selectNativeSubtitle(order) {
    var video = videoElement();
    if (!video || !video.textTracks) return;
    for (var i = 0; i < video.textTracks.length; i++) {
      video.textTracks[i].mode = i === order ? 'showing' : 'disabled';
      video.textTracks[i].selected = i === order;
    }
  }

  function updatePlaylistSources(data, resolved) {
    if (!resolved || !Array.isArray(resolved.episodes)) return;
    var byEpisode = {};
    resolved.episodes.forEach(function (item) { byEpisode[parseInt(item.e || 0, 10)] = item; });
    var playlist = Lampa.PlayerPlaylist && Lampa.PlayerPlaylist.get ? Lampa.PlayerPlaylist.get() : [];
    (playlist || []).forEach(function (item) {
      var card = data.card || data.movie;
      var itemCard = item.card || item.movie;
      if (!card || !itemCard || String(card.id || card.tmdb_id || '') !== String(itemCard.id || itemCard.tmdb_id || '')
          || isSerial(card) !== isSerial(itemCard) || parseInt(item.season || 0, 10) !== parseInt(data.season || 0, 10)) return;
      var episode = byEpisode[parseInt(item.episode || 0, 10)];
      if (!episode || !episode.url) return;
      var current = parseInt(item.episode || 0, 10) === parseInt(data.episode || 0, 10);
      item.url = current ? data.url : account(sourceForPlayback(episode.url, item.pidtor_use_gst === true));
      item.url_orig = item.url;
      item.pidtor_source_url = current ? data.pidtor_source_url : account(episode.url);
      item.pidtor_source_urls = current ? data.pidtor_source_urls : (episode.pidtor_source_urls || [episode.url]).map(account);
      item.pidtor_source_records = current ? data.pidtor_source_records : cloneMetadata(episode.pidtor_source_records || []);
      item.pidtor_variant = current ? data.pidtor_variant : cloneMetadata(episode.pidtor_variant);
      item.pidtor_quality_key = data.pidtor_quality_key;
      item.pidtor_tracks_ready = current && data.pidtor_tracks_ready === true;
      if (current) {
        item.pidtor_audio_key = data.pidtor_audio_key || '';
        item.pidtor_subtitle_key = data.pidtor_subtitle_key || '';
        item.pidtor_audio_stream_index = data.pidtor_audio_stream_index;
        item.pidtor_audio_ffprobe_index = data.pidtor_audio_ffprobe_index;
        item.pidtor_audio_options = data.pidtor_audio_options;
        item.pidtor_subtitle_options = data.pidtor_subtitle_options;
      } else {
        item.pidtor_audio_stream_index = -1;
        item.pidtor_audio_ffprobe_index = -1;
        item.pidtor_audio_options = [];
        item.pidtor_subtitle_options = [];
      }
      item.ffprobe = variantStreams(item.pidtor_variant);
      item.pidtor_available_variant_ids = episode.pidtor_available_variant_ids || [];
    });
  }

  function replaceSource(data, resolved, variant, afterLoad) {
    if (!ownsPlayer(data)) return;
    var position = currentPosition();
    var selectedAudio = parseInt(data.pidtor_audio_stream_index, 10);
    var sourceAudio = (String(resolved.url || '').match(/[?&]audio=(\d+)/i) || [])[1];
    if (sourceAudio !== undefined) selectedAudio = parseInt(sourceAudio, 10);
    if (!Number.isFinite(selectedAudio) || selectedAudio < 0) selectedAudio = 0;
    data.pidtor_audio_stream_index = selectedAudio;
    var rawSource = account(sourceForPlayback(resolved.url, data.pidtor_use_gst === true, selectedAudio));
    var rawSources = (resolved.sources || [resolved.url]).map(function (item) {
      return account(sourceForPlayback(item, data.pidtor_use_gst === true, selectedAudio));
    });

    function applySource(source) {
      if (!ownsPlayer(data)) return;
      var previousSource = videoElement() && videoElement().currentSrc || '';
      data.url = source;
      data.url_orig = source;
      data.pidtor_source_url = rawSource;
      data.pidtor_source_urls = rawSources;
      data.pidtor_variant = variant;
      data.pidtor_source_records = resolved.source_records || data.pidtor_source_records || [];
      data.pidtor_tracks_ready = resolved.tracks_ready === true || data.pidtor_tracks_ready === true;
      data.ffprobe = variantStreams(variant);
      data.torrent_hash = streamHash(rawSource);
      emitResumeState(data);
      updatePlaylistSources(data, resolved);
      Lampa.PlayerVideo.destroy(true);
      Lampa.PlayerVideo.url(source, true);
      startPlaybackMonitor(data);
      restorePosition(position, function () {
        if (!ownsPlayer(data)) return;
        Lampa.Player.loading(false);
        if (afterLoad) afterLoad();
        installPlayerControls(data);
      }, previousSource, data);
    }

    Lampa.Player.loading(true);
    if (data.pidtor_use_gst === true) {
      prepareGstReplica(rawSources, selectedAudio, position, function (json, selectedSource, orderedSources) {
        if (!ownsPlayer(data)) return;
        if (!json) {
          Lampa.Player.loading(false);
          if (afterLoad) afterLoad(false);
          Lampa.Noty.show('GStreamer не подготовил резервную копию');
          return;
        }
        rawSource = selectedSource;
        rawSources = orderedSources;
        data.pidtor_gst_warm = json;
        applySource(json.hls + '?audio=' + selectedAudio);
      });
      return;
    }

    applySource(account(sourceForPlayback(resolved.url, false, selectedAudio)));
  }

  function replaceGstAudio(data, choice, resolved) {
    if (!ownsPlayer(data)) return;
    var ordinal = parseInt(choice && choice.order, 10);
    var streamIndex = parseInt(choice && choice.track && choice.track.stream_index, 10);
    var position = currentPosition();
    if (!Number.isFinite(ordinal) || ordinal < 0) ordinal = 0;

    if (resolved && resolved.url) {
      data.pidtor_source_url = account(resolved.url);
      data.pidtor_source_urls = (resolved.sources || [resolved.url]).map(account);
      data.pidtor_variant = resolved.variant || choice.variant || data.pidtor_variant;
      data.pidtor_source_records = resolved.source_records || data.pidtor_source_records || [];
      data.pidtor_tracks_ready = resolved.tracks_ready === true || data.pidtor_tracks_ready === true;
      data.ffprobe = variantStreams(data.pidtor_variant);
      data.torrent_hash = streamHash(resolved.url);
      updatePlaylistSources(data, resolved);
    }

    var sources = (data.pidtor_source_urls || [data.pidtor_source_url]).filter(function (item, index, all) {
      return item && all.indexOf(item) === index;
    });
    if (!sources.length) {
      Lampa.Noty.show('Исходный поток аудиодорожки недоступен');
      return;
    }

    data.pidtor_audio_stream_index = ordinal;
    data.pidtor_audio_ffprobe_index = Number.isFinite(streamIndex) ? streamIndex : -1;
    emitResumeState(data);
    Lampa.Player.loading(true);

    prepareGstReplica(sources, ordinal, position, function (json, selectedSource, orderedSources) {
      if (!ownsPlayer(data)) return;
      if (!json) {
        Lampa.Player.loading(false);
        Lampa.Noty.show('Аудиодорожка GStreamer недоступна');
        return;
      }
      var hls = json.hls + '?audio=' + ordinal;
      data.pidtor_gst_warm = json;
      data.pidtor_source_url = selectedSource;
      data.pidtor_source_urls = orderedSources;
      data.url = hls;
      data.url_orig = hls;
      var previousSource = videoElement() && videoElement().currentSrc || '';
      Lampa.PlayerVideo.destroy(true);
      Lampa.PlayerVideo.url(hls, true);
      startPlaybackMonitor(data);
      restorePosition(position, function () {
        Lampa.Player.loading(false);
        installPlayerControls(data);
      }, previousSource, data);
    });
  }

  function buildAudioItems(data) {
    var choices = data.pidtor_audio_options || [];
    return choices.map(function (choice, index) {
      var item = {
        index: index,
        language: String(choice.track.language || '').toUpperCase(),
        label: choice.title,
        selected: data.pidtor_audio_key === choice.key
      };
      Object.defineProperty(item, 'enabled', {
        set: function (enabled) {
          if (!enabled || !ownsPlayer(data)) return;
          if (data.pidtor_use_gst !== true && sameVariantFile(data.pidtor_variant, choice.variant) && !selectNativeAudio(choice.order)) {
            Lampa.Noty.show('Браузер не поддерживает переключение дорожек. Откройте во внешнем плеере.');
            return;
          }
          data.pidtor_audio_key = choice.key;
          if (data.pidtor_use_gst === true) {
            if (sameVariantFile(data.pidtor_variant, choice.variant)) {
              replaceGstAudio(data, choice);
              return;
            }
            choice.resolve(function (resolved) {
              if (!ownsPlayer(data)) return;
              replaceGstAudio(data, choice, resolved);
            }, function (message) { Lampa.Noty.show(message || 'Аудиодорожка недоступна'); });
            return;
          }
          data.pidtor_audio_stream_index = parseInt(choice.track.stream_index, 10);
          data.pidtor_audio_ffprobe_index = data.pidtor_audio_stream_index;
          emitResumeState(data);
          if (sameVariantFile(data.pidtor_variant, choice.variant)) {
            selectNativeAudio(choice.order);
            installPlayerControls(data);
            return;
          }
          choice.resolve(function (resolved) {
            replaceSource(data, resolved, choice.variant, function () { selectNativeAudio(choice.order); });
          }, function (message) { Lampa.Noty.show(message || 'Аудиодорожка недоступна'); });
        },
        get: function () { return item.selected; }
      });
      return item;
    });
  }

  function buildSubtitleItems(data) {
    var choices = data.pidtor_subtitle_options || [];
    return choices.map(function (choice, index) {
      var item = {
        index: index,
        language: String(choice.track.language || '').toUpperCase(),
        label: choice.title,
        selected: data.pidtor_subtitle_key === choice.key
      };
      Object.defineProperty(item, 'mode', {
        set: function (mode) {
          if (mode !== 'showing' || !ownsPlayer(data)) return;
          data.pidtor_subtitle_key = choice.key;
          emitResumeState(data);
          if (sameVariantFile(data.pidtor_variant, choice.variant)) {
            selectNativeSubtitle(choice.order);
            installPlayerControls(data);
            return;
          }
          choice.resolve(function (resolved) {
            replaceSource(data, resolved, choice.variant, function () { selectNativeSubtitle(choice.order); });
          }, function (message) { Lampa.Noty.show(message || 'Субтитры недоступны'); });
        },
        get: function () { return item.selected ? 'showing' : 'disabled'; }
      });
      return item;
    });
  }

  function buildQualityItems(data) {
    return (data.pidtor_quality_options || []).map(function (option) {
      var item = { title: option.key, selected: option.key === data.pidtor_quality_key };
      Object.defineProperty(item, 'enabled', {
        set: function (enabled) {
          if (!enabled || !ownsPlayer(data) || option.key === data.pidtor_quality_key) return;
          var previousAudio = currentChoice(data, 'audio');
          var previousSubtitle = currentChoice(data, 'subtitle');
          followQualityTracks(option, data);
          option.resolve(function (resolved) {
            if (!ownsPlayer(data)) return;
            var activeIds = resolvedVariantIds(resolved);
            var audioOptions = availableChoices(option.audio_options, activeIds);
            var subtitleOptions = availableChoices(option.subtitle_options, activeIds);
            var targetAudio = preferredChoice(audioOptions, previousAudio, true);
            var targetSubtitle = preferredChoice(subtitleOptions.filter(function (choice) {
              return sameVariantFile(choice.variant, targetAudio ? targetAudio.variant : resolved.variant);
            }), previousSubtitle, false);
            if (targetAudio && !sameVariantFile(targetAudio.variant, resolved.variant)) {
              targetAudio.resolve(function (audioResolved) {
                applyResolved(resolvedWithChoice(audioResolved, targetAudio, 'audio'), audioOptions, subtitleOptions, targetAudio, targetSubtitle);
              }, function (message) { Lampa.Noty.show(message || 'Аудиодорожка недоступна'); });
              return;
            }
            applyResolved(resolvedWithChoice(resolved, targetAudio, 'audio'), audioOptions, subtitleOptions, targetAudio, targetSubtitle);
          }, function (message) { Lampa.Noty.show(message || 'Качество недоступно'); });

          function applyResolved(resolved, audioOptions, subtitleOptions, targetAudio, targetSubtitle) {
            if (!ownsPlayer(data)) return;
            data.pidtor_quality_key = option.key;
            data.pidtor_tracks_ready = resolved.tracks_ready === true;
            data.pidtor_audio_options = audioOptions;
            data.pidtor_subtitle_options = subtitleOptions;
            data.pidtor_audio_key = targetAudio ? targetAudio.key : '';
            data.pidtor_subtitle_key = targetSubtitle ? targetSubtitle.key : '';
            data.pidtor_audio_stream_index = targetAudio
              ? parseInt(data.pidtor_use_gst === true ? targetAudio.order : targetAudio.track.stream_index, 10)
              : 0;
            data.pidtor_audio_ffprobe_index = targetAudio ? parseInt(targetAudio.track.stream_index, 10) : -1;
            emitResumeState(data);
            if (data.pidtor_use_gst === true && targetAudio) {
              replaceGstAudio(data, targetAudio, resolved);
              return;
            }
            replaceSource(data, resolved, resolved.variant || (targetAudio && targetAudio.variant) || option.variant, function () {
              if (targetAudio) selectNativeAudio(targetAudio.order);
              if (targetSubtitle) selectNativeSubtitle(targetSubtitle.order);
            });
          }
        },
        get: function () { return item.selected; }
      });
      return item;
    });
  }

  function installPlayerControls(data) {
    if (!data || !data.pidtor_nextgen || !ownsPlayer(data)) return;
    var qualities = buildQualityItems(data);
    if (qualities.length) {
      var current = data.pidtor_quality_key || qualities[0].title;
      // setLevels is write-once in Lampa; quality replaces the previous player's callbacks.
      if (Lampa.PlayerPanel.quality) Lampa.PlayerPanel.quality(qualities);
      else Lampa.PlayerPanel.setLevels(qualities, current);
      $('.player-panel__quality').text(current);
    }
    var audio = buildAudioItems(data);
    // Explicit voiceovers prevent Lampa's native empty audioTracks event from erasing these choices.
    data.voiceovers = audio;
    data.translate = {};
    if (Lampa.PlayerPanel.setTranslate) Lampa.PlayerPanel.setTranslate(data.translate);
    Lampa.PlayerPanel.setTracks(audio);
    var subtitles = buildSubtitleItems(data);
    Lampa.PlayerPanel.setSubs(subtitles);
    var selectedAudio = currentChoice(data, 'audio');
    var selectedSubtitle = currentChoice(data, 'subtitle');
    if (selectedAudio) selectNativeAudio(selectedAudio.order);
    if (selectedSubtitle) selectNativeSubtitle(selectedSubtitle.order);
  }

  function stopPlaybackMonitor() {
    if (!playbackMonitor) return;
    clearInterval(playbackMonitor);
    playbackMonitor = null;
  }

  function startPlaybackMonitor(data) {
    if (!ownsPlayer(data)) return;
    stopPlaybackMonitor();
    if (!data || !data.pidtor_nextgen) return;
    var lastPosition = -1;
    var lastAdvance = Date.now();
    var fallbackStarted = false;
    var hasAdvanced = false;

    function failover() {
      if (fallbackStarted || !ownsPlayer(data)) return;

      var failedSources = data.pidtor_failed_sources || {};
      var currentSource = String(data.pidtor_source_url || data.url || '');
      if (currentSource) failedSources[currentSource] = true;
      data.pidtor_failed_sources = failedSources;
      var alternateSources = (data.pidtor_source_urls || []).filter(function (source) {
        return source && !failedSources[String(source)];
      });
      var failedCount = Object.keys(failedSources).length;
      if (alternateSources.length && failedCount < 3) {
        fallbackStarted = true;
        var alternate = alternateSources[0];
        var orderedSources = [alternate].concat((data.pidtor_source_urls || []).filter(function (source) {
          return source !== alternate;
        }));
        Lampa.Noty.show('Поток завис, пробую другую копию ' + data.pidtor_quality_key);
        replaceSource(data, { url: alternate, sources: orderedSources, episodes: [] }, data.pidtor_variant);
        stopPlaybackMonitor();
        setTimeout(function () { startPlaybackMonitor(data); }, 1500);
        return;
      }

      var options = data.pidtor_quality_options || [];
      var current = options.filter(function (option) { return option.key === data.pidtor_quality_key; })[0];
      var currentPriority = current ? playbackPriority(current.variant) : 0;
      var candidates = options.filter(function (option) {
        return option.key !== data.pidtor_quality_key;
      }).sort(function (a, b) {
        return playbackPriority(b.variant) - playbackPriority(a.variant)
          || qualityRank(b.variant) - qualityRank(a.variant)
          || seeders(b.variant) - seeders(a.variant);
      });
      var target = candidates.filter(function (option) {
        return playbackPriority(option.variant) > currentPriority;
      })[0] || candidates[0];
      if (!target) {
        stopPlaybackMonitor();
        Lampa.Player.loading(false);
        Lampa.Noty.show('Торрент не отдаёт данные');
        setTimeout(function () {
          try {
            if (ownsPlayer(data) && Lampa.Player.opened && Lampa.Player.opened()) Lampa.Player.close();
          } catch (e) {}
        }, 500);
        return;
      }

      fallbackStarted = true;
      data.pidtor_failed_sources = {};
      var quality = buildQualityItems(data).filter(function (item) { return item.title === target.key; })[0];
      if (!quality) {
        stopPlaybackMonitor();
        return;
      }
      Lampa.Noty.show('Поток завис, переключаю на ' + target.key);
      quality.enabled = true;
      stopPlaybackMonitor();
      setTimeout(function () { startPlaybackMonitor(data); }, 1500);
    }

    playbackMonitor = setInterval(function () {
      if (!ownsPlayer(data)) return;
      var video = videoElement();
      var stallTimeout = hasAdvanced ? 14000 : (data.pidtor_use_gst === true ? 30000 : 15000);
      if (!video) {
        if (Date.now() - lastAdvance >= stallTimeout) failover();
        return;
      }
      if (video.ended) return;
      var position = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      if (video.seeking || (video.paused && video.readyState >= 2)) {
        lastPosition = position;
        lastAdvance = Date.now();
        return;
      }
      if (video.readyState >= 2 && position > 0 && position > lastPosition + 0.2) {
        lastPosition = position;
        lastAdvance = Date.now();
        hasAdvanced = true;
        return;
      }
      if (Date.now() - lastAdvance >= stallTimeout) failover();
    }, 2000);
  }

  function schedulePlayerControls(data, refresh) {
    if (refresh && !ownsPlayer(data)) return;
    if (!refresh) playbackRequestGeneration++;
    activeControlsData = data && data.pidtor_nextgen ? data : null;
    playerControlsGeneration++;
    stopPlaybackMonitor();
    if (!activeControlsData) return;
    (data.pidtor_quality_options || []).forEach(function (resolver) { followQualityTracks(resolver, data); });
    if (data.pidtor_tracks_ready !== true) {
      var option = (data.pidtor_quality_options || []).filter(function (item) { return item.key === data.pidtor_quality_key; })[0];
      if (option) {
        var pendingGeneration = ++playerControlsGeneration;
        installPlayerControls(data);
        Lampa.Player.loading(true);
        // Cached resolution can be synchronous; let Lampa finish its own start/Video.url first.
        setTimeout(function () {
          if (pendingGeneration !== playerControlsGeneration || !ownsPlayer(data)) return;
          option.resolve(function (resolved) {
            if (pendingGeneration !== playerControlsGeneration || !ownsPlayer(data)) return;
            var audio = preferredStoredChoice(option.audio_options, data.pidtor_audio_key, currentChoice(data, 'audio'), true);
            resolved = resolvedWithChoice(resolved, audio, 'audio');
            var subtitles = (option.subtitle_options || []).filter(function (choice) { return sameVariantFile(choice.variant, resolved.variant); });
            var subtitle = preferredStoredChoice(subtitles, data.pidtor_subtitle_key, currentChoice(data, 'subtitle'), false);
            data.pidtor_audio_options = option.audio_options || [];
            data.pidtor_subtitle_options = option.subtitle_options || [];
            data.pidtor_audio_key = audio ? audio.key : '';
            data.pidtor_subtitle_key = subtitle ? subtitle.key : '';
            data.pidtor_audio_stream_index = audio ? parseInt(data.pidtor_use_gst === true ? audio.order : audio.track.stream_index, 10) : 0;
            data.pidtor_audio_ffprobe_index = audio ? parseInt(audio.track.stream_index, 10) : -1;
            data.pidtor_source_records = resolved.source_records;
            data.pidtor_variant = resolved.variant;
            data.ffprobe = variantStreams(resolved.variant);
            data.pidtor_tracks_ready = true;
            schedulePlayerControls(data, true);
            if (data.pidtor_use_gst === true && audio) replaceGstAudio(data, audio, resolved);
            else replaceSource(data, resolved, resolved.variant, function () {
              if (audio) selectNativeAudio(audio.order);
              if (subtitle) selectNativeSubtitle(subtitle.order);
            });
          }, function (message) {
            if (pendingGeneration !== playerControlsGeneration) return;
            Lampa.Player.loading(false);
            Lampa.Noty.show(message || 'Не удалось открыть доступную копию');
          });
        }, 0);
        return;
      }
    }
    // A Select opened from the previous player instance must not survive an
    // episode switch. Lampa hides it on normal navigation, but a playlist
    // selection replaces PlayerVideo without destroying the whole player.
    closePlayerSelect();
    setTimeout(closePlayerSelect, 0);
    emitResumeState(data);
    startPlaybackMonitor(data);
    var generation = ++playerControlsGeneration;
    var attempts = 0;
    function apply() {
      if (generation !== playerControlsGeneration || !ownsPlayer(data)) return;
      attempts++;
      installPlayerControls(data);
      if (attempts < 40) setTimeout(apply, 500);
    }
    apply();
  }

  function closePlayerSelect() {
    if (!Lampa.Select) return;
    if ($('body').hasClass('selectbox--open')) {
      if (Lampa.Select.close) Lampa.Select.close();
      else if (Lampa.Select.hide) Lampa.Select.hide();
    } else if (Lampa.Activity && Lampa.Activity.mixState) {
      Lampa.Activity.mixState();
    }
  }

  function PidTorComponent(object) {
    var self = this;
    var explorer = new Lampa.Explorer(object);
    var filter = new Lampa.Filter(object);
    var scroll = new Lampa.Scroll({ mask: true, over: true });
    var requests = [];
    var resolutionRequests = [];
    var responseCache = {};
    var responseWaiters = {};
    var resolutionCache = {};
    var resolutionWaiters = {};
    var resolutionUpdates = {};
    var episodeMetadata = {};
    var warmedEpisodes = {};
    var episodeWarmTimer = null;
    var seasonGeneration = 0;
    var last = null;
    var directResumePopped = false;
    var season = 1;
    var seasonCount = Math.max(1, parseInt(object.movie.number_of_seasons || 1, 10));
    var seasonChoice = Lampa.Storage.get('pidtor_season_choice', '{}') || {};
    var seasonChoiceKey = String(object.movie.source || 'tmdb') + ':' + String(object.movie.tmdb_id || object.movie.id || 0);
    var resumeParams = object.pidtor_resume && typeof object.pidtor_resume === 'object' ? object.pidtor_resume : null;
    if (resumeParams && parseInt(resumeParams.season || 0, 10) > 0) {
      season = Math.max(1, Math.min(seasonCount, parseInt(resumeParams.season, 10) || 1));
    } else if (seasonChoice[seasonChoiceKey] || seasonChoice[object.movie.id]) {
      season = Math.max(1, Math.min(seasonCount, parseInt(seasonChoice[seasonChoiceKey] || seasonChoice[object.movie.id], 10) || 1));
    }

    function request(url, complete, error, timeout) {
      var network = new Lampa.Reguest();
      requests.push(network);
      network.timeout(timeout || 30000);
      network['native'](account(url), complete, error || function () {
        Lampa.Noty.show('PidTor временно недоступен');
      });
      return network;
    }

    function abortResolutionRequests() {
      resolutionRequests.forEach(function (network) {
        try { network.clear(); } catch (e) {}
      });
      resolutionRequests = [];
      resolutionWaiters = {};
      resolutionUpdates = {};
      if (episodeWarmTimer) clearTimeout(episodeWarmTimer);
      episodeWarmTimer = null;
      warmedEpisodes = {};
    }

    function popDirectResumeActivity() {
      if (!object.pidtor_resume_direct || directResumePopped) return;
      directResumePopped = true;
      try {
        var active = Lampa.Activity && Lampa.Activity.active ? Lampa.Activity.active() : null;
        if (active && active.component === 'pidtor_nextgen') Lampa.Activity.backward();
      } catch (e) {}
    }

    function loadV2(seasonNumber, episodeNumber, complete, error) {
      var key = String(seasonNumber);
      if (responseCache[key]) {
        complete(responseCache[key]);
        return;
      }
      if (responseWaiters[key]) {
        responseWaiters[key].push({ complete: complete, error: error });
        return;
      }
      responseWaiters[key] = [{ complete: complete, error: error }];

      function resolveWaiters(data, message) {
        var waiters = responseWaiters[key] || [];
        delete responseWaiters[key];
        waiters.forEach(function (waiter) {
          if (data) waiter.complete(data);
          else if (waiter.error) waiter.error(message);
        });
      }

      request(API + '/lite/pidtor/v2?' + query(object.movie, seasonNumber, episodeNumber), function (data) {
        if (!data || !Array.isArray(data.variants) || !data.variants.length) {
          resolveWaiters(null, 'Подходящих вариантов не найдено');
          return;
        }
        if (Array.isArray(data.seasons) && data.seasons.length) {
          seasonCount = Math.max(seasonCount, data.seasons.reduce(function (maximum, item) {
            return Math.max(maximum, parseInt(item.season || 0, 10));
          }, 1));
          setFilter();
        }
        responseCache[key] = data;
        resolveWaiters(data);
      }, function () {
        resolveWaiters(null, 'PidTor временно недоступен');
      }, 45000);
    }

    function parseEpisodes(json) {
      return json && Array.isArray(json.data) ? json.data : [];
    }

    function resolveOption(option, episodeNumber, complete, error, update) {
      var resolveSeason = season;
      var movieKey = String(object.movie.source || 'tmdb') + '|' + String(object.movie.id || object.movie.tmdb_id || '') + '|' + normalized(object.movie.original_title || object.movie.original_name || object.movie.title || object.movie.name || '');
      var cacheKey = movieKey + '|r7|' + resolveSeason + '|' + option.key;
      var cached = resolutionCache[cacheKey] || getEpisodeResolution(cacheKey);
      if (cached && !resolutionCache[cacheKey]) resolutionCache[cacheKey] = cached;

      function forEpisode(resolved) {
        if (!isSerial(object.movie)) return resolved;
        var selected = (resolved.episodes || []).filter(function (item) {
          return parseInt(item.e || 0, 10) === parseInt(episodeNumber, 10);
        })[0];
        if (!selected) return null;
        return {
          url: selected.url,
          sources: selected.pidtor_source_urls || [selected.url],
          source_records: selected.pidtor_source_records || [],
          episodes: resolved.episodes,
          variant: selected.pidtor_variant || resolved.variant,
          media_name: selected.name || selected.media_name || '',
          available_variant_ids: selected.pidtor_available_variant_ids || [],
          requested_episode: parseInt(episodeNumber, 10)
        };
      }

      if (update && (!cached || cached.resolution_pending)) {
        if (!resolutionUpdates[cacheKey]) resolutionUpdates[cacheKey] = [];
        resolutionUpdates[cacheKey].push(function (resolved) {
          var selected = forEpisode(resolved);
          if (selected) update(selected);
        });
      }
      if (cached && (!cached.resolution_pending || forEpisode(cached))) {
        var cachedEpisode = forEpisode(cached);
        if (cachedEpisode) complete(cachedEpisode);
        else error('Серия недоступна в этом качестве');
        return;
      }

      var waitKey = cacheKey + '|' + parseInt(episodeNumber || 0, 10);
      if (resolutionWaiters[waitKey]) {
        resolutionWaiters[waitKey].push({ complete: complete, error: error });
        return;
      }
      resolutionWaiters[waitKey] = [];
      var originalComplete = complete;
      var originalError = error;
      complete = function (resolved) {
        var waiters = resolutionWaiters[waitKey] || [];
        delete resolutionWaiters[waitKey];
        originalComplete(resolved);
        waiters.forEach(function (waiter) { waiter.complete(resolved); });
      };
      error = function (message) {
        var waiters = resolutionWaiters[waitKey] || [];
        delete resolutionWaiters[waitKey];
        originalError(message);
        waiters.forEach(function (waiter) { if (waiter.error) waiter.error(message); });
      };

      var candidates = [];
      var candidateSeen = {};
      (option.variants || [option.variant]).forEach(function (variant) {
        (variant.replicas || []).forEach(function (replica) {
          var id = replicaKey(replica);
          if (!id || candidateSeen[id]) return;
          candidateSeen[id] = true;
          candidates.push({ variant: variant, replica: replica });
        });
      });
      candidates.sort(function (a, b) {
        var preferredA = option.variant && a.variant.id === option.variant.id ? 1 : 0;
        var preferredB = option.variant && b.variant.id === option.variant.id ? 1 : 0;
        return preferredB - preferredA || parseInt(b.replica.seeders || 0, 10) - parseInt(a.replica.seeders || 0, 10);
      });

      function uniqueSources(records) {
        var seen = {};
        return (records || []).sort(function (a, b) { return b.seeders - a.seeders; }).filter(function (record) {
          if (!record.url || seen[record.url]) return false;
          seen[record.url] = true;
          return true;
        });
      }

      if (!isSerial(object.movie)) {
        var movieSources = uniqueSources(candidates.map(function (candidate) {
          var record = { url: candidate.replica.stream_url, seeders: candidate.replica.seeders, replica: candidate.replica, variant: candidate.variant };
          record.variant = fileVariant(record);
          return record;
        }));
        if (!movieSources.length) {
          error('Не удалось открыть доступную копию');
          return;
        }
        var movieResolved = {
          url: movieSources[0].url,
          sources: movieSources.map(function (item) { return item.url; }),
          source_records: movieSources,
          episodes: [],
          variant: movieSources[0].variant,
          requested_episode: 0
        };
        resolutionCache[cacheKey] = movieResolved;
        storeEpisodeResolution(cacheKey, movieResolved);
        complete(movieResolved);
        return;
      }

      var candidateStates = candidates.filter(function (candidate) { return !!candidate.replica.episodes_url; }).map(function (candidate) {
        return { candidate: candidate, done: false, usable: false };
      });
      var episodeLists = [];
      var sourcesByEpisode = {};
      var settled = false;
      var mergeTimer = null;
      if (!candidateStates.length) {
        error('Не удалось открыть доступную копию');
        return;
      }

      function completeResolved() {
        var episodeNumbers = Object.keys(sourcesByEpisode).map(function (number) {
          return parseInt(number, 10);
        }).filter(function (number) { return number > 0; }).sort(function (a, b) { return a - b; });
        var metadataByEpisode = {};
        episodeLists.sort(function (a, b) {
          return b.episodes.length - a.episodes.length || b.seeders - a.seeders;
        });
        var seasonReplica = episodeLists[0] ? episodeLists[0].replica : '';
        var requestedSources = uniqueSources((sourcesByEpisode[episodeNumber] || []).slice());
        if (!requestedSources.length) {
          if (candidateStates.some(function (state) { return !state.done; })) return;
          error('Не удалось открыть доступную копию');
          return;
        }
        episodeLists.forEach(function (list) {
          list.episodes.forEach(function (item) {
            var number = parseInt(item.e || 0, 10);
            if (number && !metadataByEpisode[number]) metadataByEpisode[number] = item;
          });
        });
        var episodes = episodeNumbers.map(function (number) {
          var item = metadataByEpisode[number] || { e: number, s: resolveSeason, title: 'Серия ' + number };
          var copy = {};
          for (var key in item) copy[key] = item[key];
          var records = uniqueSources((sourcesByEpisode[number] || []).slice());
          if (number !== parseInt(episodeNumber, 10) && seasonReplica) {
            records.sort(function (a, b) {
              return (b.replica === seasonReplica ? 1 : 0) - (a.replica === seasonReplica ? 1 : 0) || b.seeders - a.seeders;
            });
          }
          copy.url = records[0] ? records[0].url : copy.url;
          copy.pidtor_source_urls = records.map(function (record) { return record.url; });
          copy.pidtor_source_records = records.map(function (record) {
            return { url: record.url, variant: fileVariant(record), replica: cloneMetadata(record.replica_data) };
          });
          copy.pidtor_variant = copy.pidtor_source_records[0] ? copy.pidtor_source_records[0].variant : null;
          copy.pidtor_available_variant_ids = records.map(function (record) {
            return record.variant && record.variant.id;
          }).filter(function (id, index, all) { return id && all.indexOf(id) === index; });
          return copy;
        });
        var resolved = {
          url: requestedSources[0].url,
          sources: requestedSources.map(function (record) { return record.url; }),
          source_records: requestedSources.map(function (record) {
            return { url: record.url, variant: fileVariant(record), replica: cloneMetadata(record.replica_data) };
          }),
          episodes: episodes,
          variant: fileVariant(requestedSources[0]),
          available_variant_ids: requestedSources.map(function (record) {
            return record.variant && record.variant.id;
          }).filter(function (id, index, all) { return id && all.indexOf(id) === index; }),
          requested_episode: parseInt(episodeNumber, 10),
          resolution_pending: candidateStates.some(function (state) { return !state.done; })
        };
        resolutionCache[cacheKey] = resolved;
        if (!resolved.resolution_pending) storeEpisodeResolution(cacheKey, resolved);
        if (mergeTimer) clearTimeout(mergeTimer);
        if (!settled) {
          settled = true;
          complete(forEpisode(resolved));
        } else {
          (resolutionUpdates[cacheKey] || []).forEach(function (notify) { notify(resolved); });
        }
        if (!resolved.resolution_pending) delete resolutionUpdates[cacheKey];
      }

      function tryComplete() {
        if (candidateStates.some(function (state) { return state.usable; })) completeResolved();
        else if (!candidateStates.some(function (state) { return !state.done; })) {
          delete resolutionUpdates[cacheKey];
          error('Не удалось открыть доступную копию');
        }
      }

      var nextCandidate = 0;
      var activeCandidates = 0;
      function pumpCandidates() {
        while (activeCandidates < 3 && nextCandidate < candidateStates.length) {
          startCandidate(candidateStates[nextCandidate++]);
        }
      }
      function startCandidate(state) {
        activeCandidates++;
        var candidate = state.candidate;
        var replica = candidate.replica;
        state.request = request(replica.episodes_url, function (json) {
          var episodes = parseEpisodes(json);
          if (episodes.length) episodeLists.push({ episodes: episodes, variant: candidate.variant, seeders: replica.seeders, replica: replicaKey(replica) });
          episodes.forEach(function (item) {
            var number = parseInt(item.e || 0, 10);
            if (!number || !item.url) return;
            if (!sourcesByEpisode[number]) sourcesByEpisode[number] = [];
            sourcesByEpisode[number].push({ url: item.url, seeders: replica.seeders, variant: candidate.variant, replica: replicaKey(replica), replica_data: replica });
          });
          state.usable = episodes.some(function (item) {
            return parseInt(item.e || 0, 10) === parseInt(episodeNumber, 10) && !!item.url;
          });
          state.done = true;
          activeCandidates--;
          tryComplete();
          pumpCandidates();
        }, function () {
          state.done = true;
          activeCandidates--;
          tryComplete();
          pumpCandidates();
        }, 30000);
        resolutionRequests.push(state.request);
      }
      pumpCandidates();
    }

    function trackResolvers(option, episodeNumber, field, allowedVariantIds) {
      var allowed = {};
      (allowedVariantIds || []).forEach(function (id) { allowed[String(id)] = true; });
      var source = option;
      if (Object.keys(allowed).length) {
        var variants = (option.variants || [option.variant]).filter(function (variant) {
          return variant && allowed[String(variant.id)];
        });
        source = { variant: variants[0] || option.variant, variants: variants };
      }
      return mergedTrackChoices(source, field).map(function (choice, index) {
        return {
          key: option.key + '|' + field + '|' + choiceIdentity(choice),
          title: choice.title,
          track: choice.track,
          variant: choice.variant,
          order: choice.order,
          resolve: function (complete, error) {
            resolveOption({ key: option.key + '|' + choice.variant.id, variant: choice.variant, variants: [choice.variant] }, episodeNumber, function (resolved) {
              if (field === 'audio') {
                resolved.url = sourceWithAudio(resolved.url, choice.track.stream_index);
                resolved.sources = (resolved.sources || []).map(function (source) { return sourceWithAudio(source, choice.track.stream_index); });
              }
              complete(resolved);
            }, error);
          }
        };
      });
    }

    function optionResolvers(options, episodeNumber, selected, selectedVariantIds, knownResolved) {
      return options.map(function (option) {
        var result = {
          key: option.key,
          label: option.label,
          selected: option === selected,
          variant: option.variant,
          resolve: function (complete, error, deadline) {
            function hydrate(resolved, ready) {
              resolved = preferResolvedFile(resolved, result.preferred_file_key);
              hydrateResolved(resolved, function (hydrated) {
                publishOptionTracks(result, option, hydrated);
                if (ready) complete(Object.assign({}, hydrated, {
                  url: account(hydrated.url),
                  sources: (hydrated.sources || [hydrated.url]).map(account)
                }));
              }, function (hydrated) { publishOptionTracks(result, option, hydrated); }, deadline, true);
            }
            resolveOption(option, episodeNumber, function (resolved) { hydrate(resolved, true); }, error,
              function (resolved) { hydrate(resolved, false); });
          }
        };
        result.audio_options = option === selected && knownResolved && knownResolved.tracks_ready
          ? resolvedTrackChoices(option, knownResolved, 'audio') : [];
        result.subtitle_options = option === selected && knownResolved && knownResolved.tracks_ready
          ? resolvedTrackChoices(option, knownResolved, 'subtitles') : [];
        result.episode_number = episodeNumber;
        if (option.track_batch && option.track_batch.episode_number === episodeNumber) {
          Object.defineProperty(result, 'track_batch', { value: option.track_batch, configurable: true });
        }
        return result;
      });
    }

    function playerItem(meta, url, options, selected, sources, useGst, activeVariant, preferences) {
      var episodeNumber = parseInt(meta.e || meta.episode_number || meta.number || 0, 10);
      var seasonNumber = parseInt(meta.s || meta.season_number || season || 0, 10);
      var knownEpisode = episodeMetadata[seasonNumber + '|' + episodeNumber] || {};
      var manifestUrl = account(API + '/lite/pidtor/v2?' + query(object.movie, seasonNumber, episodeNumber));
      var qualityResolvers = optionResolvers(options, episodeNumber, selected, meta.pidtor_available_variant_ids, {
        url: url, sources: sources || meta.pidtor_source_urls || [url], source_records: meta.pidtor_source_records || [],
        variant: activeVariant || meta.pidtor_variant, requested_episode: episodeNumber, tracks_ready: meta.pidtor_tracks_ready === true
      });
      var selectedResolver = qualityResolvers.filter(function (item) { return item.key === selected.key; })[0] || qualityResolvers[0];
      var variant = activeVariant || meta.pidtor_variant || selected.variant;
      var mediaName = meta.media_name || meta.name || '';
      var nativePlayable = canPlayResolvedNatively(variant, mediaName);
      useGst = false;
      preferences = preferences || {};
      var initialAudio = preferredStoredChoice(
        selectedResolver ? selectedResolver.audio_options : [],
        preferences.pidtor_audio_key || '',
        null,
        true
      );
      var audioRecord = initialAudio && (meta.pidtor_source_records || []).filter(function (record) {
        return record.variant.source_file_key === initialAudio.variant.source_file_key && record.variant.id === initialAudio.variant.id;
      })[0];
      if (audioRecord) {
        url = audioRecord.url;
        variant = audioRecord.variant;
      }
      var exactSources = (meta.pidtor_source_records || []).filter(function (record) {
        return record.variant.source_file_key === variant.source_file_key && record.variant.id === variant.id;
      }).map(function (record) { return record.url; });
      if (exactSources.length) sources = exactSources;
      var initialSubtitle = preferredStoredChoice(
        selectedResolver ? selectedResolver.subtitle_options.filter(function (choice) { return choice.variant.source_file_key === variant.source_file_key; }) : [],
        preferences.pidtor_subtitle_key || '',
        null,
        false
      );
      var still = knownEpisode.still_path || knownEpisode.img || '';
      var image = still && String(still).charAt(0) === '/'
        ? Lampa.TMDB.image('t/p/w300' + still)
        : still;
      var gstAudioIndex = initialAudio ? parseInt(initialAudio.order || 0, 10) : 0;
      var ffprobeAudioIndex = initialAudio ? parseInt(initialAudio.track.stream_index, 10) : -1;
      var item = {
        title: knownEpisode.title || knownEpisode.name || meta.title || meta.name || ('Серия ' + episodeNumber),
        url: account(sourceForPlayback(url, useGst === true, useGst === true ? gstAudioIndex : undefined)),
        url_orig: account(sourceForPlayback(url, useGst === true, useGst === true ? gstAudioIndex : undefined)),
        img: image,
        image: image,
        poster: image,
        thumbnail: image,
        still_path: image,
        season: seasonNumber,
        episode: episodeNumber,
        timeline: timeline(object.movie, seasonNumber, episodeNumber),
        pidtor_nextgen: true,
        pidtor_manifest_schema: 1,
        pidtor_manifest_url: manifestUrl,
        pidtor_use_gst: useGst === true,
        pidtor_gst_bypass: true,
        pidtor_native_playable: nativePlayable,
        pidtor_tracks_ready: meta.pidtor_tracks_ready === true,
        pidtor_media_name: mediaName,
        pidtor_source_url: account(url),
        pidtor_source_urls: (sources || meta.pidtor_source_urls || [url]).map(function (source) {
          return account(source);
        }),
        pidtor_source_records: (meta.pidtor_source_records || []).map(function (record) {
          return { url: account(record.url), variant: record.variant, replica: record.replica };
        }),
        pidtor_available_variant_ids: meta.pidtor_available_variant_ids || [],
        pidtor_quality_key: selected.key,
        pidtor_audio_key: initialAudio ? initialAudio.key : '',
        pidtor_audio_stream_index: useGst === true ? gstAudioIndex : ffprobeAudioIndex,
        pidtor_audio_ffprobe_index: ffprobeAudioIndex,
        pidtor_subtitle_key: initialSubtitle ? initialSubtitle.key : '',
        hls_manifest_timeout: useGst === true ? 60000 : 15000,
        ffprobe: variantStreams(variant),
        torrent_hash: streamHash(url),
        card: object.movie,
        movie: object.movie,
        isonline: true
      };
      Object.defineProperty(item, 'pidtor_quality_options', { value: qualityResolvers, writable: true, configurable: true, enumerable: true });
      Object.defineProperty(item, 'pidtor_audio_options', { value: selectedResolver ? selectedResolver.audio_options : [], writable: true, configurable: true, enumerable: true });
      Object.defineProperty(item, 'pidtor_subtitle_options', { value: selectedResolver ? selectedResolver.subtitle_options : [], writable: true, configurable: true, enumerable: true });
      Object.defineProperty(item, 'pidtor_variant', { value: variant, writable: true, configurable: true, enumerable: true });
      return item;
    }

    function runtimeCopy(source) {
      var copy = {};
      for (var key in source) {
        if (key !== 'playlist') copy[key] = source[key];
      }
      ['pidtor_quality_options', 'pidtor_audio_options', 'pidtor_subtitle_options', 'pidtor_variant'].forEach(function (key) {
        if (typeof source[key] === 'undefined') return;
        Object.defineProperty(copy, key, { value: source[key], writable: true, configurable: true, enumerable: true });
      });
      return copy;
    }

    function transportCopy(source) {
      var keys = ['title', 'url', 'url_orig', 'img', 'image', 'poster', 'thumbnail', 'still_path', 'season', 'episode', 'timeline', 'playlist_index', 'start_index', 'file_index', 'pidtor_nextgen', 'pidtor_playlist_session', 'pidtor_manifest_schema', 'pidtor_manifest_url', 'pidtor_use_gst', 'pidtor_native_playable', 'pidtor_media_name', 'pidtor_gst_bypass', 'pidtor_tracks_ready', 'pidtor_source_url', 'pidtor_source_urls', 'pidtor_source_records', 'pidtor_available_variant_ids', 'pidtor_quality_key', 'pidtor_audio_key', 'pidtor_subtitle_key', 'pidtor_audio_stream_index', 'pidtor_audio_ffprobe_index', 'hls_manifest_timeout', 'ffprobe', 'torrent_hash', 'card', 'movie', 'isonline'];
      var copy = {};
      keys.forEach(function (key) {
        if (typeof source[key] !== 'undefined') copy[key] = source[key];
      });
      ['pidtor_quality_options', 'pidtor_audio_options', 'pidtor_subtitle_options', 'pidtor_variant'].forEach(function (key) {
        if (typeof source[key] === 'undefined') return;
        Object.defineProperty(copy, key, { value: source[key], writable: true, configurable: true, enumerable: true });
      });
      return copy;
    }

    function launch(data, meta, preferences, requestGeneration) {
      if (requestGeneration === undefined) requestGeneration = ++playbackRequestGeneration;
      if (requestGeneration !== playbackRequestGeneration) return;
      var options = qualityOptions(data);
      preferences = preferences || {};
      var selected = options.filter(function (option) {
        return preferences.pidtor_quality_key && option.key === preferences.pidtor_quality_key;
      })[0] || defaultQuality(options);
      if (!selected) {
        Lampa.Noty.show('Подходящих вариантов не найдено');
        return;
      }

      var episodeNumber = parseInt(meta.number, 10);
      var ordered = [selected].concat(options.filter(function (option) { return option !== selected; }));
      var attempted = {};
      var failedFiles = {};
      var probeDeadline = Date.now() + 90000;

      function nextAvailable(message) {
        if (requestGeneration !== playbackRequestGeneration) return;
        var next = ordered.filter(function (option) { return !attempted[option.key]; })[0];
        if (next) {
          startOption(next);
          return;
        }
        Lampa.Noty.show(message || 'Нет доступного качества для этой серии');
      }

      function startOption(activeOption) {
        if (requestGeneration !== playbackRequestGeneration) return;
        attempted[activeOption.key] = true;

        // Until an episode endpoint has returned a real file, the quality must
        // not be exposed in the player. This prevents a visible 4K option from
        // resolving to an absent episode or a dead torrent replica.
        var verifiedOptions = [activeOption];
        var launchResolvers = optionResolvers(verifiedOptions, episodeNumber, activeOption);
        var selectedResolver = launchResolvers[0];
        selectedResolver.failed_files = failedFiles;
        selectedResolver.preferred_file_key = resumeSourceKey(preferences.pidtor_audio_key || preferences.pidtor_subtitle_key);
        Object.defineProperty(activeOption, 'track_batch', { value: selectedResolver, writable: true, configurable: true });
        var initialAudio = preferredStoredChoice(
          selectedResolver ? selectedResolver.audio_options : [],
          preferences.pidtor_audio_key || '',
          null,
          true
        );

        var waitingForFile = false;
        var reconcileSeason = null;
        var refreshSeasonQuality = null;
        function receiveResolved(resolved) {
          if (requestGeneration !== playbackRequestGeneration) return;
          var records = (resolved.source_records || []).filter(function (record) {
            return !failedFiles[record.variant.source_file_key || rawGstSource(record.url)];
          });
          if (!records.length) {
            if (resolved.probe_pending) {
              waitingForFile = true;
              return;
            }
            return nextAvailable('Выбранное качество сейчас не раздаётся');
          }
          waitingForFile = false;
          resolved.source_records = records;
          resolved.url = records[0].url;
          resolved.sources = records.map(function (record) { return record.url; });
          resolved.variant = records[0].variant;
          resolved.episodes = (resolved.episodes || []).map(function (episode) {
            if (parseInt(episode.e || 0, 10) !== episodeNumber) return episode;
            return Object.assign({}, episode, {
              url: resolved.url, pidtor_source_urls: resolved.sources, pidtor_source_records: records, pidtor_variant: resolved.variant
            });
          });
          selectedResolver.audio_options = resolvedTrackChoices(activeOption, resolved, 'audio');
          selectedResolver.subtitle_options = resolvedTrackChoices(activeOption, resolved, 'subtitles');
          var activeIds = resolvedVariantIds(resolved);
          selectedResolver.audio_options = availableChoices(selectedResolver.audio_options, activeIds);
          selectedResolver.subtitle_options = availableChoices(selectedResolver.subtitle_options, activeIds);
          initialAudio = preferredChoice(selectedResolver.audio_options, initialAudio, true);

          var playback = [];
          var gst = useGstreamer(data);
          if (resolved.episodes.length) {
            playback = resolved.episodes.map(function (item) {
              return playerItem(item, item.url, verifiedOptions, activeOption, item.pidtor_source_urls, gst, item.pidtor_variant, preferences);
            });
          }
          var first = playback.filter(function (item) { return item.episode === episodeNumber; })[0]
            || playerItem(Object.assign({}, meta, {
              pidtor_source_records: records, pidtor_variant: resolved.variant, pidtor_tracks_ready: true,
              pidtor_available_variant_ids: resolvedVariantIds(resolved)
            }), resolved.url, verifiedOptions, activeOption, resolved.sources, gst, resolved.variant, preferences);
          var activeIndex = Math.max(0, playback.indexOf(first));
          playback.forEach(function (item, index) {
            item.playlist_index = index;
            item.start_index = index;
            item.file_index = index;
          });
          var launchItem = runtimeCopy(first);
          [launchItem, first].concat(playback).forEach(function (target) {
            target.pidtor_playlist_session = requestGeneration;
            if (parseInt(target.episode || 0, 10) === episodeNumber) followQualityTracks(selectedResolver, target);
          });
          launchItem.playlist_index = activeIndex;
          launchItem.start_index = activeIndex;
          launchItem.file_index = activeIndex;
          if (playback.length > 1) launchItem.playlist = playback.map(transportCopy);
          var qualityRefreshTimer = null;

          function ownsSeasonPlaylist() {
            return activeControlsData && activeControlsData.pidtor_nextgen
              && activeControlsData.pidtor_playlist_session === requestGeneration
              && activeControlsData.card && String(activeControlsData.card.id || '') === String(object.movie.id || '')
              && parseInt(activeControlsData.season || 0, 10) === parseInt(launchItem.season || 0, 10);
          }

          reconcileSeason = function (available, option) {
            if (!ownsSeasonPlaylist()) return;
            var live = Lampa.PlayerPlaylist && Lampa.PlayerPlaylist.get ? Lampa.PlayerPlaylist.get() : playback;
            var items = (live || []).slice();
            var added = false;
            (available.episodes || []).forEach(function (episode) {
              var number = parseInt(episode.e || 0, 10);
              if (!number || !episode.url || parseInt(episode.s || launchItem.season, 10) !== launchItem.season) return;
              if (items.some(function (item) { return item.episode === number && item.season === launchItem.season; })) return;
              var item = playerItem(episode, episode.url, [option], option, episode.pidtor_source_urls, false, episode.pidtor_variant, preferences);
              item.pidtor_playlist_session = requestGeneration;
              items.push(item);
              added = true;
            });
            if (!added) return;
            items.sort(function (a, b) { return a.episode - b.episode; });
            items.forEach(function (item, index) {
              item.playlist_index = index;
              item.start_index = index;
              item.file_index = index;
            });
            playback = items;
            launchItem.playlist = items.map(transportCopy);
            Lampa.Player.playlist(items);
          };

          function applyNativeFallback(target) {
            if (!target) return false;
            var records = (target.pidtor_source_records || []).filter(function (record) {
              return record && record.url && canPlayResolvedNatively(record.variant, target.pidtor_media_name || '');
            });
            if (!records.length) return false;
            var record = records[0];
            target.pidtor_use_gst = false;
            target.pidtor_native_playable = true;
            target.pidtor_variant = record.variant;
            target.pidtor_source_url = account(record.url);
            target.pidtor_source_urls = records.map(function (item) { return account(item.url); });
            target.url = account(record.url);
            target.url_orig = target.url;
            target.ffprobe = variantStreams(record.variant);
            target.torrent_hash = streamHash(record.url);
            return true;
          }

          function appendVerifiedQuality(option, available) {
            if (!ownsSeasonPlaylist()) return;
            reconcileSeason(available, option);
            var ids = resolvedVariantIds(available);

            var targets = [launchItem, first].concat(playback);
            var live = Lampa.PlayerPlaylist && Lampa.PlayerPlaylist.get ? Lampa.PlayerPlaylist.get() : [];
            targets = targets.concat(live || []);
            targets.forEach(function (target) {
              if (!target || !target.card || String(target.card.id || '') !== String(object.movie.id || '')
                  || parseInt(target.season || 0, 10) !== parseInt(launchItem.season || 0, 10)) return;
              if (available.episodes && !available.episodes.some(function (episode) {
                return parseInt(episode.e || 0, 10) === parseInt(target.episode || 0, 10);
              })) return;
              var resolver = optionResolvers([option], parseInt(target.episode || episodeNumber, 10), option, ids)[0];
              if (!resolver) return;
              resolver.selected = false;
              var list = target.pidtor_quality_options;
              if (!Array.isArray(list)) {
                Object.defineProperty(target, 'pidtor_quality_options', { value: [], writable: true, configurable: true, enumerable: true });
                list = target.pidtor_quality_options;
              }
              if (!list.some(function (item) { return item.key === resolver.key; })) list.push(resolver);
            });

            if (qualityRefreshTimer) clearTimeout(qualityRefreshTimer);
            qualityRefreshTimer = setTimeout(function () {
              if (ownsSeasonPlaylist()) installPlayerControls(activeControlsData);
            }, 100);
          }
          refreshSeasonQuality = appendVerifiedQuality;

          function validateOtherQualities() {
            var queue = options.filter(function (option) { return option !== activeOption; });
            var active = 0;
            var limit = 3;
            function pump() {
              if (!ownsSeasonPlaylist()) return;
              while (active < limit && queue.length) {
                (function (option) {
                  active++;
                  resolveOption(option, episodeNumber, function (available) {
                    appendVerifiedQuality(option, available);
                    active--;
                    pump();
                  }, function () {
                    active--;
                    pump();
                  }, function (available) { appendVerifiedQuality(option, available); });
                })(queue.shift());
              }
            }
            pump();
          }

          var startPlayer = function () {
            if (requestGeneration !== playbackRequestGeneration) return;
            popDirectResumeActivity();
            Lampa.Player.play(launchItem);
            Lampa.Player.playlist(playback.length ? playback : [first]);
            setTimeout(function () {
              if (!ownsPlayer(launchItem)) return;
              emitResumeState(launchItem);
              validateOtherQualities();
            }, 0);
          };
          if (launchItem.pidtor_use_gst === true) ensureGst(function () {
            var gstSource = launchItem.pidtor_source_url || launchItem.url;
            var gstAudio = parseInt(launchItem.pidtor_audio_stream_index || 0, 10);
            // Validate the first media segment. A successful /gst/add alone
            // does not guarantee that the chosen torrent replica can stream.
            var gstSources = [gstSource].concat(launchItem.pidtor_source_urls || []);
            prepareGstReplica(gstSources, gstAudio, launchItem.timeline && launchItem.timeline.time || 0, function (prepared, candidate, orderedSources) {
              if (!prepared) {
                var nativeReady = applyNativeFallback(launchItem);
                [first].concat(playback).forEach(function (item) { applyNativeFallback(item); });
                if (nativeReady) {
                  if (playback.length > 1) launchItem.playlist = playback.map(transportCopy);
                  startPlayer();
                  return;
                }
                failedFiles[launchItem.pidtor_variant.source_file_key || rawGstSource(gstSource)] = true;
                startOption(activeOption);
                return;
              }
              launchItem.pidtor_gst_warm = prepared;
              launchItem.pidtor_source_url = candidate;
              launchItem.pidtor_source_urls = orderedSources;
              launchItem.url = prepared.hls + '?audio=' + gstAudio;
              launchItem.url_orig = launchItem.url;
              startPlayer();
            });
          });
          else startPlayer();
        }
        selectedResolver.on_tracks_update = function (resolved) {
          if (waitingForFile) receiveResolved(resolved);
          else if (refreshSeasonQuality) refreshSeasonQuality(activeOption, resolved);
        };
        selectedResolver.resolve(receiveResolved, nextAvailable, probeDeadline);
      }

      startOption(selected);
    }

    function playEpisode(meta) {
      var requestGeneration = ++playbackRequestGeneration;
      self.activity.loader(true);
      loadV2(season, meta.number, function (data) {
        if (requestGeneration !== playbackRequestGeneration) return;
        self.activity.loader(false);
        launch(data, meta, resumeParams, requestGeneration);
      }, function (message) {
        if (requestGeneration !== playbackRequestGeneration) return;
        self.activity.loader(false);
        Lampa.Noty.show(message);
      });
    }

    function warmEpisode(episodeNumber, delay) {
      episodeNumber = parseInt(episodeNumber || 0, 10);
      if (!episodeNumber || warmedEpisodes[episodeNumber]) return;
      if (episodeWarmTimer) clearTimeout(episodeWarmTimer);
      episodeWarmTimer = setTimeout(function () {
        if (warmedEpisodes[episodeNumber]) return;
        warmedEpisodes[episodeNumber] = true;
        loadV2(season, episodeNumber, function (response) {
          var options = qualityOptions(response);
          var prepared = defaultQuality(options);
          if (!prepared) return;
          resolveOption(prepared, episodeNumber, function (resolved) {
            warmDirectSource(resolved.url);
          }, function () { delete warmedEpisodes[episodeNumber]; });
        }, function () { delete warmedEpisodes[episodeNumber]; });
      }, Math.max(0, parseInt(delay || 0, 10)));
    }

    function tmdbEpisodes(seasonNumber, complete) {
      Lampa.Api.seasons(object.movie, [seasonNumber], function (result) {
        var info = result && result[seasonNumber];
        complete(info && Array.isArray(info.episodes) ? info.episodes : []);
      });
    }

    function pidtorEpisodes(seasonNumber, complete) {
      loadV2(seasonNumber, -1, function (data) {
        var options = qualityOptions(data);
        var selected = defaultQuality(options);
        if (!selected) return complete([]);
        var replica = selected.variant.replicas && selected.variant.replicas[0];
        if (!replica || !replica.episodes_url) return complete([]);
        request(replica.episodes_url, function (json) { complete(parseEpisodes(json)); }, function () { complete([]); }, 30000);
      }, function () { complete([]); });
    }

    function draw(episodes) {
      scroll.clear();
      scroll.reset();
      last = null;
      episodeMetadata = {};

      episodes.forEach(function (episode, index) {
        var number = parseInt(episode.episode_number || episode.e || index + 1, 10);
        var airDate = episode.air_date ? new Date(String(episode.air_date).replace(/-/g, '/')) : null;
        var info = [];
        var data = {
          title: episode.name || episode.title || ('Серия ' + number),
          time: episode.runtime ? Lampa.Utils.secondsToTime(parseInt(episode.runtime, 10) * 60, true) : '',
          quality: '',
          timeline: timeline(object.movie, season, number)
        };
        episodeMetadata[season + '|' + number] = {
          title: data.title,
          name: data.title,
          still_path: episode.still_path || episode.img || ''
        };
        if (episode.vote_average) info.push(Lampa.Template.get('season_episode_rate', { rate: parseFloat(episode.vote_average).toFixed(1) }, true));
        if (episode.air_date) info.push(Lampa.Utils.parseTime(episode.air_date).full);
        data.info = info.length ? info.map(function (item) { return '<span>' + item + '</span>'; }).join('<span class="season-episode-split">●</span>') : '';
        if (airDate && airDate.getTime() > Date.now()) data.quality = 'До выхода ' + Math.ceil((airDate.getTime() - Date.now()) / 86400000) + ' дн.';

        var item = Lampa.Template.get('season_episode', data);
        var image = item.find('.season-episode__img');
        var loader = item.find('.season-episode__loader');
        item.find('.season-episode__timeline').append(Lampa.Timeline.render(data.timeline));
        if (data.timeline.percent) image.append('<div class="season-episode__viewed">' + Lampa.Template.get('icon_viewed', {}, true) + '</div>');

        item.on('hover:enter', function () {
          playEpisode({ number: number, title: data.title, name: data.title, s: season, e: number });
        }).on('hover:focus', function (event) {
          last = event.target;
          scroll.update($(event.target), true);
          warmEpisode(number, 120);
        }).on('hover:hover hover:touch', function (event) {
          last = event.target;
          Navigator.focused(last);
        }).on('visible', function () {
          var img = item.find('img')[0];
          function numberBadge() {
            loader.remove();
            if (!image.find('.season-episode__episode-number').length) image.append('<div class="season-episode__episode-number">' + ('0' + number).slice(-2) + '</div>');
          }
          if (!img) return numberBadge();
          img.onerror = function () { img.src = './img/img_broken.svg'; numberBadge(); };
          img.onload = function () { image.addClass('season-episode__img--loaded'); numberBadge(); };
          if (episode.still_path) img.src = Lampa.TMDB.image('t/p/w300' + episode.still_path);
          else if (episode.img) img.src = episode.img;
          else numberBadge();
        });
        scroll.append(item);
      });

      if (!episodes.length) {
        var empty = new Lampa.Empty({ title: 'PidTor', descr: 'Серии не найдены' });
        scroll.append(empty.render());
      }
      Lampa.Layer.visible(scroll.render(true));
      Lampa.Controller.enable('content');

      loadV2(season, -1, function (response) {
        var options = qualityOptions(response);
        var prepared = defaultQuality(options);
        if (!prepared) return;
        var episodeNumber = parseInt(episodes[0] && (episodes[0].episode_number || episodes[0].e) || 1, 10);
        var queue = [prepared];
        var active = 0;
        var limit = 2;
        function pump() {
          while (active < limit && queue.length) {
            (function (option) {
              active++;
              resolveOption(option, episodeNumber, function (resolved) {
                warmDirectSource(resolved.url);
                active--;
                pump();
              }, function () {
                active--;
                pump();
              });
            })(queue.shift());
          }
        }
        pump();
      }, function () {});
    }

    function loadSeason() {
      var requestedSeason = season;
      var generation = ++seasonGeneration;
      var rendered = false;
      var tmdbDone = false;
      var pidtorDone = false;
      var pidtorFallback = null;
      self.activity.loader(true);

      function valid() {
        return generation === seasonGeneration && requestedSeason === season;
      }

      function renderEpisodes(episodes) {
        if (!valid() || rendered) return;
        rendered = true;
        if (pidtorFallback) clearTimeout(pidtorFallback);
        draw(episodes || []);
        self.activity.loader(false);
      }

      function finishEmpty() {
        if (!rendered && tmdbDone && pidtorDone) renderEpisodes([]);
      }

      // Start both metadata paths together. TMDB keeps the rich episode cards
      // when it is healthy; PidTor prevents a slow TMDB proxy from holding the
      // whole screen for tens of seconds.
      tmdbEpisodes(requestedSeason, function (tmdb) {
        if (!valid()) return;
        tmdbDone = true;
        if (tmdb.length) {
          renderEpisodes(tmdb);
          return;
        }
        finishEmpty();
      });
      pidtorEpisodes(requestedSeason, function (pidtor) {
        if (!valid()) return;
        pidtorDone = true;
        if (pidtor.length && !rendered) {
          if (tmdbDone) renderEpisodes(pidtor);
          else pidtorFallback = setTimeout(function () { renderEpisodes(pidtor); }, 1200);
          return;
        }
        finishEmpty();
      });
    }

    function setSeason(number) {
      abortResolutionRequests();
      season = number;
      seasonChoice[seasonChoiceKey] = season;
      delete seasonChoice[object.movie.id];
      Lampa.Storage.set('pidtor_season_choice', seasonChoice);
      setFilter();
      loadSeason();
    }

    function setFilter() {
      var selected = ['Сезон: ' + season];
      var seasons = [];
      for (var i = 1; i <= seasonCount; i++) seasons.push({ title: 'Сезон ' + i, season: i, selected: i === season });
      filter.set('filter', seasons);
      filter.chosen('filter', selected);
    }

    function configureFilter() {
      filter.addButtonBack();
      filter.onSelect = function (type, item) {
        setSeason(parseInt(item.season, 10));
        Lampa.Controller.toggle('content');
      };
      filter.onBack = function () { self.start(); };
      setFilter();
    }

    this.create = function () {
      explorer.appendFiles(scroll.render());
      explorer.appendHead(filter.render());
      scroll.body().addClass('torrent-list mapping--list');
      explorer.render().find('.filter--search, .filter--sort').remove();
      scroll.minus(explorer.render().find('.explorer__files-head'));
      configureFilter();
      this.activity.toggle();
      if (isSerial(object.movie) && resumeParams && parseInt(resumeParams.episode || 0, 10) > 0) {
        var resumeEpisode = parseInt(resumeParams.episode, 10);
        this.activity.loader(true);
        loadV2(season, resumeEpisode, function (data) {
          self.activity.loader(false);
          launch(data, {
            number: resumeEpisode,
            title: resumeParams.episode_title || resumeParams.title || ('Серия ' + resumeEpisode),
            name: resumeParams.episode_title || resumeParams.title || ('Серия ' + resumeEpisode),
            s: season,
            e: resumeEpisode
          }, resumeParams);
        }, function (message) {
          self.activity.loader(false);
          Lampa.Noty.show(message || 'Не удалось продолжить просмотр');
          loadSeason();
        });
      } else if (isSerial(object.movie)) loadSeason();
      else {
        this.activity.loader(true);
        loadV2(-1, -1, function (data) {
          self.activity.loader(false);
          launch(data, { number: 0, title: object.movie.title || object.movie.name });
        }, function (message) {
          self.activity.loader(false);
          Lampa.Noty.show(message);
        });
      }
      return this.render();
    };

    this.start = function () {
      if (Lampa.Activity.active().activity !== this.activity) return;
      Lampa.Background.immediately(Lampa.Utils.cardImgBackgroundBlur(object.movie));
      Lampa.Controller.add('content', {
        toggle: function () {
          Lampa.Controller.collectionSet(scroll.render(), explorer.render());
          Lampa.Controller.collectionFocus(last || scroll.render().find('.selector')[0] || false, scroll.render());
        },
        left: function () { explorer.toggle(); },
        right: function () { filter.show('Фильтр', 'filter'); },
        up: function () { if (Navigator.canmove('up')) Navigator.move('up'); else Lampa.Controller.toggle('head'); },
        down: function () { Navigator.move('down'); },
        back: function () { Lampa.Activity.backward(); }
      });
      Lampa.Controller.toggle('content');
    };

    this.pause = function () {};
    this.stop = function () {};
    this.render = function () { return explorer.render(); };
    this.destroy = function () {
      requests.forEach(function (network) { try { network.clear(); } catch (e) {} });
      resolutionRequests.forEach(function (network) { try { network.clear(); } catch (e) {} });
      if (episodeWarmTimer) clearTimeout(episodeWarmTimer);
      scroll.destroy();
      explorer.destroy();
    };
  }

  function addButton(data) {
    if (!data || !data.render || !data.render.length) return;
    var screen = data.render.closest('.full-start-new, .full-start');
    if (!screen.length) {
      screen = data.render.find('.full-start-new, .full-start').filter(function () {
        return $(this).width() > 0 && $(this).height() > 0;
      }).first();
    }
    if (!screen.length) {
      screen = $('.full-start-new, .full-start').filter(function () {
        return $(this).width() > 0 && $(this).height() > 0;
      }).last();
    }
    var container = screen.find('.full-start-new__buttons').filter(function () {
      return $(this).width() > 0 && $(this).height() > 0;
    }).first();
    if (!container.length) {
      container = screen.find('.full-start__buttons').filter(function () {
        return $(this).width() > 0 && $(this).height() > 0;
      }).first();
    }
    if (!container.length) {
      container = $('.full-start-new__buttons, .full-start__buttons').filter(function () {
        return $(this).width() > 0 && $(this).height() > 0;
      }).first();
    }
    if (!container.length) container = data.render.parent();
    if (container.find('.pidtor-nextgen--button').length) return;
    screen.find('.pidtor-nextgen--button').remove();
    var button = $(
      '<div class="full-start__button selector view--online pidtor-nextgen--button" data-subtitle="PidTor NextGen">' +
        '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg><span>PidTor</span>' +
      '</div>'
    );
    button.on('hover:enter', function () {
      var target = { title: 'PidTor', component: 'pidtor_nextgen', movie: data.movie, page: 1 };
      if (isSerial(data.movie)) Lampa.Activity.push(target);
      else launchMovieDirect(target);
    });
    var anchor = container.find('.view--online.button--priority').first();
    if (!anchor.length) anchor = container.find('.view--online').first();
    if (!anchor.length) anchor = container.find('.button--play').first();
    if (anchor.length) anchor.after(button);
    else container.prepend(button);

    scheduleCardWarm(data.movie);
  }

  function movieStartChoice(data) {
    var options = qualityOptions(data);
    var selected = defaultQuality(options);
    if (!selected) return null;
    var audioOptions = mergedTrackChoices({ variant: selected.variant, variants: [selected.variant] }, 'audio').map(function (choice) {
      return { title: choice.title, track: choice.track, variant: choice.variant, order: choice.order };
    });
    var audio = preferredChoice(audioOptions, null, true);
    var variant = selected.variant;
    var replicas = (variant && variant.replicas || []).filter(function (replica) {
      return !!replica.stream_url;
    }).sort(function (a, b) {
      return parseInt(b.seeders || 0, 10) - parseInt(a.seeders || 0, 10);
    });
    if (!replicas.length) return null;
    return {
      source: replicas[0].stream_url,
      audio: audio ? parseInt(audio.order || 0, 10) : 0
    };
  }

  function cacheApiResponse(endpoint, data) {
    apiCache[endpoint] = { data: data, expires: Date.now() + apiCacheTtl };
  }

  function cachedApiResponse(endpoint) {
    var cached = apiCache[endpoint];
    if (cached && cached.expires > Date.now()) return cached.data;
    if (cached) delete apiCache[endpoint];
    return null;
  }

  function scheduleCardWarm(movie) {
    if (cardWarmTimer) clearTimeout(cardWarmTimer);
    var generation = ++cardWarmGeneration;
    if (!movie || isSerial(movie) || !storageEnabled('pidtor_gstreamer', true)) return;
    cardWarmTimer = setTimeout(function () {
      var network = new Lampa.Reguest();
      network.timeout(45000);
      var endpoint = account(API + '/lite/pidtor/v2?' + query(movie, -1, -1));
      network['native'](endpoint, function (response) {
        if (generation !== cardWarmGeneration) return;
        var data = parseJson(response);
        if (data) cacheApiResponse(endpoint, data);
        var choice = movieStartChoice(data);
        if (!choice) return;
        warmDirectSource(choice.source);
      }, function () {}, false, { dataType: 'text' });
    }, 250);
  }

  function launchMovieDirect(object, preferences) {
    var requestGeneration = ++playbackRequestGeneration;
    var network = new Lampa.Reguest();
    var movie = object.movie;
    var endpoint = account(API + '/lite/pidtor/v2?' + query(movie, -1, -1));
    network.timeout(45000);
    function launchResponse(response) {
      if (requestGeneration !== playbackRequestGeneration) return;
      var data = parseJson(response);
      if (!data) return launchError();
      if (data) cacheApiResponse(endpoint, data);
      var options = qualityOptions(data);
      preferences = preferences || object.pidtor_resume || {};
      var selected = options.filter(function (option) {
        return preferences.pidtor_quality_key && option.key === preferences.pidtor_quality_key;
      })[0] || defaultQuality(options);
      if (!selected) {
        Lampa.Noty.show('Подходящих вариантов не найдено');
        return;
      }
      var replicas = [];
      var seen = {};
      (selected.variants || [selected.variant]).forEach(function (variant) {
        (variant.replicas || []).forEach(function (replica) {
          if (!replica.stream_url || seen[replica.stream_url]) return;
          seen[replica.stream_url] = true;
          replicas.push({ replica: replica, variant: variant });
        });
      });
      replicas.sort(function (a, b) { return parseInt(b.replica.seeders || 0, 10) - parseInt(a.replica.seeders || 0, 10); });
      if (!replicas.length) {
        Lampa.Noty.show('Фильм недоступен');
        return;
      }
      var qualityResolvers = options.map(function (option) {
        var result = {
          key: option.key,
          label: option.label,
          selected: option === selected,
          variant: option.variant,
          audio_options: [],
          subtitle_options: [],
          resolve: function (complete, error) {
            var available = (option.variants || [option.variant]).reduce(function (all, variant) {
              return all.concat((variant.replicas || []).filter(function (replica) { return replica.stream_url; }).map(function (replica) {
                return { url: replica.stream_url, replica: replica, variant: variant };
              }));
            }, []).sort(function (a, b) { return parseInt(b.replica.seeders || 0, 10) - parseInt(a.replica.seeders || 0, 10); });
            var stream = available[0];
            if (!stream) return error('Качество недоступно');
            hydrateResolved(preferResolvedFile({
              url: stream.url, sources: available.map(function (entry) { return entry.url; }), source_records: available,
              episodes: [], variant: stream.variant
            }, result.preferred_file_key), function (resolved) {
              publishOptionTracks(result, option, resolved);
              complete(resolved);
            }, function (resolved) { publishOptionTracks(result, option, resolved); }, null, true);
          }
        };
        return result;
      });
      var selectedResolver = qualityResolvers.filter(function (item) { return item.key === selected.key; })[0] || qualityResolvers[0];
      selectedResolver.preferred_file_key = resumeSourceKey(preferences.pidtor_audio_key || preferences.pidtor_subtitle_key);
      selectedResolver.resolve(function (resolved) {
      if (requestGeneration !== playbackRequestGeneration) return;
      var initialAudio = preferredStoredChoice(selectedResolver.audio_options, preferences.pidtor_audio_key || '', null, true);
      resolved = resolvedWithChoice(resolved, initialAudio, 'audio');
      var activeVariant = resolved.variant;
      var activeSource = resolved.url;
      var activeSources = (resolved.source_records || []).filter(function (record) {
        return record.variant.source_file_key === activeVariant.source_file_key && record.variant.id === activeVariant.id;
      }).map(function (record) { return record.url; });
      var initialSubtitle = preferredStoredChoice(selectedResolver.subtitle_options.filter(function (choice) {
        return choice.variant.source_file_key === activeVariant.source_file_key;
      }), preferences.pidtor_subtitle_key || '', null, false);
      var gst = useGstreamer(data);
      var gstAudioIndex = initialAudio ? parseInt(initialAudio.order || 0, 10) : 0;
      var ffprobeAudioIndex = initialAudio ? parseInt(initialAudio.track.stream_index, 10) : -1;
      var source = sourceForPlayback(activeSource, gst, gst ? gstAudioIndex : undefined);
      var item = {
        title: movie.title || movie.name || data.title || 'PidTor',
        url: account(source),
        url_orig: account(source),
        timeline: timeline(movie, 0, 0),
        pidtor_nextgen: true,
        pidtor_manifest_schema: 1,
        pidtor_manifest_url: endpoint,
        pidtor_use_gst: gst,
        pidtor_gst_bypass: true,
        pidtor_tracks_ready: true,
        pidtor_source_url: account(activeSource),
        pidtor_source_urls: activeSources.map(account),
        pidtor_source_records: resolved.source_records,
        pidtor_quality_key: selected.key,
        pidtor_audio_key: initialAudio ? initialAudio.key : '',
        pidtor_audio_stream_index: gst ? gstAudioIndex : ffprobeAudioIndex,
        pidtor_audio_ffprobe_index: ffprobeAudioIndex,
        pidtor_subtitle_key: initialSubtitle ? initialSubtitle.key : '',
        hls_manifest_timeout: gst ? 60000 : 15000,
        ffprobe: variantStreams(activeVariant),
        torrent_hash: streamHash(activeSource),
        card: movie,
        movie: movie,
        isonline: true
      };
      Object.defineProperty(item, 'pidtor_quality_options', { value: qualityResolvers, writable: true, configurable: true, enumerable: true });
      Object.defineProperty(item, 'pidtor_audio_options', { value: selectedResolver.audio_options, writable: true, configurable: true, enumerable: true });
      Object.defineProperty(item, 'pidtor_subtitle_options', { value: selectedResolver.subtitle_options, writable: true, configurable: true, enumerable: true });
      Object.defineProperty(item, 'pidtor_variant', { value: activeVariant, writable: true, configurable: true, enumerable: true });
      followQualityTracks(selectedResolver, item);
      var start = function () {
        if (requestGeneration !== playbackRequestGeneration) return;
        Lampa.Player.play(item);
        Lampa.Player.playlist([item]);
        setTimeout(function () { if (ownsPlayer(item)) emitResumeState(item); }, 0);
      };
      if (gst) ensureGst(function () {
        var json = cachedGstWarm(item.pidtor_source_url, item.pidtor_audio_stream_index);
        if (json) {
          item.pidtor_gst_warm = json;
          item.url = json.hls + '?audio=' + parseInt(item.pidtor_audio_stream_index || 0, 10);
          item.url_orig = item.url;
          start();
        } else start();
      });
      else start();
      }, function (message) { if (requestGeneration === playbackRequestGeneration) Lampa.Noty.show(message || 'Не удалось открыть фильм'); });
    }
    function launchError(error) {
      if (requestGeneration !== playbackRequestGeneration) return;
      var message = error && (error.responseText || error.statusText);
      Lampa.Noty.show(message || 'Не удалось открыть фильм');
    }
    var cached = cachedApiResponse(endpoint);
    if (cached) launchResponse(cached);
    else network['native'](endpoint, launchResponse, launchError, false, { dataType: 'text' });
  }

  function registerSettings() {
    if (!Lampa.SettingsApi || !Lampa.SettingsApi.addComponent || !Lampa.SettingsApi.addParam) return;
    if (window.pidtor_nextgen_settings) return;
    window.pidtor_nextgen_settings = true;
    Lampa.SettingsApi.addComponent({
      component: 'pidtor_nextgen',
      name: 'PidTor',
      icon: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>'
    });
    Lampa.SettingsApi.addParam({
      component: 'pidtor_nextgen',
      param: { name: 'pidtor_gstreamer', type: 'trigger', default: true },
      field: {
        name: 'GStreamer во внутреннем плеере',
        description: 'Транскодирование PidTor для внутреннего плеера Lampa. Внешний DDD всегда получает исходный поток TorrServer.'
      }
    });
  }

  function startPlugin() {
    Lampa.Template.add('pidtor_nextgen_css', '<style>.pidtor-nextgen--button svg{width:1.4em;height:1.4em}</style>');
    $('body').append(Lampa.Template.get('pidtor_nextgen_css', {}, true));
    Lampa.Component.add('pidtor_nextgen', PidTorComponent);
    window.PidTorNextGen = window.PidTorNextGen || {};
    window.PidTorNextGen.resume = function (movie, params) {
      if (!movie || !params) return false;
      var target = {
        title: 'PidTor',
        component: 'pidtor_nextgen',
        movie: movie,
        page: 1,
        pidtor_resume: params,
        pidtor_resume_direct: true
      };
      if (isSerial(movie)) Lampa.Activity.push(target);
      else launchMovieDirect(target, params);
      return true;
    };
    registerSettings();
    if (Lampa.PlayerPlaylist && Lampa.PlayerPlaylist.listener) {
      Lampa.PlayerPlaylist.listener.follow('select', function () {
        setTimeout(closePlayerSelect, 0);
      });
    }
    Lampa.Player.listener.follow('start', schedulePlayerControls);
    Lampa.Player.listener.follow('destroy', function () {
      playbackRequestGeneration++;
      activeControlsData = null;
      playerControlsGeneration++;
      stopPlaybackMonitor();
    });
    Lampa.Listener.follow('full', function (event) {
      if (event.type === 'complite') addButton({ render: event.object.activity.render(), movie: event.data.movie });
      else if (event.type === 'destroy' || event.type === 'close') {
        cardWarmGeneration++;
        if (cardWarmTimer) clearTimeout(cardWarmTimer);
        cardWarmTimer = null;
      }
    });
    try {
      var active = Lampa.Activity.active();
      if (active.component === 'full') addButton({ render: active.activity.render(), movie: active.card });
    } catch (e) {}
  }

  if (window.appready) startPlugin();
  else Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') startPlugin(); });
})();
