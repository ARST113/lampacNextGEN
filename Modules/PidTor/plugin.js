(function () {
  'use strict';

  if (window.pidtor_nextgen_plugin) return;
  window.pidtor_nextgen_plugin = true;

  var API = '{localhost}';
  var TOKEN = '{token}';
  var gstLoading = false;
  var gstWaiters = [];
  var playbackMonitor = null;
  var playerControlsGeneration = 0;

  function ensureGst(complete) {
    if (window.lampac_pidtor_gst_ready) {
      complete();
      return;
    }
    gstWaiters.push(complete);
    if (gstLoading) return;
    gstLoading = true;
    window.pidtor_nextgen_gst_only = true;
    Lampa.Utils.putScriptAsync([API + '/gst.js?pidtor_nextgen=1&v=20260813-15-seekwarm'], function () {
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
    var email = Lampa.Storage.get('account_email', '');
    var uid = Lampa.Storage.get('lampac_unic_id', '');
    if (email && url.indexOf('account_email=') < 0) url = Lampa.Utils.addUrlComponent(url, 'account_email=' + encodeURIComponent(email));
    if (uid && url.indexOf('uid=') < 0) url = Lampa.Utils.addUrlComponent(url, 'uid=' + encodeURIComponent(uid));
    if (TOKEN && url.indexOf('token=') < 0) url = Lampa.Utils.addUrlComponent(url, 'token=' + encodeURIComponent(TOKEN));
    return url;
  }

  function sourceWithAudio(source, streamIndex) {
    if (!source || !Number.isFinite(parseInt(streamIndex, 10))) return source;
    source = String(source)
      .replace(/([?&])audio=[^&#]*&?/gi, function (_, prefix) { return prefix === '?' ? '?' : ''; })
      .replace(/\?&/, '?')
      .replace(/[?&]$/, '');
    return Lampa.Utils.addUrlComponent(source, 'audio=' + parseInt(streamIndex, 10));
  }

  function sourceForPlayback(source, useGst, streamIndex) {
    var result = sourceWithAudio(source, streamIndex);
    if (!useGst && /\/lite\/pidtor\/s/i.test(result) && !/[?&]raw=/.test(result)) {
      result = Lampa.Utils.addUrlComponent(result, 'raw=true');
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

  function storageEnabled(name, fallback) {
    var value = Lampa.Storage.field(name);
    if (typeof value === 'undefined' || value === null || value === '') return fallback === true;
    return value === true || value === 1 || value === '1' || value === 'true';
  }

  function useGstreamer(data) {
    return !!(data && data.gst === true && storageEnabled('pidtor_gstreamer', true));
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
    if (movie.keywords && movie.keywords.results && movie.keywords.results.some(function (item) { return item.name === 'anime'; })) values.push('anime=true');
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
    (data.variants || []).forEach(function (variant) {
      var key = qualityName(variant);
      if (!grouped[key]) grouped[key] = { key: key, label: '', variant: null, variants: [] };
      grouped[key].variants.push(variant);
      if (!grouped[key].variant || seeders(variant) > seeders(grouped[key].variant)) {
        grouped[key].variant = variant;
        grouped[key].label = qualityLabel(variant);
      }
    });
    return Object.keys(grouped).map(function (key) {
      var option = grouped[key];
      var replicas = [];
      var seen = {};
      option.variants.forEach(function (variant) {
        (variant.replicas || []).forEach(function (replica) {
          var id = replicaKey(replica);
          if (!id || seen[id]) return;
          seen[id] = true;
          replicas.push(replica);
        });
      });
      replicas.sort(function (a, b) { return parseInt(b.seeders || 0, 10) - parseInt(a.seeders || 0, 10); });
      option.variants.sort(function (a, b) { return seeders(b) - seeders(a); });
      option.variant = Object.assign({}, option.variant, { replicas: replicas });
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
      return playbackPriority(b) - playbackPriority(a) || seeders(b) - seeders(a);
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
      if (/forced|форс/.test(probe)) return 'Forced';
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
      [/anilibria/, 'AniLibria'],
      [/anidub/, 'AniDub'],
      [/studio band|студийная банда|wakanim/, 'Студийная Банда'],
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
      if (/dub|дубляж|gy6l|gy6л/.test(probe)) return 'Дубляж';
      if (/mvo|многоголос/.test(probe)) return 'Многоголосая';
      if (/avo|vo|одноголос/.test(probe)) return 'Авторская';
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
        var key = normalized(title) + '|' + normalized(track.language);
        var choice = { title: title, track: track, variant: variant, order: index };
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
    return choice ? normalized(choice.title) + '|' + normalizedLanguage(choice.track && choice.track.language) : '';
  }

  function currentChoice(data, field) {
    var options = data['pidtor_' + field + '_options'] || [];
    var key = data['pidtor_' + field + '_key'];
    return options.filter(function (choice) { return choice.key === key; })[0] || null;
  }

  function preferredChoice(options, previous, audio) {
    options = options || [];
    if (!options.length) return null;
    if (previous) {
      var exact = options.filter(function (choice) { return choiceIdentity(choice) === choiceIdentity(previous); })[0];
      if (exact) return exact;
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

  function resolvedWithChoice(resolved, choice, field) {
    if (!choice) return resolved;
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

  function restorePosition(seconds, callback) {
    var restored = false;
    function restore() {
      if (restored) return;
      restored = true;
      Lampa.PlayerVideo.listener.remove('loadeddata', restore);
      if (seconds > 0) Lampa.PlayerVideo.to(seconds);
      if (callback) callback();
    }
    Lampa.PlayerVideo.listener.follow('loadeddata', restore);
    setTimeout(restore, 5000);
  }

  function selectNativeAudio(order) {
    var video = videoElement();
    if (!video || !video.audioTracks || !video.audioTracks[order]) return;
    for (var i = 0; i < video.audioTracks.length; i++) {
      video.audioTracks[i].enabled = i === order;
      video.audioTracks[i].selected = i === order;
    }
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
      var episode = byEpisode[parseInt(item.episode || 0, 10)];
      if (!episode || !episode.url) return;
      item.url = account(sourceForPlayback(episode.url, data.pidtor_use_gst === true, data.pidtor_audio_stream_index));
      item.url_orig = item.url;
      item.pidtor_source_url = item.url;
      item.pidtor_source_urls = (episode.pidtor_source_urls || [episode.url]).map(function (source) {
        return account(sourceForPlayback(source, data.pidtor_use_gst === true, data.pidtor_audio_stream_index));
      });
      item.pidtor_audio_key = data.pidtor_audio_key || '';
      item.pidtor_subtitle_key = data.pidtor_subtitle_key || '';
      item.pidtor_audio_stream_index = data.pidtor_audio_stream_index;
      item.pidtor_available_variant_ids = episode.pidtor_available_variant_ids || [];
    });
  }

  function replaceSource(data, resolved, variant, afterLoad) {
    var position = currentPosition();
    var selectedAudio = parseInt(data.pidtor_audio_stream_index, 10);
    var sourceAudio = (String(resolved.url || '').match(/[?&]audio=(\d+)/i) || [])[1];
    if (sourceAudio !== undefined) selectedAudio = parseInt(sourceAudio, 10);
    if (!Number.isFinite(selectedAudio) || selectedAudio < 0) selectedAudio = 0;
    data.pidtor_audio_stream_index = selectedAudio;
    var source = account(sourceForPlayback(resolved.url, data.pidtor_use_gst === true, selectedAudio));
    data.url = source;
    data.url_orig = source;
    data.pidtor_source_url = source;
    data.pidtor_source_urls = (resolved.sources || [source]).map(function (item) {
      return account(sourceForPlayback(item, data.pidtor_use_gst === true, selectedAudio));
    });
    data.pidtor_variant = variant;
    data.ffprobe = variantStreams(variant);
    data.torrent_hash = streamHash(source);
    updatePlaylistSources(data, resolved);
    Lampa.Player.loading(true);
    Lampa.PlayerVideo.destroy(true);
    restorePosition(position, function () {
      Lampa.Player.loading(false);
      if (afterLoad) afterLoad();
      installPlayerControls(data);
    });
    Lampa.PlayerVideo.url(source, true);
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
          if (!enabled) return;
          data.pidtor_audio_key = choice.key;
          data.pidtor_audio_stream_index = parseInt(choice.track.stream_index, 10);
          if (data.pidtor_variant && data.pidtor_variant.id === choice.variant.id) {
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
          if (mode !== 'showing') return;
          data.pidtor_subtitle_key = choice.key;
          if (data.pidtor_variant && data.pidtor_variant.id === choice.variant.id) {
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
          if (!enabled || option.key === data.pidtor_quality_key) return;
          var previousAudio = currentChoice(data, 'audio');
          var previousSubtitle = currentChoice(data, 'subtitle');
          option.resolve(function (resolved) {
            var activeIds = resolved.variant && resolved.variant.id ? [resolved.variant.id] : resolved.available_variant_ids;
            var audioOptions = availableChoices(option.audio_options, activeIds);
            var subtitleOptions = availableChoices(option.subtitle_options, activeIds);
            var targetAudio = preferredChoice(audioOptions, previousAudio, true);
            var targetSubtitle = preferredChoice(subtitleOptions, previousSubtitle, false);
            if (targetAudio && targetAudio.variant && resolved.variant && targetAudio.variant.id !== resolved.variant.id) {
              targetAudio.resolve(function (audioResolved) {
                applyResolved(resolvedWithChoice(audioResolved, targetAudio, 'audio'), audioOptions, subtitleOptions, targetAudio, targetSubtitle);
              }, function (message) { Lampa.Noty.show(message || 'Аудиодорожка недоступна'); });
              return;
            }
            applyResolved(resolvedWithChoice(resolved, targetAudio, 'audio'), audioOptions, subtitleOptions, targetAudio, targetSubtitle);
          }, function (message) { Lampa.Noty.show(message || 'Качество недоступно'); });

          function applyResolved(resolved, audioOptions, subtitleOptions, targetAudio, targetSubtitle) {
            data.pidtor_quality_key = option.key;
            data.pidtor_audio_options = audioOptions;
            data.pidtor_subtitle_options = subtitleOptions;
            data.pidtor_audio_key = targetAudio ? targetAudio.key : '';
            data.pidtor_subtitle_key = targetSubtitle ? targetSubtitle.key : '';
            data.pidtor_audio_stream_index = targetAudio ? parseInt(targetAudio.track.stream_index, 10) : 0;
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
    if (!data || !data.pidtor_nextgen) return;
    var qualities = buildQualityItems(data);
    if (qualities.length) {
      var current = data.pidtor_quality_key || qualities[0].title;
      Lampa.PlayerPanel.setLevels(qualities, current);
      $('.player-panel__quality').text(current);
    }
    var audio = buildAudioItems(data);
    if (audio.length) Lampa.PlayerPanel.setTracks(audio);
    var subtitles = buildSubtitleItems(data);
    if (subtitles.length) Lampa.PlayerPanel.setSubs(subtitles);
  }

  function stopPlaybackMonitor() {
    if (!playbackMonitor) return;
    clearInterval(playbackMonitor);
    playbackMonitor = null;
  }

  function startPlaybackMonitor(data) {
    stopPlaybackMonitor();
    if (!data || !data.pidtor_nextgen || data.pidtor_use_gst !== true) return;
    var lastPosition = -1;
    var lastAdvance = Date.now();
    var fallbackStarted = false;
    var hasAdvanced = false;

    playbackMonitor = setInterval(function () {
      var video = videoElement();
      if (!video || video.ended) return;
      var position = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      if (video.seeking || (video.paused && video.readyState >= 2)) {
        lastPosition = position;
        lastAdvance = Date.now();
        return;
      }
      if (position > lastPosition + 0.2) {
        lastPosition = position;
        lastAdvance = Date.now();
        hasAdvanced = true;
        return;
      }
      var stallTimeout = hasAdvanced ? 14000 : 30000;
      if (fallbackStarted || Date.now() - lastAdvance < stallTimeout) return;

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
    }, 2000);
  }

  function schedulePlayerControls(data) {
    if (!data || !data.pidtor_nextgen) return;
    startPlaybackMonitor(data);
    var generation = ++playerControlsGeneration;
    var attempts = 0;
    function apply() {
      if (generation !== playerControlsGeneration) return;
      attempts++;
      installPlayerControls(data);
      if (attempts < 40) setTimeout(apply, 500);
    }
    apply();
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
    var preparedReplicas = {};
    var episodeMetadata = {};
    var last = null;
    var season = 1;
    var seasonCount = Math.max(1, parseInt(object.movie.number_of_seasons || 1, 10));
    var seasonChoice = Lampa.Storage.get('pidtor_season_choice', '{}') || {};
    if (seasonChoice[object.movie.id]) season = Math.max(1, Math.min(seasonCount, parseInt(seasonChoice[object.movie.id], 10) || 1));

    function request(url, complete, error, timeout) {
      var network = new Lampa.Reguest();
      requests.push(network);
      network.timeout(timeout || 30000);
      network['native'](account(url), complete, error || function () {
        Lampa.Noty.show('PidTor временно недоступен');
      });
      return network;
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
        responseCache[key] = data;
        resolveWaiters(data);
      }, function () {
        resolveWaiters(null, 'PidTor временно недоступен');
      }, 45000);
    }

    function parseEpisodes(json) {
      return json && Array.isArray(json.data) ? json.data : [];
    }

    function requestText(url, complete, error, timeout) {
      var network = new Lampa.Reguest();
      requests.push(network);
      network.timeout(timeout || 30000);
      network.silent(account(url), complete || function () {}, error || function () {}, false, { dataType: 'text' });
      return network;
    }

    function streamMode(url, mode) {
      return Lampa.Utils.addUrlComponent(url, mode + '=true');
    }

    function prepareSource(source, complete, error) {
      var match = String(source || '').match(/[?&]tsid=([^&]+)/);
      var key = streamHash(source) + '|' + (match ? match[1] : '1');
      if (preparedReplicas[key]) {
        complete(source);
        return;
      }
      requestText(streamMode(source, 'preload'), function () {
        preparedReplicas[key] = true;
        complete(source);
      }, error, 35000);
    }

    function prepareResolved(resolved, complete, error) {
      var sources = (resolved.sources || [resolved.url]).slice(0, 4);
      var index = 0;
      function next() {
        if (index >= sources.length) {
          error('Не удалось подготовить доступную копию');
          return;
        }
        var source = sources[index++];
        prepareSource(source, function () {
          var ordered = [source].concat((resolved.sources || []).filter(function (item) { return item !== source; }));
          resolved.url = source;
          resolved.sources = ordered;
          (resolved.episodes || []).forEach(function (episode) {
            if (parseInt(episode.e || 0, 10) === parseInt(resolved.requested_episode || 0, 10)) {
              episode.url = source;
              episode.pidtor_source_urls = ordered.slice();
            }
          });
          complete(resolved);
        }, next);
      }
      next();
    }

    function resolveOption(option, episodeNumber, complete, error) {
      var cacheKey = season + '|' + option.key;
      var cached = resolutionCache[cacheKey];

      function forEpisode(resolved) {
        if (!isSerial(object.movie)) return resolved;
        var selected = (resolved.episodes || []).filter(function (item) {
          return parseInt(item.e || 0, 10) === parseInt(episodeNumber, 10);
        })[0];
        if (!selected) return null;
        return {
          url: selected.url,
          sources: selected.pidtor_source_urls || [selected.url],
          episodes: resolved.episodes,
          variant: selected.pidtor_variant || resolved.variant,
          available_variant_ids: selected.pidtor_available_variant_ids || [],
          requested_episode: parseInt(episodeNumber, 10)
        };
      }

      if (cached) {
        var cachedEpisode = forEpisode(cached);
        if (cachedEpisode) complete(cachedEpisode);
        else error('Серия недоступна в этом качестве');
        return;
      }

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
      candidates = candidates.slice(0, 8);

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
          return { url: candidate.replica.stream_url, seeders: candidate.replica.seeders, variant: candidate.variant };
        }));
        if (!movieSources.length) {
          error('Не удалось открыть доступную копию');
          return;
        }
        var movieResolved = {
          url: movieSources[0].url,
          sources: movieSources.map(function (item) { return item.url; }),
          episodes: [],
          variant: movieSources[0].variant,
          requested_episode: 0
        };
        resolutionCache[cacheKey] = movieResolved;
        complete(movieResolved);
        return;
      }

      var candidateStates = candidates.filter(function (candidate) { return !!candidate.replica.episodes_url; }).map(function (candidate) {
        return { candidate: candidate, done: false, usable: false };
      });
      var episodeLists = [];
      var sourcesByEpisode = {};
      var settled = false;
      if (!candidateStates.length) {
        error('Не удалось открыть доступную копию');
        return;
      }

      function completeResolved() {
        if (settled) return;
        var requestedSources = uniqueSources((sourcesByEpisode[episodeNumber] || []).slice());
        if (!requestedSources.length) {
          if (candidateStates.some(function (state) { return !state.done; })) return;
          error('Не удалось открыть доступную копию');
          return;
        }

        var episodeNumbers = Object.keys(sourcesByEpisode).map(function (number) {
          return parseInt(number, 10);
        }).filter(function (number) { return number > 0; }).sort(function (a, b) { return a - b; });
        var metadataByEpisode = {};
        episodeLists.sort(function (a, b) {
          return b.episodes.length - a.episodes.length || b.seeders - a.seeders;
        });
        var seasonReplica = episodeLists[0] ? episodeLists[0].replica : '';
        episodeLists.forEach(function (list) {
          list.episodes.forEach(function (item) {
            var number = parseInt(item.e || 0, 10);
            if (number && !metadataByEpisode[number]) metadataByEpisode[number] = item;
          });
        });
        var episodes = episodeNumbers.map(function (number) {
          var item = metadataByEpisode[number] || { e: number, s: season, title: 'Серия ' + number };
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
          copy.pidtor_variant = records[0] ? records[0].variant : null;
          copy.pidtor_available_variant_ids = records.map(function (record) {
            return record.variant && record.variant.id;
          }).filter(function (id, index, all) { return id && all.indexOf(id) === index; });
          return copy;
        });
        var resolved = {
          url: requestedSources[0].url,
          sources: requestedSources.map(function (record) { return record.url; }),
          episodes: episodes,
          variant: requestedSources[0].variant,
          available_variant_ids: requestedSources.map(function (record) {
            return record.variant && record.variant.id;
          }).filter(function (id, index, all) { return id && all.indexOf(id) === index; }),
          requested_episode: parseInt(episodeNumber, 10)
        };
        resolutionCache[cacheKey] = resolved;
        settled = true;
        candidateStates.forEach(function (state) {
          if (state.request && !state.done) {
            try { state.request.clear(); } catch (e) {}
          }
        });
        complete(forEpisode(resolved));
      }

      function tryComplete() {
        if (settled) return;
        var preferred = candidateStates[0];
        if (preferred && !preferred.done) return;
        if (preferred && preferred.usable) {
          completeResolved();
          return;
        }
        if (candidateStates.some(function (state) { return state.usable; })) {
          completeResolved();
          return;
        }
        if (candidateStates.some(function (state) { return !state.done; })) return;
        if (candidateStates.some(function (state) { return state.usable; })) completeResolved();
        else error('Не удалось открыть доступную копию');
      }

      candidateStates.forEach(function (state) {
        var candidate = state.candidate;
        var replica = candidate.replica;
        state.request = request(replica.episodes_url, function (json) {
          var episodes = parseEpisodes(json);
          if (episodes.length) episodeLists.push({ episodes: episodes, variant: candidate.variant, seeders: replica.seeders, replica: replicaKey(replica) });
          episodes.forEach(function (item) {
            var number = parseInt(item.e || 0, 10);
            if (!number || !item.url) return;
            if (!sourcesByEpisode[number]) sourcesByEpisode[number] = [];
            sourcesByEpisode[number].push({ url: item.url, seeders: replica.seeders, variant: candidate.variant, replica: replicaKey(replica) });
          });
          state.usable = episodes.some(function (item) {
            return parseInt(item.e || 0, 10) === parseInt(episodeNumber, 10) && !!item.url;
          });
          state.done = true;
          tryComplete();
        }, function () {
          state.done = true;
          tryComplete();
        }, 8000);
        resolutionRequests.push(state.request);
      });
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
          key: option.key + '|' + field + '|' + normalized(choice.title) + '|' + normalized(choice.track.language),
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

    function optionResolvers(options, episodeNumber, selected, selectedVariantIds) {
      return options.map(function (option) {
        var result = {
          key: option.key,
          label: option.label,
          selected: option === selected,
          variant: option.variant,
          resolve: function (complete, error) {
            resolveOption(option, episodeNumber, function (resolved) {
              complete({
                url: account(resolved.url),
                sources: (resolved.sources || [resolved.url]).map(account),
                episodes: resolved.episodes || [],
                variant: resolved.variant || option.variant,
                available_variant_ids: resolved.available_variant_ids || []
              });
            }, error);
          }
        };
        var allowed = option === selected ? selectedVariantIds : null;
        result.audio_options = trackResolvers(option, episodeNumber, 'audio', allowed);
        result.subtitle_options = trackResolvers(option, episodeNumber, 'subtitles', allowed);
        return result;
      });
    }

    function playerItem(meta, url, options, selected, sources, useGst, activeVariant) {
      var episodeNumber = parseInt(meta.e || meta.episode_number || meta.number || 0, 10);
      var seasonNumber = parseInt(meta.s || meta.season_number || season || 0, 10);
      var knownEpisode = episodeMetadata[seasonNumber + '|' + episodeNumber] || {};
      var manifestUrl = account(API + '/lite/pidtor/v2?' + query(object.movie, seasonNumber, episodeNumber));
      var qualityResolvers = optionResolvers(options, episodeNumber, selected, meta.pidtor_available_variant_ids);
      var selectedResolver = qualityResolvers.filter(function (item) { return item.key === selected.key; })[0] || qualityResolvers[0];
      var variant = activeVariant || meta.pidtor_variant || selected.variant;
      var initialAudio = preferredChoice(selectedResolver ? selectedResolver.audio_options : [], null, true);
      var item = {
        title: knownEpisode.title || knownEpisode.name || meta.title || meta.name || ('Серия ' + episodeNumber),
        url: account(sourceForPlayback(url, useGst === true, initialAudio && initialAudio.track.stream_index)),
        url_orig: account(sourceForPlayback(url, useGst === true, initialAudio && initialAudio.track.stream_index)),
        season: seasonNumber,
        episode: episodeNumber,
        timeline: timeline(object.movie, seasonNumber, episodeNumber),
        pidtor_nextgen: true,
        pidtor_manifest_schema: 1,
        pidtor_manifest_url: manifestUrl,
        pidtor_use_gst: useGst === true,
        pidtor_source_url: account(sourceForPlayback(url, useGst === true, initialAudio && initialAudio.track.stream_index)),
        pidtor_source_urls: (sources || meta.pidtor_source_urls || [url]).map(function (source) {
          return account(sourceForPlayback(source, useGst === true, initialAudio && initialAudio.track.stream_index));
        }),
        pidtor_available_variant_ids: meta.pidtor_available_variant_ids || [],
        pidtor_quality_key: selected.key,
        pidtor_audio_key: initialAudio ? initialAudio.key : '',
        pidtor_audio_stream_index: initialAudio ? parseInt(initialAudio.track.stream_index, 10) : 0,
        pidtor_subtitle_key: '',
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
      var keys = ['title', 'url', 'url_orig', 'season', 'episode', 'timeline', 'pidtor_nextgen', 'pidtor_manifest_schema', 'pidtor_manifest_url', 'pidtor_use_gst', 'pidtor_source_url', 'pidtor_source_urls', 'pidtor_available_variant_ids', 'pidtor_quality_key', 'pidtor_audio_key', 'pidtor_subtitle_key', 'pidtor_audio_stream_index', 'torrent_hash', 'card', 'movie', 'isonline'];
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

    function launch(data, meta) {
      var options = qualityOptions(data);
      var selected = defaultQuality(options);
      if (!selected) {
        Lampa.Noty.show('Подходящих вариантов не найдено');
        return;
      }

      Lampa.Loading.start(function () {}, 'Подготовка торрента...');
      var episodeNumber = parseInt(meta.number, 10);

      function startOption(activeOption, fallbackIndex) {
        var launchResolvers = optionResolvers(options, episodeNumber, activeOption);
        var selectedResolver = launchResolvers.filter(function (item) { return item.key === activeOption.key; })[0] || launchResolvers[0];
        var initialAudio = preferredChoice(selectedResolver ? selectedResolver.audio_options : [], null, true);
        var startResolver = initialAudio || selectedResolver;
        startResolver.resolve(function (resolved) {
        var activeIds = resolved.variant && resolved.variant.id ? [resolved.variant.id] : resolved.available_variant_ids;
        selectedResolver.audio_options = availableChoices(selectedResolver.audio_options, activeIds);
        selectedResolver.subtitle_options = availableChoices(selectedResolver.subtitle_options, activeIds);
        initialAudio = preferredChoice(selectedResolver.audio_options, initialAudio, true);
        var startResolved = function (prepared) {
          prepared = resolvedWithChoice(prepared, initialAudio, 'audio');
          Lampa.Loading.stop();
          var playback = [];
          var gst = useGstreamer(data);
          if (prepared.episodes.length) {
            playback = prepared.episodes.map(function (item) {
              return playerItem(item, item.url, options, activeOption, item.pidtor_source_urls, gst, item.pidtor_variant);
            });
          }
          var first = playback.filter(function (item) { return item.episode === episodeNumber; })[0]
            || playerItem(meta, prepared.url, options, activeOption, prepared.sources, gst, prepared.variant);
          var launchItem = runtimeCopy(first);
          if (playback.length > 1) launchItem.playlist = playback.map(transportCopy);
          var startPlayer = function () {
            Lampa.Player.play(launchItem);
            Lampa.Player.playlist(playback.length ? playback : [first]);
          };
          if (gst) ensureGst(startPlayer);
          else startPlayer();
        };
        startResolved(resolved);
      }, function (message) {
          var next = fallbackIndex + 1;
          if (next < options.length) startOption(options[next], next);
          else {
            Lampa.Loading.stop();
            Lampa.Noty.show(message || 'Не удалось подготовить торрент');
          }
      });
      }

      startOption(selected, options.indexOf(selected));
    }

    function playEpisode(meta) {
      self.activity.loader(true);
      loadV2(season, meta.number, function (data) {
        self.activity.loader(false);
        launch(data, meta);
      }, function (message) {
        self.activity.loader(false);
        Lampa.Noty.show(message);
      });
    }

    function tmdbEpisodes(complete) {
      Lampa.Api.seasons(object.movie, [season], function (result) {
        var info = result && result[season];
        complete(info && Array.isArray(info.episodes) ? info.episodes : []);
      });
    }

    function pidtorEpisodes(complete) {
      loadV2(season, -1, function (data) {
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
        var prepared = defaultQuality(qualityOptions(response));
        if (prepared) resolveOption(prepared, parseInt(episodes[0] && (episodes[0].episode_number || episodes[0].e) || 1, 10), function () {}, function () {});
      }, function () {});
    }

    function loadSeason() {
      self.activity.loader(true);
      tmdbEpisodes(function (tmdb) {
        if (tmdb.length) {
          draw(tmdb);
          self.activity.loader(false);
          return;
        }
        pidtorEpisodes(function (pidtor) {
          draw(pidtor);
          self.activity.loader(false);
        });
      });
    }

    function setSeason(number) {
      season = number;
      seasonChoice[object.movie.id] = season;
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
      if (isSerial(object.movie)) loadSeason();
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
      scroll.destroy();
      explorer.destroy();
    };
  }

  function addButton(data) {
    if (!data || !data.render || !data.render.length) return;
    var screen = data.render.closest('.full-start-new');
    var container = screen.find('.full-start-new__buttons').filter(function () {
      return $(this).width() > 0 && $(this).height() > 0;
    }).first();
    if (!container.length) {
      container = $('.full-start-new__buttons').filter(function () {
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
  }

  function launchMovieDirect(object) {
    var network = new Lampa.Reguest();
    var movie = object.movie;
    var endpoint = account(API + '/lite/pidtor/v2?' + query(movie, -1, -1));
    Lampa.Loading.start(function () { try { network.clear(); } catch (e) {} }, 'Подготовка фильма...');
    network.timeout(45000);
    network['native'](endpoint, function (response) {
      var data = typeof response === 'string' ? JSON.parse(response) : response;
      var options = qualityOptions(data);
      var selected = defaultQuality(options);
      if (!selected) {
        Lampa.Loading.stop();
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
        Lampa.Loading.stop();
        Lampa.Noty.show('Фильм недоступен');
        return;
      }
      var qualityResolvers = options.map(function (option) {
        var variants = option.variants || [option.variant];
        var audioOptions = mergedTrackChoices(option, 'audio').map(function (choice) {
          return {
            key: option.key + '|audio|' + choiceIdentity(choice),
            title: choice.title,
            track: choice.track,
            variant: choice.variant,
            order: choice.order,
            resolve: function (complete, error) {
              var available = (choice.variant.replicas || []).filter(function (replica) { return replica.stream_url; })
                .sort(function (a, b) { return parseInt(b.seeders || 0, 10) - parseInt(a.seeders || 0, 10); });
              var stream = available[0];
              if (!stream) return error('Дорожка недоступна');
              complete({
                url: account(sourceWithAudio(stream.stream_url, choice.track.stream_index)),
                sources: available.map(function (replica) {
                  return account(sourceWithAudio(replica.stream_url, choice.track.stream_index));
                }),
                episodes: [],
                variant: choice.variant
              });
            }
          };
        });
        var subtitleOptions = mergedTrackChoices(option, 'subtitles').map(function (choice) {
          return {
            key: option.key + '|subtitles|' + choiceIdentity(choice),
            title: choice.title,
            track: choice.track,
            variant: choice.variant,
            order: choice.order,
            resolve: function (complete, error) {
              var available = (choice.variant.replicas || []).filter(function (replica) { return replica.stream_url; })
                .sort(function (a, b) { return parseInt(b.seeders || 0, 10) - parseInt(a.seeders || 0, 10); });
              var stream = available[0];
              if (!stream) return error('Субтитры недоступны');
              complete({
                url: account(stream.stream_url),
                sources: available.map(function (replica) { return account(replica.stream_url); }),
                episodes: [],
                variant: choice.variant
              });
            }
          };
        });
        return {
          key: option.key,
          label: option.label,
          selected: option === selected,
          variant: option.variant,
          audio_options: audioOptions,
          subtitle_options: subtitleOptions,
          resolve: function (complete, error) {
            var available = variants.reduce(function (all, variant) {
              return all.concat((variant.replicas || []).filter(function (replica) { return replica.stream_url; }).map(function (replica) {
                return { replica: replica, variant: variant };
              }));
            }, []).sort(function (a, b) { return parseInt(b.replica.seeders || 0, 10) - parseInt(a.replica.seeders || 0, 10); });
            var stream = available[0];
            if (!stream) return error('Качество недоступно');
            complete({
              url: account(stream.replica.stream_url),
              sources: available.filter(function (entry) {
                return entry.variant.id === stream.variant.id;
              }).map(function (entry) { return account(entry.replica.stream_url); }),
              episodes: [],
              variant: stream.variant
            });
          }
        };
      });
      var selectedResolver = qualityResolvers.filter(function (item) { return item.key === selected.key; })[0] || qualityResolvers[0];
      var initialAudio = preferredChoice(selectedResolver.audio_options, null, true);
      var activeVariant = initialAudio && initialAudio.variant ? initialAudio.variant : selected.variant;
      var active = replicas.filter(function (entry) { return entry.variant.id === activeVariant.id; })[0] || replicas[0];
      var activeReplicas = replicas.filter(function (entry) { return entry.variant.id === active.variant.id; });
      var gst = useGstreamer(data);
      var source = sourceForPlayback(active.replica.stream_url, gst, initialAudio && initialAudio.track.stream_index);
      var item = {
        title: movie.title || movie.name || data.title || 'PidTor',
        url: account(source),
        url_orig: account(source),
        timeline: timeline(movie, 0, 0),
        pidtor_nextgen: true,
        pidtor_manifest_schema: 1,
        pidtor_manifest_url: endpoint,
        pidtor_use_gst: gst,
        pidtor_source_url: account(active.replica.stream_url),
        pidtor_source_urls: activeReplicas.map(function (entry) { return account(entry.replica.stream_url); }),
        pidtor_quality_key: selected.key,
        pidtor_audio_key: initialAudio ? initialAudio.key : '',
        pidtor_audio_stream_index: initialAudio ? parseInt(initialAudio.track.stream_index, 10) : 0,
        pidtor_subtitle_key: '',
        ffprobe: variantStreams(activeVariant),
        torrent_hash: streamHash(active.replica.stream_url),
        card: movie,
        movie: movie,
        isonline: true
      };
      Object.defineProperty(item, 'pidtor_quality_options', { value: qualityResolvers, writable: true, configurable: true, enumerable: true });
      Object.defineProperty(item, 'pidtor_audio_options', { value: selectedResolver.audio_options, writable: true, configurable: true, enumerable: true });
      Object.defineProperty(item, 'pidtor_subtitle_options', { value: selectedResolver.subtitle_options, writable: true, configurable: true, enumerable: true });
      Object.defineProperty(item, 'pidtor_variant', { value: activeVariant, writable: true, configurable: true, enumerable: true });
      var start = function () {
        Lampa.Loading.stop();
        Lampa.Player.play(item);
        Lampa.Player.playlist([item]);
      };
      if (gst) ensureGst(start);
      else start();
    }, function (error) {
      Lampa.Loading.stop();
      var message = error && (error.responseText || error.statusText);
      Lampa.Noty.show(message || 'Не удалось открыть фильм');
    }, false, { dataType: 'text' });
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
    registerSettings();
    Lampa.Player.listener.follow('start', schedulePlayerControls);
    Lampa.Player.listener.follow('destroy', function () {
      playerControlsGeneration++;
      stopPlaybackMonitor();
    });
    Lampa.Listener.follow('full', function (event) {
      if (event.type === 'complite') addButton({ render: event.object.activity.render().find('.view--torrent'), movie: event.data.movie });
    });
    try {
      var active = Lampa.Activity.active();
      if (active.component === 'full') addButton({ render: active.activity.render().find('.view--torrent'), movie: active.card });
    } catch (e) {}
  }

  if (window.appready) startPlugin();
  else Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') startPlugin(); });
})();
