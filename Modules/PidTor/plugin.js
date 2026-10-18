(function () {
  'use strict';

  if (window.pidtor_nextgen_plugin) return;
  window.pidtor_nextgen_plugin = true;
window.pidtor_nextgen_build = '20261017-81-movie-warm';

  var API = '{localhost}';
  var TOKEN = '{token}';
  // Сколько мегабайт предзагрузки настроено в модуле (0 - выключено). Сервер подставляет
  // значение на месте {pidtor_preload}; со старым модулем строка не заменится и окно
  // наполнения просто не включится.
  var pidtorPreloadMb = parseInt('{pidtor_preload}', 10) || 0;
  var gstLoading = false;
  var gstWaiters = [];
  var playbackMonitor = null;
  var playerControlsGeneration = 0;
  var activeControlsData = null;
  var playbackRequestGeneration = 0;
  // When the viewer last asked for an episode: the hand-off report uses it to say how long the whole
  // request took (manifest + torrent warm-up + probe), not just the part the quality list adds.
  var playbackRequestedAt = 0;
  // Where the seconds between the press and the player actually go: how long the client sat before
  // the season plan was even asked for, how long the plan took, and how long the page has been alive.
  // A press that "reloads the page instead of launching" shows up here as a small page age.
  var playbackStages = {};
  var pluginBoot = (function () {
    try {
      var count = parseInt(sessionStorage.getItem('pidtor_boot') || '0', 10) + 1;
      sessionStorage.setItem('pidtor_boot', String(count));
      return count;
    } catch (e) { return 0; }
  })();
  var activePositionRestore = null;

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

  function canonicalHash(value) {
    value = String(value || '').toLowerCase();
    if (/^[a-f0-9]{40}$/.test(value)) return value;
    if (!/^[a-z2-7]{32}$/.test(value)) return '';
    var alphabet = 'abcdefghijklmnopqrstuvwxyz234567', bits = 0, buffer = 0, result = '';
    value.split('').forEach(function (letter) {
      buffer = (buffer << 5) | alphabet.indexOf(letter);
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        result += ('0' + ((buffer >>> bits) & 255).toString(16)).slice(-2);
      }
    });
    return result;
  }

  function sourceFile(record) {
    try {
      var base = new URL(String(API).replace(/\/$/, '') + '/');
      var url = new URL(account(record.url), base);
      var path = base.pathname.replace(/\/$/, '') + '/lite/pidtor/s';
      if (url.origin !== base.origin || url.pathname.indexOf(path) !== 0) return null;
      var hash = canonicalHash(url.pathname.slice(path.length));
      if (!hash) return null;
      var indexValue = url.searchParams.get('tsid');
      if (indexValue === null) indexValue = url.searchParams.get('fileindex');
      if (indexValue === null) indexValue = '1';
      if (!/^[1-9]\d*$/.test(indexValue) || Number(indexValue) > 32767) return null;
      var trackers = url.searchParams.getAll('tr');
      var replica = record.replica_data || (record.replica && typeof record.replica === 'object' ? record.replica : null) || (record.variant && record.variant.replicas || []).filter(function (item) {
        return canonicalHash(item.infohash) === hash;
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
    if (variant.ffprobe && !confirmedProbeStreams(variant, file)) {
      variant.video = { quality: variant.video && variant.video.quality, source: variant.video && variant.video.source };
      variant.audio = [];
      variant.subtitles = [];
      delete variant.ffprobe;
    }
    if (file) {
      var metadata = record.file_metadata || (record.replica_data && record.replica_data.file_metadata)
        || (record.replica && record.replica.file_metadata);
      if (metadata && metadata.metadata_state === 'ready' && metadata.file_key === file.key
          && canonicalHash(metadata.infohash) === file.hash && Number(metadata.index) === file.index) {
        var verified = confirmedProbeStreams({ source_file_key: metadata.file_key, ffprobe: metadata.streams }, file);
        if (verified) applyProbe(variant, verified);
      }
      var stored = probeCache[file.key];
      if (!variant.ffprobe && stored && stored.streams && stored.expires > Date.now()) applyProbe(variant, stored.streams);
      variant.source_file_key = file.key;
      var confirmed = confirmedProbeStreams(variant, file);
      if (confirmed) cacheFileStreams(file.key, confirmed);
      var replica = cloneMetadata(file.replica) || { infohash: file.hash };
      replica.stream_url = record.url;
      variant.replicas = [replica];
    }
    return variant;
  }

  function cacheFileStreams(key, streams) {
    probeCache[key] = { streams: cloneMetadata(streams), expires: streams ? Infinity : Date.now() + probeFailureTtl };
    probeOrder = probeOrder.filter(function (value) { return value !== key; });
    probeOrder.push(key);
    while (probeOrder.length > probeCacheLimit) delete probeCache[probeOrder.shift()];
  }

  function sourceRecordFromEpisode(item, candidate) {
    var record = { url: item.url, variant: candidate.variant, replica: cloneMetadata(candidate.replica),
      file_metadata: cloneMetadata(item.file_metadata) };
    record.variant = fileVariant(record);
    return record;
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
          if (!streams && probeCache[file.key] && probeCache[file.key].streams) streams = probeCache[file.key].streams;
          cacheFileStreams(file.key, streams);
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
    records.sort(function (a, b) {
      function ready(record) { return confirmedProbeStreams(fileVariant(record), sourceFile(record)) ? 1 : 0; }
      return ready(b) - ready(a);
    });
    var preferred = records.filter(function (record) { return (sourceFile(record) || {}).key === key; })[0];
    if (preferred) records = [preferred].concat(records.filter(function (record) { return record !== preferred; }));
    if (!records.length) return resolved;
    var result = Object.assign({}, resolved, { source_records: records, url: records[0].url });
    if (preferred) result.preferred_file_key = key;
    return result;
  }

  function confirmedProbeStreams(variant, file) {
    var streams = variant && variant.ffprobe;
    if (!file || !variant || variant.source_file_key !== file.key || !Array.isArray(streams) || !streams.length) return null;
    streams = streams.map(function (stream, index) {
      return index === 0 && stream && !Object.prototype.hasOwnProperty.call(stream, 'index')
        ? Object.assign({}, stream, { index: 0 }) : stream;
    });
    var indices = {};
    if (streams.some(function (stream) {
      if (!stream || !Number.isInteger(stream.index) || stream.index < 0 || indices[stream.index]) return true;
      indices[stream.index] = true;
      return false;
    })
        || !streams.some(function (stream) { return stream.codec_type === 'video' && !(stream.disposition && stream.disposition.attached_pic === 1); })) return null;
    return streams;
  }

  function hydrateResolved(resolved, complete, update, deadline, directStart) {
    var records = (resolved.source_records || []).map(function (record) {
      var variant = fileVariant(record);
      if (variant.ffprobe && !confirmedProbeStreams(variant, sourceFile(record))) {
        delete variant.ffprobe;
        variant.audio = [];
        variant.subtitles = [];
        variant.video = { quality: variant.video && variant.video.quality, source: variant.video && variant.video.source };
      }
      if (directStart && record.replica && record.replica.episodes_url && !variant.ffprobe) {
        variant.audio = [];
        variant.subtitles = [];
      }
      return { url: record.url, replica: cloneMetadata(record.replica), variant: variant, file_metadata: record.file_metadata };
    });
    var remaining = records.length;
    var done = [];
    var active = null;
    var delivered = false;
    var closed = false;
    // Only metadata already tied to this exact torrent file is reusable.
    records.forEach(function (record, index) {
      var file = sourceFile(record);
      var streams = confirmedProbeStreams(record.variant, file);
      if (!streams) return;
      applyProbe(record.variant, streams);
      done[index] = true;
      remaining--;
      if (index === 0) active = record;
    });
    // Unknown alternatives stay lazy; only the chosen file enters the probe queue.
    var chosenIndex = 0;
    remaining = records.length && !done[chosenIndex] ? 1 : 0;
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
      if (done[index] || index !== chosenIndex) return;
      var file = sourceFile(record);
      function receive(streams) {
        if (closed || done[index]) return;
        if (streams) {
          applyProbe(record.variant, streams);
          if (resolved.source_records[index]) resolved.source_records[index].variant = cloneMetadata(record.variant);
          (resolved.episodes || []).forEach(function (episode) {
            (episode.pidtor_source_records || []).forEach(function (cachedRecord) {
              if ((sourceFile(cachedRecord) || {}).key === file.key) cachedRecord.variant = cloneMetadata(record.variant);
            });
          });
        }
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
    result.audio_options = resolvedTrackChoices(option, resolved, 'audio').concat(result.catalogue_audio_options || []);
    result.subtitle_options = resolvedTrackChoices(option, resolved, 'subtitles').concat(result.catalogue_subtitle_options || []);
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
      if (!currentChoice(target, 'audio') && current) {
        var audio = result.audio_options.filter(function (choice) { return sameVariantFile(choice.variant, current.variant); });
        var initial = preferredStoredChoice(audio, target.pidtor_audio_key,
          target.pidtor_pending_audio_choice || target.pidtor_audio_choice, true);
        if (initial) {
          target.pidtor_audio_key = initial.key;
          target.pidtor_audio_stream_index = parseInt(initial.track.stream_index, 10);
          target.pidtor_audio_ffprobe_index = target.pidtor_audio_stream_index;
          delete target.pidtor_pending_audio_choice;
        }
      }
      if (!currentChoice(target, 'subtitle') && current && target.pidtor_subtitle_choice) {
        var subs = result.subtitle_options.filter(function (choice) { return sameVariantFile(choice.variant, current.variant); });
        var chosenSub = preferredStoredChoice(subs, target.pidtor_subtitle_key, target.pidtor_subtitle_choice, false);
        if (chosenSub) target.pidtor_subtitle_key = chosenSub.key;
      }
      if (target === activeControlsData) {
        installPlayerControls(target);
        emitResumeState(target);
      }
    });
    if (result.on_tracks_update) result.on_tracks_update(resolved);
  }

  function resolvedTrackChoices(option, resolved, field) {
    return mergedTrackChoices({ variants: (resolved.source_records || []).map(function (record) { return record.variant; }) }, field).map(function (choice) {
      var track = Object.assign({}, choice.track);
      if (!choice.variant.ffprobe) { delete track.stream_index; delete track.id; }
      return {
        key: option.key + '|' + field + '|' + choiceIdentity(choice),
        title: choice.title, track: track, variant: choice.variant, order: choice.order, track_id: choice.track_id,
        resolve: function (complete, error) {
          var records = (resolved.source_records || []).filter(function (record) {
            return record.variant.source_file_key === choice.variant.source_file_key && record.variant.id === choice.variant.id;
          });
          if (!records.length) return error('Дорожка недоступна');
          var selected = Object.assign({}, resolved, {
            url: records[0].url, sources: records.map(function (record) { return record.url; }), source_records: records,
            variant: records[0].variant
          });
          function confirmed(ready) {
            var exactChoices = mergedTrackChoices({ variants: (ready.source_records || []).filter(function (record) {
              return !!confirmedProbeStreams(record.variant, sourceFile(record));
            }).map(function (record) { return record.variant; }) }, field);
            var actual = preferredChoice(exactChoices, choice, field === 'audio');
            if (!actual) return error('Дорожка недоступна');
            actual.key = option.key + '|' + field + '|' + choiceIdentity(actual);
            complete(resolvedWithChoice(ready, actual, field));
          }
          if (confirmedProbeStreams(records[0].variant, sourceFile(records[0]))) confirmed(selected);
          else hydrateResolved(selected, confirmed, null, null, false);
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
    var card = data.card || data.movie || {};
    var detail = {
      pidtor_nextgen: true,
      pidtor_manifest_schema: Number(data.pidtor_manifest_schema || 1),
      pidtor_manifest_url: data.pidtor_manifest_url || '',
      pidtor_quality_key: data.pidtor_quality_key || '',
      pidtor_manual_quality: data.pidtor_manual_quality === true,
      pidtor_audio_key: data.pidtor_audio_key || '',
      pidtor_subtitle_key: data.pidtor_subtitle_key || '',
      pidtor_audio_choice: semanticChoice(currentChoice(data, 'audio') || data.pidtor_pending_audio_choice || data.pidtor_audio_choice),
      pidtor_subtitle_choice: semanticChoice(currentChoice(data, 'subtitle') || data.pidtor_subtitle_choice),
      timeline_hash: String(data.timeline && data.timeline.hash || data.timeline_hash || ''),
      card: {id: card.id, tmdb_id: card.tmdb_id, kinopoisk_id: card.kinopoisk_id, imdb_id: card.imdb_id,
        source: card.source || 'tmdb', media_type: isSerial(card) ? 'tv' : 'movie',
        title: card.title, name: card.name, original_title: card.original_title, original_name: card.original_name},
      season: Number(data.season || 0),
      episode: Number(data.episode || 0)
    };
    try {
      window.dispatchEvent(new CustomEvent('pidtor-nextgen-state', { detail: detail }));
    } catch (e) {}
  }

  function semanticChoice(choice) {
    if (!choice) return null;
    var track = choice.track || {};
    return {title: String(choice.title || track.title || ''), track: {
      title: String(track.title || choice.title || ''), language: String(track.language || ''),
      codec: String(track.codec || ''), channels: Number(track.channels || 0), forced: track.forced === true
    }};
  }

  function preferredStoredChoice(options, key, previous, audio) {
    options = (options || []).filter(function (choice) {
      return choice.variant && choice.variant.source_file_key && Array.isArray(choice.variant.ffprobe)
        && Number.isFinite(parseInt(choice.track && choice.track.stream_index, 10));
    });
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
      .replace(/([?&])rjson(?:=[^&#]*)?/gi, function (_, prefix) { return prefix === '?' ? '?' : ''; })
      .replace(/\?&/, '?')
      .replace(/[?&]$/, '');
  }

  function sourceWithAudio(source, streamIndex) {
    source = sanitizePlaybackSource(source);
    if (!source || !Number.isFinite(parseInt(streamIndex, 10))) return source;
    source = source
      .replace(/([?&])audio=[^&#]*/gi, function (_, prefix) { return prefix === '?' ? '?' : ''; })
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
    // Nextgen uses the original TorrServer stream, including movie resume.
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
      .replace(/([?&])audio=[^&#]*/gi, function (_, prefix) { return prefix === '?' ? '?' : ''; })
      .replace(/\?&/, '?')
      .replace(/[?&]$/, '');
    if (/\/lite\/pidtor\/s/i.test(result) && !/[?&]raw=/.test(result)) {
      result = Lampa.Utils.addUrlComponent(result, 'raw=true');
    }
    return account(result);
  }

  function warmKey(source, audioIndex) {
    return rawGstSource(source)
      .replace(/([?&])(account_email|uid|token|nws_id)=[^&#]*/gi, function (_, prefix) { return prefix === '?' ? '?' : ''; })
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
      network.timeout(45000);
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
    var file = sourceFile({url: target});
    var key = file ? file.key : warmKey(target, -1);
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
    xhr.timeout = 30000;
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

  function timeline(movie, season, episode, preferences) {
    var original = movie.original_title || movie.original_name || movie.title || movie.name || movie.id;
    var hash = season
      ? Lampa.Utils.hash([season, season > 10 ? ':' : '', episode, original].join(''))
      : Lampa.Utils.hash(original);
    var road = Lampa.Timeline.view(hash);
    if (preferences && Number.isFinite(Number(preferences.time)) && Number(preferences.time) >= 0
        && (!season || Number(preferences.season) === Number(season) && Number(preferences.episode) === Number(episode))) {
      var progress = {hash: hash, time: Number(preferences.time),
        duration: Number.isFinite(Number(preferences.duration)) ? Math.max(0, Number(preferences.duration)) : Number(road.duration || 0),
        percent: Number.isFinite(Number(preferences.percent)) ? Math.max(0, Math.min(100, Number(preferences.percent))) : 0};
      if (Lampa.Timeline.update) { Lampa.Timeline.update(progress); road = Lampa.Timeline.view(hash); }
      else Object.assign(road, progress);
    }
    return road;
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

  // Пункт меню качеств - только разрешение. Раньше к нему приклеивался HDR-хвост, и в
  // списке стояли два «одинаковых» пункта (2160p и 2160p DV) на один и тот же фильм,
  // причём играл только один: второй вёл на копию, которая не отдавала данные.
  // Теперь все копии одного разрешения (SDR/HDR10/HDR10+/DV) склеены в один пункт,
  // а HDR уходит в подпись - информация видна, лишнего выбора нет.
  function qualityName(variant) {
    var video = variant.video || {};
    return video.quality || 'SD';
  }

  function qualityLabel(variant) {
    var video = variant.video || {};
    var values = [];
    if (video.source) values.push(video.source);
    if (video.codec) values.push(String(video.codec).toUpperCase());
    if (video.bit_depth > 8) values.push(video.bit_depth + '-bit');
    var hdr = String(video.hdr || '').toLowerCase();
    if (hdr === 'dolby_vision') values.push('DV');
    else if (hdr === 'hdr10_plus') values.push('HDR10+');
    else if (hdr === 'hdr10') values.push('HDR10');
    else if (hdr === 'hlg') values.push('HLG');
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

  // Порядок предпочтений: русская дорожка -> кодек, который устройство точно проиграет ->
  // ЖИВОЙ рой -> и только потом «богатство» дорожек. Раньше число субтитров перевешивало
  // сидов (3 субтитра против 43 сидов), первым пунктом качества оказывался релиз с одним
  // сидом, он не отдавал данные - и плеер отказывался играть вообще.
  function variantScore(variant) {
    var audio = variant && Array.isArray(variant.audio) ? variant.audio : [];
    var subtitles = variant && Array.isArray(variant.subtitles) ? variant.subtitles : [];
    var russian = audio.some(function (track) {
      return normalizedLanguage(track && track.language) === 'ru';
    }) ? 1 : 0;
    return russian * 1000000000000
      + playbackPriority(variant) * 100000000000
      + Math.min(seeders(variant), 999) * 100000000
      + Math.min(audio.length, 10) * 1000000
      + Math.min(subtitles.length, 10) * 10000;
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

  // ---- Quality hand-off to an external Android player ------------------------------------------
  // Lampa's Android client turns a play item's `quality` map into `quality_levels`/`quality_urls`
  // (any generic player) or into per-item `qualities` (the Just+ playlist contract). That map is what
  // makes a player like ARX TPlayer offer PidTor's quality variants in its own "Video quality" panel,
  // with the audio glued into the file it plays. The built-in browser player keeps PidTor's own menu,
  // so the map is only built when the item is really about to leave for an external player.
  var externalQualityRequests = [];
  var externalQualityEpisodeCache = {};
  var externalQualityEpisodeOrder = [];
  var externalQualityEpisodeWaiters = {};
  var externalQualitySequence = 0;
  var externalQualityDisabled = false;

  // Is this client able to hand playback to the Android app at all? The bridge object is Lampa.Android
  // in the web app; the app injects a global one as well, so both are accepted - checking only the
  // global one silently answered "no" on every real client. This half of the question does not need
  // the item, which is what lets the quality lists be asked for before the stream is even resolved.
  function externalPlayerBridge() {
    try {
      if (!(Lampa.Platform && Lampa.Platform.is && Lampa.Platform.is('android'))) return false;
      if (String(Lampa.Storage.field('player_need') || '') === 'android') return true;
      return !!((typeof Android !== 'undefined' && Android) || Lampa.Android);
    } catch (e) { return false; }
  }

  // Answers the only question that matters here: does Lampa hand this very item to the Android client?
  // It is the condition of Lampa's own Android branch, word for word:
  //   Platform.is('android') && (player_need == 'android' || launch_player == 'android'
  //                              || data.torrent_hash && !Torserver.gstWork())
  // The answer is not cosmetic: a wrong "no" hands Lampa the full play item (manifest records, ffprobe,
  // one card per episode) for a client that parses every field of it into Java objects, and leaves
  // the external player without the quality list.
  function externalPlayerTarget(item) {
    if (externalQualityDisabled) return false;
    try {
      if (!externalPlayerBridge()) return false;
      if (String(Lampa.Storage.field('player_need') || '') === 'android') return true;
      if (item && String(item.launch_player || '') === 'android') return true;
      var gst = !!(Lampa.Torserver && typeof Lampa.Torserver.gstWork === 'function' && Lampa.Torserver.gstWork());
      return !!(item && item.torrent_hash && !gst);
    } catch (e) { return false; }
  }

  // What the phone decided is invisible from here, so every hand-off leaves one line in the server's
  // access log instead: grep -o 'diag=[^&]*' /var/log/nginx/lampac_access.log | tail. Fire and forget.
  function externalHandOffReport(fields) {
    try {
      var parts = [];
      fields.build = window.pidtor_nextgen_build;
      fields.app = (function () {
        try { return typeof AndroidJS !== 'undefined' && AndroidJS && AndroidJS.appVersion ? String(AndroidJS.appVersion()) : ''; } catch (e) { return ''; }
      })();
      Object.keys(fields).forEach(function (key) {
        var value = fields[key];
        parts.push(key + '=' + String(value === null || typeof value === 'undefined' ? '' : value).slice(0, 200));
      });
      var url = API + '/lite/pidtor/diag?diag=' + encodeURIComponent(parts.join(' '));
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') navigator.sendBeacon(url);
      else if (typeof fetch === 'function') fetch(url, { keepalive: true })['catch'](function () {});
    } catch (e) {}
  }

  // The gate's inputs, for that report - never throws, missing pieces simply stay empty.
  function externalHandOffFacts(launch) {
    function read(call) { try { return call(); } catch (e) { return ''; } }
    return {
      need: read(function () { return String(Lampa.Storage.field('player') || Lampa.Storage.field('player_torrent') || ''); }),
      next: read(function () { return Lampa.Storage.field('playlist_next') === false ? 0 : 1; }),
      br: read(function () { return (typeof Android !== 'undefined' && Android) || Lampa.Android ? 1 : 0; }),
      gst: read(function () { return Lampa.Torserver.gstWork() ? 1 : 0; }),
      hash: launch && launch.torrent_hash ? 1 : 0
    };
  }

  // The replica PidTor itself would play for this quality: the file the chosen audio lives in first,
  // then the option's own primary variant, then the one with the most seeders.
  function qualityOptionReplica(option, preferredHash) {
    var candidates = [];
    (option.variants || [option.variant]).forEach(function (variant) {
      if (!variant) return;
      (variant.replicas || []).forEach(function (replica) {
        if (!replica || !(replica.stream_url || replica.episodes_url)) return;
        candidates.push({ variant: variant, replica: replica });
      });
    });
    if (!candidates.length) return null;
    candidates.sort(function (a, b) {
      var aPreferred = preferredHash && canonicalHash(a.replica.infohash) === preferredHash ? 1 : 0;
      var bPreferred = preferredHash && canonicalHash(b.replica.infohash) === preferredHash ? 1 : 0;
      if (aPreferred !== bPreferred) return bPreferred - aPreferred;
      var aMain = option.variant && a.variant.id === option.variant.id ? 1 : 0;
      var bMain = option.variant && b.variant.id === option.variant.id ? 1 : 0;
      return bMain - aMain || parseInt(b.replica.seeders || 0, 10) - parseInt(a.replica.seeders || 0, 10);
    });
    return candidates[0];
  }

  // One replica's episode list (a serial): every episode's stream URL, asked once per torrent.
  // The list survives the session: Lampa reloads its page when it hands playback to the Android app
  // and comes back, and the first press after that reload used to be the first request for the same
  // lists all over again - which is exactly the press that arrived at the player without quality.
  var externalQualityStoreName = 'pidtor_external_quality_lists_v2';
  var externalQualityStoreTtl = 12 * 60 * 60 * 1000;
  var externalQualityStoreBytes = 250000;
  var externalQualityStoreEntries = 40;
  var externalQualityStore = null;

  function externalQualityStoreLoad() {
    if (externalQualityStore) return externalQualityStore;
    externalQualityStore = {};
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return externalQualityStore;
      var parsed = JSON.parse(localStorage.getItem(externalQualityStoreName) || '{}');
      if (!parsed || typeof parsed !== 'object') return externalQualityStore;
      Object.keys(parsed).forEach(function (url) {
        var entry = parsed[url];
        if (!entry || !Array.isArray(entry.d) || !entry.d.length || !entry.t) return;
        if (Date.now() - entry.t > externalQualityStoreTtl) return;
        externalQualityStore[url] = entry;
      });
    } catch (e) { externalQualityStore = {}; }
    return externalQualityStore;
  }

  function externalQualityStoreSave() {
    if (!externalQualityStore || typeof localStorage === 'undefined' || !localStorage) return;
    try {
      // Newest first: localStorage on the phone is shared with Lampa's own settings, so the cap is
      // small and the seasons that were watched last are the ones that stay.
      var urls = Object.keys(externalQualityStore).sort(function (a, b) {
        return externalQualityStore[b].t - externalQualityStore[a].t;
      }).slice(0, externalQualityStoreEntries);
      var keep = {};
      urls.forEach(function (url) { keep[url] = externalQualityStore[url]; });
      var names = Object.keys(keep);
      var text = JSON.stringify(keep);
      while (text.length > externalQualityStoreBytes && names.length > 1) {
        delete keep[names.pop()];
        text = JSON.stringify(keep);
      }
      externalQualityStore = keep;
      localStorage.setItem(externalQualityStoreName, text);
    } catch (e) {}
  }

  function externalQualityStorePut(url, items) {
    var store = externalQualityStoreLoad();
    store[url] = { t: Date.now(), d: items };
    externalQualityStoreSave();
  }

  function externalQualityRemember(url, items) {
    externalQualityEpisodeCache[url] = items;
    externalQualityEpisodeOrder.push(url);
    // A long session across many titles must not keep every season's list forever.
    while (externalQualityEpisodeOrder.length > 60) {
      delete externalQualityEpisodeCache[externalQualityEpisodeOrder.shift()];
    }
  }

  function externalQualityEpisodes(url, complete) {
    if (externalQualityEpisodeCache[url]) { complete(externalQualityEpisodeCache[url]); return; }
    var stored = externalQualityStoreLoad()[url];
    if (stored) {
      externalQualityRemember(url, stored.d);
      complete(stored.d);
      return;
    }
    if (externalQualityEpisodeWaiters[url]) { externalQualityEpisodeWaiters[url].push(complete); return; }
    externalQualityEpisodeWaiters[url] = [complete];

    function settle(items) {
      var waiters = externalQualityEpisodeWaiters[url] || [];
      delete externalQualityEpisodeWaiters[url];
      if (items && items.length) {
        externalQualityRemember(url, items);
        externalQualityStorePut(url, items);
      }
      externalQualityRequests = externalQualityRequests.filter(function (request) { return request !== network; });
      waiters.forEach(function (waiter) { waiter(items || []); });
    }

    var network = new Lampa.Reguest();
    externalQualityRequests.push(network);
    network.timeout(9000);
    network['native'](account(url), function (response) {
      var json = typeof response === 'string' ? parseJson(response) : response;
      settle(json && Array.isArray(json.data) ? json.data : []);
    }, function () { settle(null); }, false, { dataType: 'text' });
  }

  // Lampa stringifies the whole play item for the Android app, which parses every field of it into
  // Java objects. Its player reads ten of those fields; the PidTor extras (manifest records, ffprobe,
  // the card duplicated per episode) are pure weight there, and on a phone already close to its heap
  // limit that weight is what makes the hand-off fail with a Java exception. The external copy keeps
  // only what the receiving app actually reads.
  var externalItemKeys = ['url', 'url_orig', 'title', 'thumbnail', 'img', 'image', 'poster', 'still_path',
    'timeline', 'quality', 'season', 'episode', 'segments', 'imdb_id', 'tmdb_id'];

  function externalTransportCopy(source) {
    var copy = {};
    externalItemKeys.forEach(function (key) {
      if (typeof source[key] !== 'undefined') copy[key] = source[key];
    });
    var card = source.card || source.movie;
    var imdbId = copy.imdb_id || (card && card.imdb_id);
    if (!copy.imdb_id && imdbId) copy.imdb_id = imdbId;
    return copy;
  }

  // The card is what names the film in the player header and what the client stores with the playback
  // state; its image lists, genres, seasons and overview are none of the player's business. The logo
  // is picked by language and the backdrop by vote, so both lists have to keep more than one entry.
  var externalCardKeys = ['id', 'tmdb_id', 'imdb_id', 'title', 'name', 'original_title', 'original_name',
    'type', 'media_type', 'release_date', 'first_air_date', 'release_year', 'backdrop_path',
    'background_image', 'poster_path'];

  function externalCardCopy(card) {
    if (!card) return null;
    var copy = {};
    externalCardKeys.forEach(function (key) {
      if (typeof card[key] !== 'undefined' && card[key] !== null) copy[key] = card[key];
    });
    var images = card.images || {};
    var logos = Array.isArray(images.logos) ? images.logos.slice(0, 12) : null;
    var backdrops = Array.isArray(images.backdrops) ? images.backdrops.slice(0, 12) : null;
    if (logos || backdrops) {
      copy.images = {};
      if (logos) copy.images.logos = logos;
      if (backdrops) copy.images.backdrops = backdrops;
    }
    return copy;
  }

  function externalHandOffItem(launch, playback) {
    var item = externalTransportCopy(launch);
    // Lampa routes an item to the Android app through its own branch condition, and `launch_player`
    // is the per-item way of saying it. `torrent_hash` used to stand in for it, but Lampa reads that
    // field everywhere as "this is a torrent": it runs its torrent loading screen, asks its torrent
    // server whether GStreamer works and marks the item as a torrent in its own player. None of that
    // is true here - the stream is an ordinary PidTor URL - so the hand-off names the player instead.
    item.launch_player = 'android';
    delete item.torrent_hash;
    // The card names the film in the player header and in its playlist - one trimmed copy, not one
    // full copy per episode.
    var card = externalCardCopy(launch.card || launch.movie);
    if (card) item.card = card;
    if (playback.length > 1) {
      var quality = launch.quality;
      var byEpisode = launch.pidtor_quality_episodes || null;
      // Stock Lampa hands a torrent to an external player as the whole files list plus the file that
      // is starting: the Android client looks that entry up by url (`MainActivity.runPlayer`:
      // `playlist.indexOfFirst { it.url == videoUrl }`) and silently starts the first entry when the
      // lookup misses (`createBaseIntent` plays `playlist[currentIndex].url`). The list therefore keeps
      // its natural order - that order is the player's episode numbering and its "next episode" - and
      // the handed-over url must be exactly the url of its own entry.
      //
      // That lookup used to miss because of Lampa itself: `Player.play` replaces the item's url with
      // the default-quality url taken from the top-level `quality` map (`video_quality_default`, 1080
      // by default), while the same episode's entry keeps the url PidTor resolved. The player then
      // starts at entry 0 - the first episode. For a glued season the top-level map is not needed: the
      // client builds its player items from `playlist` and every entry carries its own map, which is
      // what the player's quality panel reads. It stays only for the single-item path (a movie, or
      // `playlist_next` switched off), where there is no list to search.
      var launchIndex = -1;
      for (var place = 0; place < playback.length; place++) {
        if (String(playback[place].url) === String(launch.url)) { launchIndex = place; break; }
      }
      if (launchIndex < 0) {
        for (var fallback = 0; fallback < playback.length; fallback++) {
          if (parseInt(playback[fallback].episode || 0, 10) !== parseInt(launch.episode || 0, 10)) continue;
          if (parseInt(playback[fallback].season || 0, 10) !== parseInt(launch.season || 0, 10)) continue;
          launchIndex = fallback;
          break;
        }
      }
      if (launchIndex >= 0) {
        var autoNext = true;
        try { autoNext = Lampa.Storage.field('playlist_next') !== false; } catch (e) {}
        item.playlist = playback.map(function (entry, index) {
          var copy = externalTransportCopy(entry);
          if (index === launchIndex) {
            // The exact url Lampa hands over - the one that was warmed up and probed.
            copy.url = launch.url;
            if (quality) copy.quality = quality;
          } else if (byEpisode) {
            var own = byEpisode[parseInt(entry.episode || 0, 10)];
            if (own) copy.quality = own;
          }
          return copy;
        });
        if (autoNext) delete item.quality;
      }
    }
    return item;
  }

  // The quality list is a nicety, playback is not: if the Java bridge rejects the hand-off (a
  // heap-starved client throws while parsing the payload), it is retried without the list and the
  // list stays off for the rest of the session, so the same device is never pushed into it twice.
  function playWithQualityFallback(launch, playback, first, startedAt, requestedAt, preload) {
    function start(item) {
      Lampa.Player.play(item);
      Lampa.Player.playlist(playback.length ? playback : [first]);
    }
    function size(item) { try { return JSON.stringify(item).length; } catch (e) { return 0; } }
    function report(mode, extra) {
      var fields = { play: mode };
      // How long the quality nicety kept the viewer waiting before the player was even asked to open,
      // and how long the whole request took (PidTor's own manifest, torrent warm-up and probe).
      if (startedAt) fields.wait = Date.now() - startedAt;
      if (requestedAt) fields.req = Date.now() - requestedAt;
      // ...and which part of that was not ours at all: `pre` is the time before the season plan was
      // asked for, `plan` the plan request itself, `nav` how long this page has been alive (a press
      // that reloaded Lampa instead of launching shows a page age smaller than the request).
      if (playbackStages.at) {
        if (playbackStages.planStart) fields.pre = playbackStages.planStart - playbackStages.at;
        if (playbackStages.planStart && playbackStages.planEnd) fields.plan = playbackStages.planEnd - playbackStages.planStart;
        if (playbackStages.plan) fields.plan_from = playbackStages.plan;
      }
      try {
        if (typeof performance !== 'undefined' && performance && performance.now) fields.nav = Math.round(performance.now());
      } catch (e) {}
      fields.boot = pluginBoot;
      var facts = externalHandOffFacts(launch);
      Object.keys(facts).forEach(function (key) { fields[key] = facts[key]; });
      if (extra) Object.keys(extra).forEach(function (key) { fields[key] = extra[key]; });
      externalHandOffReport(fields);
    }
    var external = externalPlayerTarget(launch);
    if (!external) { report('full', { bytes: size(launch) }); start(launch); return; }

    // Внешнему плееру Lampa отдаёт интент сразу - он и открывался на нуле чёрным экраном.
    // Сначала окно наполнения (логотип, процент, пиры), и только потом интент.
    if (preload) preload.then(function () { handOff(); });
    else fillBuffer(launch, launch.url, function () { handOff(); });

    function handOff() {
    var item = externalHandOffItem(launch, playback);
    var facts = {
      q: item.quality ? Object.keys(item.quality).length : 0,
      // Playlist entries that carry their own quality map - one per episode when the season is glued.
      qe: (item.playlist || []).filter(function (entry) { return !!entry.quality; }).length,
      pl: (item.playlist || []).length,
      bytes: size(item)
    };
    if (!item.quality && !(item.playlist || []).some(function (entry) { return entry.quality; })) {
      report('plain', facts);
      start(item);
      warmQualityVariants(launch);
      return;
    }
    try {
      start(item);
      report('quality', facts);
      warmQualityVariants(launch);
    } catch (error) {
      console.warn('[PidTor] внешний плеер не принял список качеств, запускаю без него:', error);
      externalQualityDisabled = true;
      delete item.quality;
      (item.playlist || []).forEach(function (entry) { delete entry.quality; });
      report('retry', Object.assign({ err: String((error && error.message) || error).slice(0, 120) }, facts));
      if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show('PidTor: плеер не принял список качеств');
      start(item);
    }
    }
  }

  function externalQualityUrl(entry, episode) {
    if (!entry) return '';
    if (entry.single) return entry.single;
    if (entry.episodes) return entry.episodes[episode] || '';
    return '';
  }

  // What each quality would play, keyed by the replica PidTor itself would pick: the file the chosen
  // audio lives in first, then the option's own variant, then the seeders. Shared by the prefetch and
  // the hand-off, so both ask for exactly the same torrents.
  function externalQualityPlan(data, launch) {
    var options = qualityOptions(data);
    if (!options || options.length < 2) return null;
    var preferredHash = canonicalHash(String(launch && (launch.pidtor_audio_key || launch.pidtor_subtitle_key) || '').split(':')[0]);
    return options.map(function (option) {
      return { key: option.key, candidate: qualityOptionReplica(option, preferredHash) };
    }).filter(function (plan) { return !!plan.candidate; });
  }

  // One list at a time, with a gap. A quality list is not free on the server: when PidTor's SQL cache
  // does not know the torrent yet, the module adds it to TorrServer and waits for its file list before
  // it can answer. Eight of those at once is what a cold season used to ask for - on a small server
  // that is a burst of magnets, and it is what took the machine down. Sequential requests fill the
  // same caches (server side for 36 minutes and up, device side for 12 hours) without the burst.
  var externalQualityQueue = [];
  var externalQualityQueueActive = false;
  var externalQualityQueueGap = 300;
  var externalQualityQueueWaiters = {};
  var externalQualityPrefetchLimit = 8;

  function externalQualityQueueRelease(url) {
    var waiters = externalQualityQueueWaiters[url] || [];
    delete externalQualityQueueWaiters[url];
    var items = externalQualityEpisodeCache[url] || [];
    waiters.forEach(function (waiter) { waiter(items); });
  }

  function externalQualityQueueNext() {
    if (externalQualityQueueActive) return;
    while (externalQualityQueue.length) {
      var url = externalQualityQueue.shift();
      if (externalQualityEpisodeCache[url]) { externalQualityQueueRelease(url); continue; }
      externalQualityQueueActive = true;
      (function (target) {
        var synchronous = true;
        externalQualityEpisodes(target, function () {
          var fromCache = synchronous;
          externalQualityQueueActive = false;
          externalQualityQueueRelease(target);
          // Nothing was asked of the server, so the next one can go right away.
          if (fromCache) externalQualityQueueNext();
          else setTimeout(externalQualityQueueNext, externalQualityQueueGap);
        });
        synchronous = false;
      })(url);
      return;
    }
  }

  function externalQualityQueueSubscribe(url, complete) {
    if (!url) return;
    if (externalQualityEpisodeCache[url]) {
      if (complete) complete(externalQualityEpisodeCache[url]);
      return;
    }
    if (!externalQualityQueueWaiters[url]) {
      externalQualityQueueWaiters[url] = [];
      externalQualityQueue.push(url);
    }
    if (complete) externalQualityQueueWaiters[url].push(complete);
    externalQualityQueueNext();
  }

  // The episode lists behind the quality map are the only thing a hand-off ever waits for, so the ask
  // goes out the moment the play request starts - not when the stream is finally ready, which is a
  // torrent warm-up and a probe later. Nothing here is item-specific on purpose: at this point there
  // is no launch item yet, and the play item's own audio pick only reorders the same replicas.
  function prefetchExternalQualityLists(data) {
    if (externalQualityDisabled || !externalPlayerBridge()) return;
    var plan = externalQualityPlan(data, null);
    if (!plan || plan.length < 2) return;
    plan.slice(0, externalQualityPrefetchLimit).forEach(function (item) {
      externalQualityQueueSubscribe(item.candidate.replica.episodes_url, null);
    });
  }

  // Started as soon as the stream is resolved, so the episode lists are already on their way while the
  // torrent is being warmed - the hand-off itself then usually has nothing left to wait for.
  function prefetchExternalQuality(data, launch) {
    if (!externalPlayerTarget(launch)) return;
    var plan = externalQualityPlan(data, launch);
    if (!plan) return;
    plan.slice(0, externalQualityPrefetchLimit).forEach(function (item) {
      externalQualityQueueSubscribe(item.candidate.replica.episodes_url, null);
    });
  }

  // Builds the map for the episode that is starting and hangs it on the launch item only. The map is
  // deliberately not copied to the rest of the playlist: Lampa serializes the whole playlist into the
  // Android intent, and a client already close to its heap limit does not need one URL set per episode
  // per quality. Never blocks playback for long: whatever answered inside the deadline is used, and the
  // verified URL of the running episode always wins over the guessed one.
  function attachExternalQuality(data, launch, complete) {
    if (!externalPlayerTarget(launch)) { complete(); return; }
    var plan = externalQualityPlan(data, launch);
    if (!plan || plan.length < 2) { complete(); return; }
    var sequence = ++externalQualitySequence;
    var generation = playbackRequestGeneration;
    var resolved = {};
    var pending = plan.length;
    var finished = false;
    var timer = setTimeout(finish, 1500);

    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // A newer hand-off (another quality attempt, another episode) owns the player now: this one
      // must not start playback again when its deadline expires. Requests still in flight are left
      // alone - they are shared and their answers cache for the next episode.
      if (sequence !== externalQualitySequence) return;
      if (generation === playbackRequestGeneration) apply();
      complete();
    }

    // What one episode of this season would play in every quality, from the lists already answered.
    function episodeQuality(number) {
      var map = {};
      plan.forEach(function (item) {
        var url = externalQualityUrl(resolved[item.key], number);
        if (url) map[item.key] = url;
      });
      return Object.keys(map).length >= 2 ? map : null;
    }

    // A quality list shorter than the season is a torrent whose file table was discovered partially
    // (or read from a stale partial server cache). It is used for what it has, but it must not stay
    // in the 12-hour device cache: that would keep hiding the quality panel long after the server
    // healed. Dropping it makes the next play ask again and, with a full answer, offer every quality.
    function forgetShortLists() {
      var seasonSize = (launch.playlist && launch.playlist.length) || 0;
      if (seasonSize < 2) return;
      var dirty = false;
      plan.forEach(function (item) {
        var resolvedItem = resolved[item.key];
        if (!resolvedItem || !resolvedItem.episodes) return;
        if (Object.keys(resolvedItem.episodes).length >= seasonSize) return;
        var url = account(item.candidate.replica.episodes_url);
        if (externalQualityEpisodeCache[url]) delete externalQualityEpisodeCache[url];
        var store = externalQualityStoreLoad();
        if (store[url]) { delete store[url]; dirty = true; }
      });
      if (dirty) externalQualityStoreSave();
    }

    function apply() {
      var episode = parseInt(launch.episode || 0, 10);
      forgetShortLists();
      var map = episodeQuality(episode);
      if (!map) return;
      // The selected quality is the URL that was actually probed and started.
      if (launch.pidtor_quality_key && launch.url) map[launch.pidtor_quality_key] = launch.url;
      launch.quality = map;
      // One map per episode of the season, not one per session: the client turns every entry of this
      // playlist into its own player item, quality map and all, and a player offers "Video quality"
      // for the item it is playing. A map only on the launch item is why the panel disappeared on
      // the second episode. Keyed by episode number and kept off the wire - externalHandOffItem
      // reads it and puts each map on its own playlist entry.
      var perEpisode = {};
      (launch.playlist || []).forEach(function (entry) {
        var number = parseInt(entry.episode || 0, 10);
        if (!number || parseInt(entry.season || 0, 10) !== parseInt(launch.season || 0, 10)) return;
        var own = episodeQuality(number);
        if (own) perEpisode[number] = own;
      });
      if (Object.keys(perEpisode).length) launch.pidtor_quality_episodes = perEpisode;
    }

    plan.forEach(function (item) {
      if (item.candidate.replica.stream_url) {
        resolved[item.key] = { single: account(sourceForPlayback(item.candidate.replica.stream_url, false)) };
        if (!--pending) finish();
        return;
      }
      // Subscribed, not fired: the queue decides when the server is asked, so the hand-off cannot turn
      // a cold season into a burst of magnets. Whatever answered inside the deadline is what is used.
      externalQualityQueueSubscribe(item.candidate.replica.episodes_url, function (episodes) {
        var urls = {};
        (episodes || []).forEach(function (episode) {
          if (!episode || !episode.url) return;
          urls[parseInt(episode.e || 0, 10)] = account(sourceForPlayback(episode.url, false));
        });
        if (Object.keys(urls).length) resolved[item.key] = { episodes: urls };
        if (!--pending) finish();
      });
    });
  }

  function defaultQuality(options) {
    if (!options || !options.length) return null;
    var preferred = options.filter(function (option) { return qualityRank(option.variant) === 1080; });
    if (!preferred.length) preferred = options.filter(function (option) { return qualityRank(option.variant) === 720; });
    var selected = (preferred.length ? preferred : options).slice().sort(function (a, b) {
      var aPriority = Math.max.apply(Math, (a.variants || [a.variant]).map(playbackPriority));
      var bPriority = Math.max.apply(Math, (b.variants || [b.variant]).map(playbackPriority));
      return bPriority - aPriority || qualityRank(b.variant) - qualityRank(a.variant) || seeders(b.variant) - seeders(a.variant);
    })[0];
    selected.variant = (selected.variants || [selected.variant]).slice().sort(function (a, b) {
      return playbackPriority(b) - playbackPriority(a) || variantScore(b) - variantScore(a);
    })[0];
    return selected;
  }

  function automaticQualityOption(option, maxRank) {
    var variants = (option.variants || [option.variant]).filter(function (variant) {
      return variant && supportsAutomaticVariant(variant)
        && (!maxRank || qualityRank(variant) <= maxRank);
    }).sort(function (a, b) { return playbackPriority(b) - playbackPriority(a) || variantScore(b) - variantScore(a); });
    if (!variants.length) return null;
    return Object.assign({}, option, {
      key: option.key + '|auto|' + variants.map(function (variant) { return variant.id; }).sort().join(','),
      variant: variants[0], variants: variants
    });
  }

  function supportsAutomaticVariant(variant) {
    var codec = videoCodec(variant);
    if (/(?:h264|avc|x264|h\.264)/.test(codec)) return true;
    return /(?:hevc|h265|x265|h\.265)/.test(codec) && supportsVariant(variant);
  }

  function automaticResolved(resolved, policy) {
    var records = (resolved.source_records || []).filter(function (record) {
      return supportsAutomaticVariant(record.variant)
        && (!policy.maxRank || qualityRank(record.variant) <= policy.maxRank)
        && (!policy.confirmFile || confirmedProbeStreams(record.variant, sourceFile(record)));
    });
    if (!records.length) return null;
    var first = records[0];
    var copy = Object.assign({}, resolved, {
      source_records: records, url: first.url, variant: first.variant,
      sources: records.filter(function (record) { return sameVariantFile(record.variant, first.variant); }).map(function (record) { return record.url; }),
      available_variant_ids: records.map(function (record) { return record.variant.id; }).filter(function (id, index, all) { return all.indexOf(id) === index; })
    });
    copy.episodes = (resolved.episodes || []).map(function (episode) {
      if (parseInt(episode.e || 0, 10) !== parseInt(resolved.requested_episode || 0, 10)) return episode;
      return Object.assign({}, episode, {
        url: copy.url, pidtor_source_urls: copy.sources, pidtor_source_records: records,
        pidtor_variant: first.variant, pidtor_available_variant_ids: copy.available_variant_ids
      });
    });
    return copy;
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
        var choice = { title: title, track: track, variant: variant, order: index, field: field };
        choice.track_id = variant.source_file_key && Number.isInteger(track.stream_index)
          ? variant.source_file_key + ':' + (field === 'audio' ? 'audio' : 'subtitle') + ':' + track.stream_index : '';
        var key = choice.track_id || choiceIdentity(choice);
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

  function groupTrackChoices(choices, field, qualityKey) {
    var groups = [], seen = {};
    (choices || []).forEach(function (choice) {
      var name = normalized(choice.title), language = normalizedLanguage(choice.track && choice.track.language);
      var generic = !name || /^(дубляж|русская дорожка|русский|русская|многоголосая|авторская|russian|original|оригинал|ru|rus|en|eng|und)$/.test(name);
      var id = field + '|' + name + '|' + language;
      if (generic) id += '|' + (choice.track_id || choiceIdentity(choice));
      if (!seen[id]) { seen[id] = { group_id: id, title: choice.title, choices: [] }; groups.push(seen[id]); }
      seen[id].choices.push(choice);
    });
    return groups;
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
    return !!(a && b && a.source_file_key && a.source_file_key === b.source_file_key);
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
      var technical = matchingTitle.filter(function (choice) {
        var track = choice.track || {}, remembered = previous.track || {};
        return normalized(track.codec) === normalized(remembered.codec)
          && Number(track.channels || 0) === Number(remembered.channels || 0)
          && (track.forced === true) === (remembered.forced === true);
      });
      if (technical.length === 1) return technical[0];
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

  function streamIndex(url) {
    var value = parseInt((String(url || '').match(/[?&]tsid=(\d+)/i) || [])[1], 10);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  function bufferSpeed(bytes) {
    var value = parseInt(bytes, 10) || 0;
    if (value <= 0) return '';
    if (value >= 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' МБ/с';
    return Math.round(value / 1024) + ' КБ/с';
  }

  // Окно наполнения. Lampa умеет показывать его сама - шаблон media-loading с логотипом,
  // процентом, пирами и скоростью (Lampa.Loading), - но включает только для собственных
  // торрентов. У PidTor поток обычный URL, поэтому окно запускаем сами: тёплый запрос
  // к потоку запускает серверную предзагрузку TorrServer, дальше ждём буфер и только
  // потом отдаём URL плееру. Без этого плеер открывался на нуле и висел чёрным экраном.
  var bufferWindowMinBytes = 8 * 1024 * 1024;
  var bufferWindowTimeout = 25 * 1000;
  var bufferWindowIdleTimeout = 12 * 1000;

  function fillBuffer(data, streamUrl, done) {
    var hash = streamHash(streamUrl);
    var index = streamIndex(streamUrl);
    var Loading = Lampa.Loading;
    if (!pidtorPreloadMb || !hash || !Loading || typeof Loading.start !== 'function') { done(); return; }

    var finished = false, cancelled = false, timer = null, started = Date.now(), lastData = 0;
    var lastLoaded = 0, lastLoadedAt = Date.now();

    function close(message) {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      try { Loading.stop(); } catch (e) {}
      if (message && Lampa.Noty) Lampa.Noty.show(message);
      done();
    }

    // Пока окно открыто, зритель мог нажать другую серию: чужое окно не должно ни ждать, ни
    // останавливать Loading уже нового запуска.
    function stale() {
      return !!data && typeof data.pidtor_playlist_session === 'number'
        && data.pidtor_playlist_session !== playbackRequestGeneration;
    }

    function tick() {
      if (finished || cancelled) return;
      if (stale()) { finished = true; if (timer) clearInterval(timer); return; }
      var elapsed = Date.now() - started;
      if (elapsed > bufferWindowTimeout || (lastData === 0 && elapsed > bufferWindowIdleTimeout)) {
        close(lastData === 0 ? 'Торрент не отдаёт данные — пробуем играть' : 'Буфер не наполнился — пробуем играть');
        return;
      }

      var network = new Lampa.Reguest();
      network.timeout(4000);
      network['native'](account(API + '/lite/pidtor/preload/' + hash + '?index=' + index), function (response) {
        if (finished || cancelled) return;
        var json = typeof response === 'string' ? parseJson(response) : response;
        if (!json) return;
        var loaded = parseInt(json.preloaded, 10) || 0;
        var target = parseInt(json.preload_size, 10) || 0;
        var percent = target > 0 ? Math.min(100, Math.round(loaded * 100 / target)) : (parseInt(json.percent, 10) || 0);
        var now = Date.now();
        if (loaded > 0) lastData = now;
        var speed = loaded > lastLoaded && now > lastLoadedAt ? (loaded - lastLoaded) * 1000 / (now - lastLoadedAt) : 0;
        if (loaded !== lastLoaded) { lastLoaded = loaded; lastLoadedAt = now; }
        try {
          Loading.setProgress(percent, {
            speed: bufferSpeed(speed),
            active_peers: json.active_peers,
            total_peers: json.total_peers
          });
        } catch (e) {}
        if (loaded >= Math.min(bufferWindowMinBytes, target > 0 ? target : bufferWindowMinBytes)) close();
      }, function () {}, false, { dataType: 'json' });
    }

    try {
      Loading.start(function () { cancelled = true; close(); }, 'Наполняем буфер…', { media: data, progress: 0 });
    } catch (e) { done(); return; }

    // Тёплый запрос: он и запускает предзагрузку на сервере (модуль отвечает 302, а качает
    // TorrServer - после обрыва клиента он не останавливается). Тот же помощник, что греет
    // выбранную серию на нажатие: повторный запрос на уже тёплый адрес не уходит.
    warmStream(streamUrl);

    timer = setInterval(tick, 500);
    tick();
  }

  // Окно наполнения отдаётся наружу ручкой: его можно открыть сразу, а ждать - когда нужно
  // передавать поток плееру (списки качеств к этому моменту обычно уже пришли).
  function startBufferWindow(data, streamUrl) {
    var finished = false;
    var waiters = [];
    function settle() {
      if (finished) return;
      finished = true;
      var list = waiters;
      waiters = [];
      list.forEach(function (fn) { try { fn(); } catch (e) {} });
    }
    fillBuffer(data, streamUrl, settle);
    return {
      then: function (callback) {
        if (finished) { try { callback(); } catch (e) {} return; }
        waiters.push(callback);
      }
    };
  }

  // Предзагрузка TorrServer (preload=32) стартует только после запроса потока. Запрос уходит
  // отсюда - сразу на нажатие, ещё до того как PidTor резолвит поток, и после передачи плееру для
  // остальных качеств. Повторный тёплый запрос не нужен: TorrServer продолжает качать и после
  // обрыва клиента, а адреса помним несколько минут.
  var warmStreams = {};
  var warmStreamTtl = 4 * 60 * 1000;

  function warmStream(url) {
    if (!pidtorPreloadMb || !url) return;
    var key = String(url);
    var now = Date.now();
    if (warmStreams[key] && now - warmStreams[key] < warmStreamTtl) return;
    warmStreams[key] = now;
    try {
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      fetch(url, { mode: 'no-cors', signal: controller ? controller.signal : undefined })['catch'](function () {});
      setTimeout(function () { try { if (controller) controller.abort(); } catch (e) {} }, 2500);
    } catch (e) {}
  }

  // Адрес потока выбранного качества для этой серии: та же реплика, где лежит выбранная
  // аудиодорожка (её список серий уже запрошен префетчем качеств). Нагреваем его на нажатие,
  // пока идёт резолв, - к открытию окна наполнения TorrServer уже качает.
  function warmChosenEpisode(selected, episodeNumber, preferences) {
    if (!pidtorPreloadMb || !selected) return;
    try {
      if (String(Lampa.Storage.field('player') || '') !== 'android') return;
    } catch (e) { return; }
    var preferredHash = canonicalHash(String((preferences && (preferences.pidtor_audio_key || preferences.pidtor_subtitle_key)) || '').split(':')[0]);
    var candidate = qualityOptionReplica(selected, preferredHash);
    if (!candidate || !candidate.replica) return;
    if (candidate.replica.stream_url) {
      warmStream(account(sourceForPlayback(candidate.replica.stream_url, false)));
      return;
    }
    if (!candidate.replica.episodes_url) return;
    externalQualityQueueSubscribe(candidate.replica.episodes_url, function (episodes) {
      (episodes || []).forEach(function (episode) {
        if (parseInt(episode && episode.e || 0, 10) !== Number(episodeNumber)) return;
        if (episode.url) warmStream(account(sourceForPlayback(episode.url, false)));
      });
    });
  }

  // Фильм греется на нажатие тем же тёплым запросом, что и серия: пока PidTor ищет файл и
  // проверяет его, TorrServer уже тянет начало фильма - окно наполнения открывается на тёплом
  // торренте, а не на нуле. Вызывается дважды: из кэша карточки ещё до сети и после ответа PidTor.
  function warmMovieChoice(data, preferences) {
    if (!pidtorPreloadMb || !data) return;
    var options = qualityOptions(data);
    if (!Array.isArray(options) || !options.length) return;
    var preferred = preferences && preferences.pidtor_quality_key;
    var selected = options.filter(function (option) {
      return preferred && option.key === preferred;
    })[0] || defaultQuality(options);
    if (!selected) return;
    var replicas = [];
    var seen = {};
    (selected.variants || [selected.variant]).forEach(function (variant) {
      (variant && variant.replicas || []).forEach(function (replica) {
        if (!replica || !replica.stream_url || seen[replica.stream_url]) return;
        seen[replica.stream_url] = true;
        replicas.push(replica);
      });
    });
    replicas.sort(function (a, b) { return parseInt(b.seeders || 0, 10) - parseInt(a.seeders || 0, 10); });
    // Хватает двух копий: одна заиграет, вторая останется резервом при неудачной проверке файла.
    replicas.slice(0, 2).forEach(function (replica) {
      warmStream(account(sourceForPlayback(replica.stream_url, false)));
    });
  }

  // Переключение качества во внешнем плеере уходит на адрес другого качества напрямую и минует
  // плагин, а TorrServer до этого адреса ничего не качал - отсюда долгий старт. После передачи
  // потока догреваем остальные качества текущей серии по одному: к моменту, когда зритель откроет
  // "Качество видео", они уже наполняются.
  var warmQualityTimer = null;

  function warmQualityVariants(launch) {
    if (!pidtorPreloadMb || !launch || !launch.quality) return;
    var urls = Object.keys(launch.quality).map(function (key) { return launch.quality[key]; })
      .filter(function (url) { return typeof url === 'string' && url && url !== launch.url; });
    if (!urls.length) return;
    var generation = playbackRequestGeneration;
    if (warmQualityTimer) clearTimeout(warmQualityTimer);
    var index = 0;
    function next() {
      warmQualityTimer = null;
      if (generation !== playbackRequestGeneration) return;
      if (index >= urls.length) return;
      warmStream(urls[index++]);
      warmQualityTimer = setTimeout(next, 1500);
    }
    warmQualityTimer = setTimeout(next, 1200);
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
    if (activePositionRestore) activePositionRestore();
    var restored = false;
    var attempts = 0;
    var timer = null;
    function finish(cancelled) {
      if (restored) return;
      restored = true;
      if (activePositionRestore === cancel) activePositionRestore = null;
      Lampa.PlayerVideo.listener.remove('loadeddata', restore);
      if (timer) clearInterval(timer);
      if (!cancelled && callback) callback();
    }
    function cancel() { finish(true); }
    activePositionRestore = cancel;
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
        item.pidtor_audio_key = '';
        item.pidtor_subtitle_key = '';
        item.pidtor_audio_choice = semanticChoice(currentChoice(data, 'audio') || data.pidtor_pending_audio_choice || data.pidtor_audio_choice);
        item.pidtor_pending_audio_choice = item.pidtor_audio_choice;
        item.pidtor_subtitle_choice = semanticChoice(currentChoice(data, 'subtitle') || data.pidtor_subtitle_choice);
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
      // Сначала окно наполнения (логотип, процент, пиры), потом поток плееру.
      fillBuffer(data, source, function () {
        if (!ownsPlayer(data)) return;
        Lampa.PlayerVideo.destroy(true);
        Lampa.PlayerVideo.url(source, true);
        startPlaybackMonitor(data);
        restorePosition(position, function () {
          if (!ownsPlayer(data)) return;
          Lampa.Player.loading(false);
          if (afterLoad) afterLoad();
          installPlayerControls(data);
        }, previousSource, data);
      });
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
    var choices = [];
    groupTrackChoices(data.pidtor_audio_options || [], 'audio', data.pidtor_quality_key).forEach(function (group) {
      var ranked = group.choices.slice().sort(function (a, b) {
        function rank(choice) { return (data.pidtor_audio_key === choice.key ? 8 : 0) + (sameVariantFile(choice.variant, data.pidtor_variant) ? 4 : 0)
          + (qualityRank(choice.variant) === qualityRank(data.pidtor_variant) ? 2 : 0) + (choice.variant && choice.variant.ffprobe ? 1 : 0); }
        return rank(b) - rank(a);
      });
      if (!ranked.length) return;
      choices.push(ranked[0]);
      // Different native tracks in the active file remain individually selectable.
      ranked.slice(1).forEach(function (choice) {
        if (sameVariantFile(choice.variant, ranked[0].variant) && choice.track.stream_index !== ranked[0].track.stream_index)
          choices.push(Object.assign({}, choice, { title: group.title + ' · ' + String(choice.track.codec || '').toUpperCase() + ' #' + choice.track.stream_index }));
      });
    });
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
          var generation = (data.pidtor_source_request_generation || 0) + 1;
          data.pidtor_source_request_generation = generation;
          data.pidtor_source_request_pending = false;
          var exact = choice.variant && Array.isArray(choice.variant.ffprobe) && choice.variant.source_file_key;
          if (exact && sameVariantFile(data.pidtor_variant, choice.variant) && !selectNativeAudio(choice.order)) {
            Lampa.Noty.show('Браузер не поддерживает переключение дорожек. Откройте во внешнем плеере.');
            return;
          }
          function selected(actual) {
            data.pidtor_audio_key = actual.key;
            data.pidtor_audio_stream_index = parseInt(actual.track.stream_index, 10);
            data.pidtor_audio_ffprobe_index = data.pidtor_audio_stream_index;
            data.pidtor_pending_audio_choice = null;
            emitResumeState(data);
          }
          if (exact && sameVariantFile(data.pidtor_variant, choice.variant)) {
            selected(choice);
            selectNativeAudio(choice.order);
            installPlayerControls(data);
            return;
          }
          data.pidtor_source_request_pending = true;
          choice.resolve(function (resolved) {
            if (!ownsPlayer(data) || data.pidtor_source_request_generation !== generation) return;
            data.pidtor_source_request_pending = false;
            var confirmed = resolved.audio_choice || preferredChoice((resolved.audio_options || []).filter(function (candidate) {
              return candidate.variant && confirmedProbeStreams(candidate.variant, sourceFile({url: resolved.url, variant: candidate.variant}));
            }), choice, true);
            if (!confirmed) {
              var option = { key: data.pidtor_quality_key, variant: resolved.variant, variants: [resolved.variant] };
              confirmed = preferredChoice(resolvedTrackChoices(option, resolved, 'audio'), choice, true);
            }
            if (!confirmed) { Lampa.Noty.show('Аудиодорожка недоступна'); return; }
            selected(confirmed);
            replaceSource(data, resolvedWithChoice(resolved, confirmed, 'audio'), confirmed.variant,
              function () { selectNativeAudio(confirmed.order); });
          }, function (message) {
            if (!ownsPlayer(data) || data.pidtor_source_request_generation !== generation) return;
            data.pidtor_source_request_pending = false;
            Lampa.Noty.show(message || 'Аудиодорожка недоступна');
          });
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

  function buildQualityItems(data, automatic) {
    return (data.pidtor_quality_options || []).map(function (option) {
      var item = { title: option.key, selected: option.key === data.pidtor_quality_key };
      Object.defineProperty(item, 'enabled', {
        set: function (enabled) {
          if (!enabled || !ownsPlayer(data)) return;
          var requestGeneration = (data.pidtor_source_request_generation || 0) + 1;
          data.pidtor_source_request_generation = requestGeneration;
          data.pidtor_source_request_pending = false;
          if (option.key === data.pidtor_quality_key) return;
          data.pidtor_source_request_pending = true;
          function currentRequest() { return ownsPlayer(data) && data.pidtor_source_request_generation === requestGeneration; }
          function requestFailed(message) {
            if (!currentRequest()) return;
            data.pidtor_source_request_pending = false;
            startPlaybackMonitor(data);
            Lampa.Noty.show(message || 'Качество недоступно');
          }
          var previousAudio = currentChoice(data, 'audio') || data.pidtor_pending_audio_choice;
          var previousSubtitle = currentChoice(data, 'subtitle');
          followQualityTracks(option, data);
          option.resolve(function (resolved) {
            if (!currentRequest()) return;
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
              }, requestFailed);
              return;
            }
            applyResolved(resolvedWithChoice(resolved, targetAudio, 'audio'), audioOptions, subtitleOptions, targetAudio, targetSubtitle);
          }, requestFailed, null, automatic);

          function applyResolved(resolved, audioOptions, subtitleOptions, targetAudio, targetSubtitle) {
            if (!currentRequest()) return;
            data.pidtor_source_request_pending = false;
            data.pidtor_manual_quality = !automatic;
            data.pidtor_quality_key = option.key;
            data.pidtor_tracks_ready = resolved.tracks_ready === true;
            data.pidtor_audio_options = audioOptions;
            data.pidtor_subtitle_options = subtitleOptions;
            data.pidtor_audio_key = targetAudio ? targetAudio.key : '';
            data.pidtor_pending_audio_choice = targetAudio ? null : previousAudio;
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
    var lastBuffered = 0;

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
      var maxRank = current ? qualityRank(current.variant) : qualityRank(data.pidtor_variant);
      var candidates = options.filter(function (option) {
        return option.key !== data.pidtor_quality_key && automaticQualityOption(option, maxRank);
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
      var quality = buildQualityItems(data, { maxRank: maxRank, confirmFile: true }).filter(function (item) { return item.title === target.key; })[0];
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
      if (data.pidtor_source_request_pending) {
        lastAdvance = Date.now();
        return;
      }
      var video = videoElement();
      var stallTimeout = hasAdvanced ? 14000 : (data.pidtor_use_gst === true ? 30000 : 15000);
      if (!video) {
        if (Date.now() - lastAdvance >= stallTimeout) failover();
        return;
      }
      if (video.ended) return;
      if (video.error) {
        var code = Number(video.error.code || 0);
        if (data.pidtor_manual_quality) {
          stopPlaybackMonitor();
          Lampa.Player.loading(false);
          Lampa.Noty.show(code === 3 || code === 4
            ? 'Плеер не смог декодировать ' + data.pidtor_quality_key + '. Выберите другую копию или качество.'
            : 'Не удалось получить поток ' + data.pidtor_quality_key + '. Выберите другую копию или качество.');
        } else failover();
        return;
      }
      try {
        var buffered = 0;
        for (var range = 0; video.buffered && range < video.buffered.length; range++) {
          buffered += Math.max(0, video.buffered.end(range) - video.buffered.start(range));
        }
        if (buffered > lastBuffered + 0.05) lastAdvance = Date.now();
        lastBuffered = buffered;
      } catch (e) {}
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
      if (Date.now() - lastAdvance >= stallTimeout) {
        if (data.pidtor_manual_quality) {
          stopPlaybackMonitor();
          Lampa.Player.loading(false);
          Lampa.Noty.show('Поток ' + data.pidtor_quality_key + ' не продвигается. Выберите другую копию или качество.');
        } else failover();
      }
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
    var seasonAvailability = {};
    var seasonProbeBusy = false;
    var seasonProbeStopped = false;
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
      // A press is waiting for this plan when the stages were armed by playEpisode; a screen that is
      // just being drawn is not, and must not overwrite them.
      var staged = !!playbackStages.at && !playbackStages.plan;
      if (staged) playbackStages.plan = responseCache[key] ? 'cache' : 'net';
      if (staged && playbackStages.plan === 'net') playbackStages.planStart = Date.now();
      if (responseCache[key]) {
        complete(responseCache[key]);
        return;
      }
      if (responseWaiters[key]) {
        responseWaiters[key].push({ complete: complete, error: error });
        return;
      }
      responseWaiters[key] = [{ complete: complete, error: error }];

      function planAnswered() {
        if (playbackStages.planStart && !playbackStages.planEnd) playbackStages.planEnd = Date.now();
      }

      function resolveWaiters(data, message) {
        planAnswered();
        var waiters = responseWaiters[key] || [];
        delete responseWaiters[key];
        waiters.forEach(function (waiter) {
          if (data) waiter.complete(data);
          else if (waiter.error) waiter.error(message);
        });
      }

      request(API + '/lite/pidtor/v2?' + query(object.movie, seasonNumber, episodeNumber), function (data) {
        if (!data || !Array.isArray(data.variants) || !data.variants.length) {
          markSeason(seasonNumber, data && !data.error ? false : null);
          resolveWaiters(null, 'Подходящих вариантов не найдено');
          return;
        }
        markSeason(seasonNumber, true);
        if (Array.isArray(data.seasons) && data.seasons.length) {
          seasonCount = Math.max(seasonCount, data.seasons.reduce(function (maximum, item) {
            return Math.max(maximum, parseInt(item.season || 0, 10));
          }, 1));
          setFilter();
          probeSeasons();
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

    function resolveOption(option, episodeNumber, complete, error, update, selection) {
      selection = selection || {};
      var resolveSeason = season;
      var movieKey = String(object.movie.source || 'tmdb') + '|' + String(object.movie.id || object.movie.tmdb_id || '') + '|' + normalized(object.movie.original_title || object.movie.original_name || object.movie.title || object.movie.name || '');
      var nextAfter = Math.max(0, Number(selection.next_after || 0));
      var cacheKey = movieKey + '|r9|' + resolveSeason + '|' + option.key + '|' + (selection.preferred_file_key || '') + '|' + Object.keys(selection.failed_file_keys || {}).sort().join(',') + '|after:' + nextAfter;
      var cached = resolutionCache[cacheKey] || getEpisodeResolution(cacheKey);
      if (cached && !resolutionCache[cacheKey]) resolutionCache[cacheKey] = cached;

      function forEpisode(resolved) {
        if (!isSerial(object.movie)) return resolved;
        var selected = (resolved.episodes || []).filter(function (item) {
          return nextAfter ? parseInt(item.e || 0, 10) > nextAfter : parseInt(item.e || 0, 10) === parseInt(episodeNumber, 10);
        }).sort(function (a, b) { return Number(a.e) - Number(b.e); })[0];
        if (!selected) return null;
        return {
          url: selected.url,
          sources: selected.pidtor_source_urls || [selected.url],
          source_records: selected.pidtor_source_records || [],
          episodes: resolved.episodes,
          variant: selected.pidtor_variant || resolved.variant,
          media_name: selected.name || selected.media_name || '',
          available_variant_ids: selected.pidtor_available_variant_ids || [],
          requested_episode: parseInt(selected.e, 10),
          resolution_pending: resolved.resolution_pending === true
        };
      }

      if (update && (!cached || cached.resolution_pending)) {
        if (!resolutionUpdates[cacheKey]) resolutionUpdates[cacheKey] = [];
        resolutionUpdates[cacheKey].push(function (resolved) {
          var selected = forEpisode(resolved);
          if (selected) update(selected);
        });
      }
      if (cached && forEpisode(cached)) {
        complete(forEpisode(cached));
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
        var preferredHash = (selection.preferred_file_key || '').split(':')[0];
        if (preferredHash) {
          var fileA = canonicalHash(a.replica.infohash) === preferredHash ? 1 : 0;
          var fileB = canonicalHash(b.replica.infohash) === preferredHash ? 1 : 0;
          if (fileA !== fileB) return fileB - fileA;
        }
        var preferredA = option.variant && a.variant.id === option.variant.id ? 1 : 0;
        var preferredB = option.variant && b.variant.id === option.variant.id ? 1 : 0;
        return preferredB - preferredA || parseInt(b.replica.seeders || 0, 10) - parseInt(a.replica.seeders || 0, 10);
      });
      candidates = candidates.filter(function (candidate) {
        var hash = canonicalHash(candidate.replica.infohash);
        return !Object.keys(selection.failed_file_keys || {}).some(function (key) { return key.split(':')[0] === hash; });
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
        var movieResolved = preferResolvedFile({
          url: movieSources[0].url,
          sources: movieSources.map(function (item) { return item.url; }),
          source_records: movieSources,
          episodes: [],
          variant: movieSources[0].variant,
          requested_episode: 0
        }, selection.preferred_file_key);
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
        var requestedNumber = nextAfter ? episodeNumbers.filter(function (number) { return number > nextAfter; })[0] : episodeNumber;
        var requestedSources = uniqueSources((sourcesByEpisode[requestedNumber] || []).slice());
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
          if (number !== parseInt(requestedNumber, 10) && seasonReplica) {
            records.sort(function (a, b) {
              return (b.replica === seasonReplica ? 1 : 0) - (a.replica === seasonReplica ? 1 : 0) || b.seeders - a.seeders;
            });
          }
          copy.url = records[0] ? records[0].url : copy.url;
          copy.pidtor_source_urls = records.map(function (record) { return record.url; });
          copy.pidtor_source_records = records.map(function (record) {
            return { url: record.url, variant: fileVariant(record), replica: cloneMetadata(record.replica_data), file_metadata: record.file_metadata };
          });
          copy.pidtor_variant = copy.pidtor_source_records[0] ? copy.pidtor_source_records[0].variant : null;
          copy.pidtor_tracks_ready = copy.pidtor_source_records.some(function (record) {
            return !!confirmedProbeStreams(record.variant, sourceFile(record));
          });
          copy.pidtor_available_variant_ids = records.map(function (record) {
            return record.variant && record.variant.id;
          }).filter(function (id, index, all) { return id && all.indexOf(id) === index; });
          return copy;
        });
        var resolved = {
          url: requestedSources[0].url,
          sources: requestedSources.map(function (record) { return record.url; }),
          source_records: requestedSources.map(function (record) {
            return { url: record.url, variant: fileVariant(record), replica: cloneMetadata(record.replica_data), file_metadata: record.file_metadata };
          }),
          episodes: episodes,
          variant: fileVariant(requestedSources[0]),
          available_variant_ids: requestedSources.map(function (record) {
            return record.variant && record.variant.id;
          }).filter(function (id, index, all) { return id && all.indexOf(id) === index; }),
          requested_episode: parseInt(requestedNumber, 10),
          resolution_pending: false
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
          error(nextAfter ? 'Следующая серия в этом сезоне недоступна' : 'Не удалось открыть доступную копию');
        }
      }

      var nextCandidate = 0;
      var activeCandidates = 0;
      function pumpCandidates() {
        while (!settled && activeCandidates < 1 && nextCandidate < candidateStates.length) {
          var state = candidateStates[nextCandidate++];
          if (!state.done) startCandidate(state);
        }
      }
      function collectEpisodes(state, episodes) {
        var candidate = state.candidate, replica = candidate.replica;
        if (episodes.length) episodeLists.push({ episodes: episodes, variant: candidate.variant, seeders: replica.seeders, replica: replicaKey(replica) });
        episodes.forEach(function (item) {
          var number = parseInt(item.e || 0, 10);
          if (!number || !item.url) return;
          if (!sourcesByEpisode[number]) sourcesByEpisode[number] = [];
          var record = sourceRecordFromEpisode(item, candidate);
          sourcesByEpisode[number].push({ url: record.url, seeders: replica.seeders, variant: record.variant,
            file_metadata: record.file_metadata, replica: replicaKey(replica), replica_data: replica });
        });
        state.usable = episodes.some(function (item) {
          return !!item.url && (nextAfter ? parseInt(item.e || 0, 10) > nextAfter : parseInt(item.e || 0, 10) === parseInt(episodeNumber, 10));
        });
        state.done = true;
      }
      function startCandidate(state) {
        activeCandidates++;
        var candidate = state.candidate;
        var replica = candidate.replica;
        state.request = request(replica.episodes_url, function (json) {
          var episodes = parseEpisodes(json);
          collectEpisodes(state, episodes);
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
      candidateStates.forEach(function (state) {
        var known = (state.candidate.replica.file_bindings || []).filter(function (item) {
          return parseInt(item.s || resolveSeason, 10) === parseInt(resolveSeason, 10);
        });
        if (!known.length && cached) known = (cached.episodes || []).filter(function (item) {
          return (item.pidtor_source_records || []).some(function (record) {
            return record.replica && replicaKey(record.replica) === replicaKey(state.candidate.replica);
          });
        }).map(function (item) {
          var record = item.pidtor_source_records.filter(function (record) { return record.replica && replicaKey(record.replica) === replicaKey(state.candidate.replica); })[0];
          return Object.assign({}, item, { url: record.url, file_metadata: record.file_metadata });
        });
        if (known.length) collectEpisodes(state, known);
      });
      if (candidateStates.some(function (state) { return state.usable; })) tryComplete();
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
        var hint = Object.assign({}, choice.track);
        delete hint.stream_index; delete hint.id;
        return {
          key: option.key + '|' + field + '|' + choiceIdentity(choice),
          title: choice.title,
          track: hint,
          variant: choice.variant,
          order: choice.order,
          track_id: choice.track_id,
          resolve: function (complete, error) {
            resolveOption({ key: option.key + '|' + choice.variant.id, variant: choice.variant, variants: [choice.variant] }, episodeNumber, function (resolved) {
              hydrateResolved(resolved, function (ready) {
                var actual = preferredChoice(resolvedTrackChoices(option, ready, field).filter(function (candidate) {
                  return candidate.variant && Array.isArray(candidate.variant.ffprobe);
                }), choice, field === 'audio');
                if (!actual) return error('Дорожка недоступна');
                complete(resolvedWithChoice(ready, actual, field));
              }, null, null, false);
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
          resolve: function (complete, error, deadline, automatic) {
            var resolvingOption = automatic ? automaticQualityOption(option, automatic.maxRank) : option;
            if (!resolvingOption) return error('Совместимая копия недоступна');
            var delivered = false;
            function hydrate(resolved, ready) {
              resolved = preferResolvedFile(resolved, result.preferred_file_key);
              function receive(hydrated) {
                var usable = automatic ? automaticResolved(hydrated, automatic) : hydrated;
                if (!usable) {
                  if (!delivered && !hydrated.probe_pending && !hydrated.resolution_pending) {
                    var file = sourceFile({ url: hydrated.url, variant: hydrated.variant });
                    if (file && !failed[file.key] && Date.now() < (deadline || Date.now() + 90000)) {
                      failed[file.key] = true;
                      return attempt();
                    }
                    delivered = true; error('Совместимая копия недоступна');
                  }
                  return;
                }
                publishOptionTracks(result, option, usable);
                if (!delivered) {
                  delivered = true;
                  complete(Object.assign({}, usable, { url: account(usable.url), sources: (usable.sources || [usable.url]).map(account) }));
                }
              }
              hydrateResolved(resolved, receive, receive, deadline, true);
            }
            var failed = Object.assign({}, result.failed_files || {});
            deadline = deadline || Date.now() + 90000;
            function attempt() {
              resolveOption(resolvingOption, episodeNumber, function (resolved) { hydrate(resolved, true); }, error,
                function (resolved) { hydrate(resolved, false); }, { preferred_file_key: result.preferred_file_key, failed_file_keys: failed, next_after: result.next_after });
            }
            attempt();
          }
        };
        result.catalogue_audio_options = trackResolvers(option, episodeNumber, 'audio');
        result.catalogue_subtitle_options = trackResolvers(option, episodeNumber, 'subtitles');
        result.audio_options = (option === selected && knownResolved && knownResolved.tracks_ready
          ? resolvedTrackChoices(option, knownResolved, 'audio') : []).concat(result.catalogue_audio_options);
        result.subtitle_options = (option === selected && knownResolved && knownResolved.tracks_ready
          ? resolvedTrackChoices(option, knownResolved, 'subtitles') : []).concat(result.catalogue_subtitle_options);
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
        preferences.pidtor_audio_choice || null,
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
        preferences.pidtor_subtitle_choice || null,
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
        timeline: timeline(object.movie, seasonNumber, episodeNumber, preferences),
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
        pidtor_manual_quality: preferences.pidtor_manual_quality === true || !!(preferences.pidtor_quality_key && qualityRank(selected.variant) > 1080),
        pidtor_audio_key: initialAudio ? initialAudio.key : '',
        pidtor_audio_choice: semanticChoice(initialAudio || preferences.pidtor_audio_choice),
        pidtor_pending_audio_choice: initialAudio ? null : semanticChoice(preferences.pidtor_audio_choice),
        pidtor_audio_stream_index: useGst === true ? gstAudioIndex : ffprobeAudioIndex,
        pidtor_audio_ffprobe_index: ffprobeAudioIndex,
        pidtor_subtitle_key: initialSubtitle ? initialSubtitle.key : '',
        pidtor_subtitle_choice: semanticChoice(initialSubtitle || preferences.pidtor_subtitle_choice),
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
      var keys = ['title', 'url', 'url_orig', 'img', 'image', 'poster', 'thumbnail', 'still_path', 'season', 'episode', 'timeline', 'quality', 'playlist_index', 'start_index', 'file_index', 'pidtor_nextgen', 'pidtor_playlist_session', 'pidtor_manifest_schema', 'pidtor_manifest_url', 'pidtor_use_gst', 'pidtor_native_playable', 'pidtor_media_name', 'pidtor_gst_bypass', 'pidtor_tracks_ready', 'pidtor_source_url', 'pidtor_source_urls', 'pidtor_source_records', 'pidtor_available_variant_ids', 'pidtor_quality_key', 'pidtor_manual_quality', 'pidtor_audio_key', 'pidtor_subtitle_key', 'pidtor_audio_choice', 'pidtor_subtitle_choice', 'pidtor_pending_audio_choice', 'pidtor_pending_subtitle_choice', 'pidtor_audio_stream_index', 'pidtor_audio_ffprobe_index', 'hls_manifest_timeout', 'ffprobe', 'torrent_hash', 'card', 'movie', 'isonline'];
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
      // Asked for before the first torrent is touched: the resolve below can take seconds, and the
      // quality lists that used to be the last thing requested were exactly what the viewer waited
      // for while the player stayed closed.
      prefetchExternalQualityLists(data);
      preferences = preferences || {};
      var selected = options.filter(function (option) {
        return preferences.pidtor_quality_key && option.key === preferences.pidtor_quality_key;
      })[0] || defaultQuality(options);
      if (!selected) {
        Lampa.Noty.show('Подходящих вариантов не найдено');
        return;
      }

      var episodeNumber = parseInt(meta.number, 10);
      // Тёплый запрос на выбранную серию уходит сразу: пока идёт резолв, TorrServer уже тянет
      // начало файла и последние мегабайты - окно наполнения открывается на тёплом торренте.
      try { warmChosenEpisode(selected, episodeNumber, preferences); } catch (e) {}
      var maxAutomaticRank = qualityRank(selected.variant);
      var ordered = [selected].concat(options.filter(function (option) {
        return option !== selected && automaticQualityOption(option, maxAutomaticRank);
      }));
      var attempted = {};
      var failedFiles = {};
      var probeDeadline = Date.now() + 90000;

      function advanceCompletedSeason() {
        if (!preferences.pidtor_resume_next) return false;
        var declared = (object.movie.seasons || []).concat(data.seasons || []);
        var current = declared.filter(function (item) {
          return Number(item.season_number || item.season || 0) === season;
        })[0];
        var count = Number(current && (current.episode_count || current.episodes) || 0);
        if (!count || episodeNumber < count) return false;
        var nextSeason = declared.map(function (item) {
          return Number(item.season_number || item.season || 0);
        }).filter(function (number) { return number > season; }).sort(function (a, b) { return a - b; })[0];
        if (!nextSeason && season < seasonCount) nextSeason = season + 1;
        if (!nextSeason) return false;
        var generation = ++playbackRequestGeneration;
        abortResolutionRequests();
        season = nextSeason;
        var nextPreferences = Object.assign({}, preferences, {
          pidtor_resume_next: false, season: nextSeason, episode: 1,
          time: 0, duration: 0, percent: 0, pidtor_audio_key: '', pidtor_subtitle_key: ''
        });
        loadV2(nextSeason, 1, function (nextData) {
          if (generation !== playbackRequestGeneration) return;
          launch(nextData, {s: nextSeason, e: 1, number: 1, name: '1 серия'}, nextPreferences, generation);
        }, function (message) {
          if (generation === playbackRequestGeneration) Lampa.Noty.show(message || 'Следующий сезон недоступен');
        });
        return true;
      }

      function nextAvailable(message) {
        if (requestGeneration !== playbackRequestGeneration) return;
        var next = ordered.filter(function (option) { return !attempted[option.key]; })[0];
        if (next) {
          startOption(next);
          return;
        }
        if (!advanceCompletedSeason()) Lampa.Noty.show(message || 'Нет доступного качества для этой серии');
      }

      function startOption(activeOption) {
        if (requestGeneration !== playbackRequestGeneration) return;
        attempted[activeOption.key] = true;

        // Manifest qualities are resolved only when selected, preserving the
        // complete menu without scanning other torrents during video startup.
        var verifiedOptions = options;
        var launchResolvers = optionResolvers(verifiedOptions, episodeNumber, activeOption);
        var selectedResolver = launchResolvers.filter(function (item) { return item.key === activeOption.key; })[0];
        if (preferences.pidtor_resume_next) selectedResolver.next_after = episodeNumber;
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
          if (preferences.pidtor_resume_next) {
            var nextNumber = Number(resolved.requested_episode || 0);
            if (nextNumber <= episodeNumber) return nextAvailable('Следующая серия в этом сезоне недоступна');
            episodeNumber = nextNumber;
            preferences = Object.assign({}, preferences, {pidtor_resume_next: false, season: season, episode: nextNumber, time: 0, duration: 0, percent: 0});
            meta = Object.assign({}, meta, {number: nextNumber, e: nextNumber, s: season});
          }
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
          // The external player's quality list is asked for now, while the stream is still being
          // warmed, so the hand-off later finds the episode lists already in flight or answered.
          prefetchExternalQuality(data, launchItem);
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
              var item = playerItem(episode, episode.url, options, option, episode.pidtor_source_urls, false, episode.pidtor_variant, preferences);
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

          var historyMarked = false;
          var startPlayer = function () {
            if (requestGeneration !== playbackRequestGeneration) return;
            var handOffStartedAt = Date.now();
            // Штатная Lampa пишет историю при старте воспроизведения; отдельный плеер PidTor
            // этого не делал - просмотренное не попадало ни в "Историю", ни в "Для вас".
            try {
              if (!historyMarked && object.movie && object.movie.id && Lampa.Favorite && typeof Lampa.Favorite.add === 'function') {
                historyMarked = true;
                Lampa.Favorite.add('history', object.movie, 100);
              }
            } catch (e) {}
            // Окно наполнения и предзагрузка TorrServer стартуют сразу по готовности потока: списки
            // качеств догружаются параллельно и больше не откладывают появление окна на полторы
            // секунды. Передача в плеер ждёт и буфер, и (если успели) списки качеств.
            var preload = externalPlayerTarget(launchItem) ? startBufferWindow(launchItem, launchItem.url) : null;
            attachExternalQuality(data, launchItem, function () {
              if (requestGeneration !== playbackRequestGeneration) return;
              popDirectResumeActivity();
              playWithQualityFallback(launchItem, playback, first, handOffStartedAt, playbackRequestedAt, preload);
              setTimeout(function () {
                if (!ownsPlayer(launchItem)) return;
                emitResumeState(launchItem);
              }, 0);
            });
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
        selectedResolver.resolve(receiveResolved, nextAvailable, probeDeadline,
          activeOption === selected && preferences.pidtor_quality_key ? null
            : { maxRank: maxAutomaticRank, confirmFile: activeOption !== selected });
      }

      startOption(selected);
    }

    function playEpisode(meta) {
      var requestGeneration = ++playbackRequestGeneration;
      playbackRequestedAt = Date.now();
      playbackStages = { at: playbackRequestedAt };
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
        // The season list is drawn seconds before anyone presses play, and these lists are the only
        // thing the hand-off ever waits for. Filled in the background, one request at a time and only
        // after the screen has settled: the press then finds them ready, and the server never sees a
        // burst of magnets for a season nobody has started yet.
        setTimeout(function () { prefetchExternalQualityLists(data); }, 1500);
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

    function markSeason(number, available) {
      var value = parseInt(number, 10);
      if (!(value > 0) || !isSerial(object.movie)) return;
      if (available === null) return;
      if (seasonAvailability[value] === available) return;
      seasonAvailability[value] = available;
      setFilter();
    }

    // В фильтре оставляем только те сезоны, для которых реально нашлись раздачи:
    // номер сезона в карточке Lampa берётся из TMDB (number_of_seasons), а на трекерах
    // их может быть куда меньше. Непроверенные сезоны показываем, пока идёт проверка.
    function setFilter() {
      var selected = ['Сезон: ' + season];
      var seasons = [];
      for (var i = 1; i <= seasonCount; i++) {
        if (isSerial(object.movie) && seasonAvailability[i] === false) continue;
        seasons.push({ title: 'Сезон ' + i, season: i, selected: i === season });
      }
      if (!seasons.length) seasons.push({ title: 'Сезон ' + season, season: season, selected: true });
      filter.set('filter', seasons);
      filter.chosen('filter', selected);
    }

    // Проверяем по очереди все сезоны из карточки и выкидываем пустые из фильтра.
    function probeSeasons() {
      if (!isSerial(object.movie) || seasonProbeBusy || seasonProbeStopped) return;
      var next = 0;
      seasonProbeBusy = true;
      function step() {
        if (seasonProbeStopped) { seasonProbeBusy = false; return; }
        next++;
        while (next <= seasonCount && seasonAvailability[next] !== undefined) next++;
        if (next > seasonCount) { seasonProbeBusy = false; return; }
        var probe = next;
        loadV2(probe, -1, function () { step(); }, function () { step(); });
      }
      step();
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
      probeSeasons();
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
      seasonProbeStopped = true;
      seasonProbeBusy = false;
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
    var historyMarked = false;
    preferences = preferences || object.pidtor_resume || {};
    network.timeout(45000);
    // Нажатие могло застать закэшированный ответ карточки (scheduleCardWarm): тогда тёплый запрос
    // уходит ещё до сети, иначе - сразу после ответа PidTor, до поиска и проверки файла. Так же,
    // как для серии, TorrServer качает фильм, пока клиент резолвит поток.
    try { warmMovieChoice(cachedApiResponse(endpoint), preferences); } catch (e) {}
    function launchResponse(response) {
      if (requestGeneration !== playbackRequestGeneration) return;
      var data = parseJson(response);
      if (!data) return launchError();
      if (data) cacheApiResponse(endpoint, data);
      try { warmMovieChoice(data, preferences); } catch (e) {}
      var options = qualityOptions(data);
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
          resolve: function (complete, error, deadline, automatic) {
            var resolvingOption = automatic ? automaticQualityOption(option, automatic.maxRank) : option;
            if (!resolvingOption) return error('Совместимая копия недоступна');
            var available = (resolvingOption.variants || [resolvingOption.variant]).reduce(function (all, variant) {
              return all.concat((variant.replicas || []).filter(function (replica) { return replica.stream_url; }).map(function (replica) {
                return { url: replica.stream_url, replica: replica, variant: variant };
              }));
            }, []).sort(function (a, b) { return parseInt(b.replica.seeders || 0, 10) - parseInt(a.replica.seeders || 0, 10); });
            var stream = available[0];
            if (!stream) return error('Качество недоступно');
            var delivered = false;
            var failed = Object.assign({}, result.failed_files || {});
            deadline = deadline || Date.now() + 90000;
            function receive(resolved) {
              var usable = automatic ? automaticResolved(resolved, automatic) : resolved;
              if (!usable) {
                if (!delivered && !resolved.probe_pending) {
                  var file = sourceFile({ url: resolved.url, variant: resolved.variant });
                  if (file) failed[file.key] = true;
                  if (Date.now() < deadline && startNext()) return;
                  delivered = true; error('Совместимая копия недоступна');
                }
                return;
              }
              publishOptionTracks(result, option, usable);
              if (!delivered) { delivered = true; complete(usable); }
            }
            function startNext() {
              var candidates = available.filter(function (record) { var file = sourceFile(record); return file && !failed[file.key]; });
              if (!candidates.length) return false;
              var selected = preferResolvedFile({ url: candidates[0].url, sources: candidates.map(function (entry) { return entry.url; }),
                source_records: candidates, episodes: [], variant: candidates[0].variant }, result.preferred_file_key);
              hydrateResolved(selected, receive, receive, deadline, true);
              return true;
            }
            if (!startNext()) error('Совместимая копия недоступна');
          }
        };
        return result;
      });
      var selectedResolver = qualityResolvers.filter(function (item) { return item.key === selected.key; })[0] || qualityResolvers[0];
      selectedResolver.preferred_file_key = resumeSourceKey(preferences.pidtor_audio_key || preferences.pidtor_subtitle_key);
      selectedResolver.resolve(function (resolved) {
      if (requestGeneration !== playbackRequestGeneration) return;
      var preferredFile = selectedResolver.preferred_file_key;
      var initialAudio = preferredStoredChoice(selectedResolver.audio_options.filter(function (choice) {
        return !preferredFile || preferredFile !== resolved.variant.source_file_key || sameVariantFile(choice.variant, resolved.variant);
      }), preferences.pidtor_audio_key || '', preferences.pidtor_audio_choice || null, true);
      resolved = resolvedWithChoice(resolved, initialAudio, 'audio');
      var activeVariant = resolved.variant;
      var activeSource = resolved.url;
      var activeSources = (resolved.source_records || []).filter(function (record) {
        return record.variant.source_file_key === activeVariant.source_file_key && record.variant.id === activeVariant.id;
      }).map(function (record) { return record.url; });
      var initialSubtitle = preferredStoredChoice(selectedResolver.subtitle_options.filter(function (choice) {
        return choice.variant.source_file_key === activeVariant.source_file_key;
      }), preferences.pidtor_subtitle_key || '', preferences.pidtor_subtitle_choice || null, false);
      var gst = useGstreamer(data);
      var gstAudioIndex = initialAudio ? parseInt(initialAudio.order || 0, 10) : 0;
      var ffprobeAudioIndex = initialAudio ? parseInt(initialAudio.track.stream_index, 10) : -1;
      var source = sourceForPlayback(activeSource, gst, gst ? gstAudioIndex : undefined);
      var item = {
        title: movie.title || movie.name || data.title || 'PidTor',
        url: account(source),
        url_orig: account(source),
        timeline: timeline(movie, 0, 0, preferences),
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
        pidtor_manual_quality: preferences.pidtor_manual_quality === true || !!(preferences.pidtor_quality_key && qualityRank(selected.variant) > 1080),
        pidtor_audio_key: initialAudio ? initialAudio.key : '',
        pidtor_audio_choice: semanticChoice(initialAudio || preferences.pidtor_audio_choice),
        pidtor_pending_audio_choice: initialAudio ? null : semanticChoice(preferences.pidtor_audio_choice),
        pidtor_audio_stream_index: gst ? gstAudioIndex : ffprobeAudioIndex,
        pidtor_audio_ffprobe_index: ffprobeAudioIndex,
        pidtor_subtitle_key: initialSubtitle ? initialSubtitle.key : '',
        pidtor_subtitle_choice: semanticChoice(initialSubtitle || preferences.pidtor_subtitle_choice),
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
      var play = function () {
        if (requestGeneration !== playbackRequestGeneration) return;
        // Штатная Lampa пишет историю при старте воспроизведения; свой плеер её не писал, поэтому
        // просмотренное через PidTor не появлялось в "Истории" и не участвовало в подборках.
        try {
          if (!historyMarked && movie && movie.id && Lampa.Favorite && typeof Lampa.Favorite.add === 'function') {
            historyMarked = true;
            Lampa.Favorite.add('history', movie, 100);
          }
        } catch (e) {}
        Lampa.Player.play(item);
        Lampa.Player.playlist([item]);
        setTimeout(function () { if (ownsPlayer(item)) emitResumeState(item); }, 0);
      };
      // Внешний плеер получает поток только после окна наполнения - как и у серий. Без этого на
      // телевизоре чёрный экран, пока TorrServer не отдаст первые мегабайты фильма.
      var bufferedMovie = externalPlayerTarget(item) ? startBufferWindow(item, item.url) : null;
      var start = function () {
        if (bufferedMovie) bufferedMovie.then(play);
        else play();
      };
      if (gst) ensureGst(function () {
        function startPrepared(json, candidate, orderedSources) {
          if (requestGeneration !== playbackRequestGeneration) return;
          if (!json) {
            launchError({ statusText: 'GStreamer не смог подготовить поток' });
            return;
          }
          item.pidtor_gst_warm = json;
          if (candidate) item.pidtor_source_url = candidate;
          if (orderedSources) item.pidtor_source_urls = orderedSources;
          item.url = json.hls + '?audio=' + parseInt(item.pidtor_audio_stream_index || 0, 10);
          item.url_orig = item.url;
          item.hls_type = 'hlsjs';
          delete item.torrent_hash;
          start();
        }
        var json = cachedGstWarm(item.pidtor_source_url, item.pidtor_audio_stream_index);
        if (json) startPrepared(json);
        else prepareGstReplica(
          [item.pidtor_source_url].concat(item.pidtor_source_urls || []),
          item.pidtor_audio_stream_index,
          item.timeline && item.timeline.time || 0,
          startPrepared
        );
      });
      else start();
      }, function (message) { if (requestGeneration === playbackRequestGeneration) Lampa.Noty.show(message || 'Не удалось открыть фильм'); }, null,
        preferences.pidtor_quality_key ? null : { maxRank: qualityRank(selected.variant) });
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
