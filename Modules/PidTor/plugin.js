(function () {
  'use strict';

  if (window.pidtor_nextgen_plugin) return;
  window.pidtor_nextgen_plugin = true;

  var API = '{localhost}';
  var TOKEN = '{token}';
  var PROBE_LIMIT = 80;
  var trackSelectionGeneration = 0;

  function account(url) {
    var email = Lampa.Storage.get('account_email', '');
    var uid = Lampa.Storage.get('lampac_unic_id', '');
    if (email && url.indexOf('account_email=') < 0) url = Lampa.Utils.addUrlComponent(url, 'account_email=' + encodeURIComponent(email));
    if (uid && url.indexOf('uid=') < 0) url = Lampa.Utils.addUrlComponent(url, 'uid=' + encodeURIComponent(uid));
    if (TOKEN && url.indexOf('token=') < 0) url = Lampa.Utils.addUrlComponent(url, 'token=' + encodeURIComponent(TOKEN));
    return url;
  }

  function isSerial(movie) {
    return !!(movie && (movie.name || movie.number_of_seasons));
  }

  function streamsByType(streams, type) {
    return (streams || []).filter(function (item) { return item.codec_type === type; });
  }

  function streamHash(url) {
    return ((url || '').match(/\/s([a-z0-9]+)/i) || [])[1] || '';
  }

  function scheduleNativeTracks(data) {
    if (!data || !data.pidtor_nextgen || !Array.isArray(data.ffprobe)) return;

    var generation = ++trackSelectionGeneration;
    var attempts = 0;
    var audioStreams = streamsByType(data.ffprobe, 'audio');
    var subtitleStreams = streamsByType(data.ffprobe, 'subtitle');
    var audioIndex = audioStreams.findIndex(function (item) {
      return parseInt(item.index, 10) === parseInt(data.pidtor_audio_stream_index, 10);
    });
    var subtitleIndex = subtitleStreams.findIndex(function (item) {
      return parseInt(item.index, 10) === parseInt(data.pidtor_subtitle_stream_index, 10);
    });

    var timer = setInterval(function () {
      attempts++;
      if (generation !== trackSelectionGeneration || attempts > 120) {
        clearInterval(timer);
        return;
      }

      var video = Lampa.PlayerVideo && Lampa.PlayerVideo.video ? Lampa.PlayerVideo.video() : null;
      if (!video) return;

      var audioReady = audioIndex < 0;
      if (video.audioTracks && audioIndex >= 0 && video.audioTracks[audioIndex]) {
        for (var a = 0; a < video.audioTracks.length; a++) {
          video.audioTracks[a].enabled = a === audioIndex;
          video.audioTracks[a].selected = a === audioIndex;
        }
        audioReady = true;
      }

      var subtitleReady = subtitleIndex < 0;
      if (video.textTracks) {
        var offset = video.textTracks.length === subtitleStreams.length + 1 ? 1 : 0;
        for (var s = 0; s < video.textTracks.length; s++) {
          var selected = subtitleIndex >= 0 && s === subtitleIndex + offset;
          video.textTracks[s].mode = selected ? 'showing' : 'disabled';
          video.textTracks[s].selected = selected;
        }
        subtitleReady = subtitleIndex < 0 || !!video.textTracks[subtitleIndex + offset];
      }

      if (audioReady && subtitleReady) clearInterval(timer);
    }, 250);
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
    if (movie.keywords && movie.keywords.results && movie.keywords.results.some(function (i) { return i.name === 'anime'; })) values.push('anime=true');
    if (movie.genres) values.push('genres=' + encodeURIComponent(movie.genres.map(function (i) { return i.name || i; }).join(',')));
    return values.join('&');
  }

  function PidTorComponent(object) {
    var self = this;
    var network = new Lampa.Reguest();
    var scroll = new Lampa.Scroll({ mask: true, over: true });
    var html = $('<div class="pidtor-nextgen"></div>');
    var head = $('<div class="pidtor-nextgen__head"></div>');
    var body = $('<div class="pidtor-nextgen__body"></div>');
    var history = [];
    var last = null;
    var current = null;

    function request(url, complete, error) {
      network.clear();
      network.timeout(20000);
      network['native'](account(url), complete, error || function () { showEmpty('Источник временно недоступен'); });
    }

    function snapshot() {
      return { title: head.text(), content: body.children().detach(), last: last };
    }

    function restore(state) {
      body.empty().append(state.content);
      head.text(state.title);
      last = state.last;
      scroll.reset();
      Lampa.Controller.toggle('content');
    }

    function clear(title, keepHistory) {
      if (keepHistory && body.children().length) history.push(snapshot());
      body.empty();
      head.text(title || 'PidTor');
      last = null;
      scroll.reset();
    }

    function showEmpty(message) {
      clear('PidTor', false);
      var empty = new Lampa.Empty({ title: 'PidTor', descr: message || 'Ничего не найдено' });
      body.append(empty.render());
      self.activity.loader(false);
      self.activity.toggle();
    }

    function appendOption(title, details, action, badge) {
      var item = $(
        '<div class="pidtor-nextgen__item selector">' +
          '<div class="pidtor-nextgen__item-main"><div class="pidtor-nextgen__item-title"></div><div class="pidtor-nextgen__item-details"></div></div>' +
          '<div class="pidtor-nextgen__item-badge"></div>' +
        '</div>'
      );
      item.find('.pidtor-nextgen__item-title').text(title || 'Без названия');
      item.find('.pidtor-nextgen__item-details').text(details || '');
      item.find('.pidtor-nextgen__item-badge').text(badge || '');
      item.on('hover:focus', function () {
        last = item[0];
        scroll.update(item, true);
      });
      item.on('hover:enter', action);
      body.append(item);
      return item;
    }

    function showSeasons() {
      clear('Сезоны', true);
      var count = Math.max(1, parseInt(object.movie.number_of_seasons || 1, 10));
      for (var season = 1; season <= count; season++) {
        (function (number) {
          appendOption(number + ' сезон', '', function () { loadSeason(number); }, 'S' + number);
        })(season);
      }
      self.activity.loader(false);
      self.activity.toggle();
    }

    function loadV2(season, episode, complete) {
      self.activity.loader(true);
      request(API + '/lite/pidtor/v2?' + query(object.movie, season, episode), function (data) {
        self.activity.loader(false);
        if (!data || !Array.isArray(data.variants) || !data.variants.length) return showEmpty('Подходящих вариантов не найдено');
        complete(data);
      });
    }

    function loadSeason(season) {
      loadV2(season, -1, function (data) {
        var first = data.variants[0];
        var replica = first && first.replicas && first.replicas[0];
        if (!replica || !replica.episodes_url) return showEmpty('В раздаче не найдены серии');
        request(replica.episodes_url, function (episodes) {
          var list = episodes && episodes.data;
          if (!Array.isArray(list) || !list.length) return showEmpty('В раздаче не найдены серии');
          showEpisodes(season, data, list);
        });
      });
    }

    function showEpisodes(season, data, episodes) {
      clear(season + ' сезон', true);
      episodes.forEach(function (episode) {
        var number = parseInt(episode.e || 0, 10);
        appendOption(episode.name || ('Серия ' + number), 'Серия ' + number, function () {
          showVariants(data, { season: season, episode: number, source: episode });
        }, 'E' + number);
      });
      Lampa.Controller.toggle('content');
    }

    function variantLabel(variant) {
      var video = variant.video || {};
      var parts = [video.quality || 'SD'];
      if (video.source) parts.push(video.source);
      if (video.hdr && video.hdr !== 'sdr') parts.push(video.hdr.replace('dolby_vision', 'Dolby Vision').replace('hdr10_plus', 'HDR10+').toUpperCase());
      if (video.codec) parts.push(video.codec.toUpperCase());
      if (video.bit_depth > 8) parts.push(video.bit_depth + '-bit');
      return parts.join(' ');
    }

    function showVariants(data, episode) {
      clear(episode ? 'Качество · серия ' + episode.episode : 'Качество', true);
      data.variants.forEach(function (variant) {
        var replica = variant.replicas && variant.replicas[0];
        var details = [];
        if (variant.video && variant.video.width) details.push(variant.video.width + 'x' + variant.video.height);
        if (variant.video && variant.video.bitrate) details.push((variant.video.bitrate / 1000000).toFixed(1) + ' Мбит/с');
        if (variant.audio && variant.audio.length) details.push(variant.audio.length + ' аудио');
        if (variant.subtitles && variant.subtitles.length) details.push(variant.subtitles.length + ' субтитров');
        appendOption(variantLabel(variant), details.join(' · '), function () {
          resolveVariant(variant, episode);
        }, replica ? replica.seeders + ' сид' : '');
      });
      Lampa.Controller.toggle('content');
    }

    function resolveVariant(variant, episode) {
      var replicas = variant.replicas || [];

      function attempt(index) {
        var replica = replicas[index];
        if (!replica) return showEmpty('Не удалось открыть ни одну доступную копию');
        var failed = function () { attempt(index + 1); };

        if (!episode) return prepareTracks(variant, replica.stream_url, null, null, failed);
        request(replica.episodes_url, function (json) {
          var episodes = json && json.data;
          if (!Array.isArray(episodes)) return failed();
          var selected = episodes.filter(function (i) { return parseInt(i.e || 0, 10) === episode.episode; })[0];
          if (!selected) return failed();
          prepareTracks(variant, selected.url, episode, episodes, failed);
        }, failed);
      }

      attempt(0);
    }

    function probeKey(url) {
      var hash = (url.match(/\/s([a-z0-9]+)/i) || [])[1] || '';
      var index = (url.match(/[?&]tsid=(\d+)/i) || [])[1] || '1';
      return hash + ':' + index;
    }

    function probeCacheGet(key) {
      var cache = Lampa.Storage.get('pidtor_probe_v2', {});
      return cache[key] && cache[key].streams;
    }

    function probeCacheSet(key, streams) {
      var cache = Lampa.Storage.get('pidtor_probe_v2', {});
      cache[key] = { time: Date.now(), streams: streams };
      var keys = Object.keys(cache).sort(function (a, b) { return cache[b].time - cache[a].time; });
      keys.slice(PROBE_LIMIT).forEach(function (item) { delete cache[item]; });
      Lampa.Storage.set('pidtor_probe_v2', cache);
    }

    function variantStreams(variant) {
      var streams = [];
      if (variant.video) streams.push({ index: variant.video.stream_index, codec_type: 'video', codec_name: variant.video.codec, width: variant.video.width, height: variant.video.height });
      (variant.audio || []).forEach(function (i) { streams.push({ index: i.stream_index, codec_type: 'audio', codec_name: i.codec, channels: i.channels, bit_rate: i.bitrate + '', tags: { language: i.language, title: i.title } }); });
      (variant.subtitles || []).forEach(function (i) { streams.push({ index: i.stream_index, codec_type: 'subtitle', codec_name: i.codec, tags: { language: i.language, title: i.title } }); });
      return streams;
    }

    function prepareTracks(variant, url, episode, playlist, failed) {
      if (!url) return failed ? failed() : showEmpty('Поток недоступен');
      var key = probeKey(url);
      var cached = probeCacheGet(key);
      if (cached) return showAudio(variant, url, episode, playlist, cached);
      if (!variant.probe_required) return showAudio(variant, url, episode, playlist, variantStreams(variant));
      self.activity.loader(true);
      request(API + '/ffprobe?media=' + encodeURIComponent(account(url)), function (probe) {
        self.activity.loader(false);
        var streams = probe && probe.streams;
        if (!Array.isArray(streams) || !streams.some(function (item) { return item.codec_type === 'video' && !(item.disposition && item.disposition.attached_pic); })) {
          return failed ? failed() : showEmpty('Не удалось прочитать медиадорожки');
        }
        probeCacheSet(key, streams);
        showAudio(variant, url, episode, playlist, streams);
      }, function () {
        self.activity.loader(false);
        if (failed) failed();
        else showEmpty('Не удалось прочитать медиадорожки');
      });
    }

    function streamName(stream) {
      var tags = stream.tags || {};
      var title = tags.title || tags.handler_name || tags.language || 'Неизвестно';
      var details = [String(stream.codec_name || '').toUpperCase()];
      if (stream.channels) details.push(stream.channels + ' ch');
      return { title: title, details: details.join(' · ') };
    }

    function showAudio(variant, url, episode, playlist, streams) {
      var audio = streamsByType(streams, 'audio');
      if (audio.length <= 1) return showSubtitles(variant, url, episode, playlist, streams, audio[0] || null);
      clear('Аудиодорожка', true);
      audio.forEach(function (track) {
        var name = streamName(track);
        appendOption(name.title, name.details, function () {
          showSubtitles(variant, url, episode, playlist, streams, track);
        }, track.tags && track.tags.language || '');
      });
      Lampa.Controller.toggle('content');
    }

    function showSubtitles(variant, url, episode, playlist, streams, audio) {
      var subtitles = streamsByType(streams, 'subtitle');
      if (!subtitles.length) return play(variant, url, episode, playlist, streams, audio, null);
      clear('Субтитры', true);
      appendOption('Без субтитров', '', function () { play(variant, url, episode, playlist, streams, audio, null); }, 'OFF');
      subtitles.forEach(function (track) {
        var name = streamName(track);
        appendOption(name.title, name.details, function () { play(variant, url, episode, playlist, streams, audio, track); }, track.tags && track.tags.language || '');
      });
      Lampa.Controller.toggle('content');
    }

    function withAudio(url, audio, streams) {
      var index = audio ? parseInt(audio.index, 10) : -1;
      return index >= 0 ? Lampa.Utils.addUrlComponent(url, 'audio=' + index) : url;
    }

    function play(variant, url, episode, playlist, streams, audio, subtitle) {
      var selectedUrl = account(withAudio(url, audio, streams));
      var title = episode && episode.source ? episode.source.title || episode.source.name : object.movie.title || object.movie.name;
      var first = {
        title: title,
        url: selectedUrl,
        season: episode ? episode.season : 0,
        episode: episode ? episode.episode : 0,
        voice_name: audio ? streamName(audio).title : '',
        ffprobe: streams,
        torrent_hash: streamHash(url),
        pidtor_nextgen: true,
        pidtor_audio_stream_index: audio ? parseInt(audio.index, 10) : -1,
        pidtor_subtitle_stream_index: subtitle ? parseInt(subtitle.index, 10) : -1,
        card: object.movie,
        movie: object.movie,
        isonline: true
      };
      var playback = [first];
      if (episode && Array.isArray(playlist)) {
        playback = playlist.map(function (item) {
          var itemUrl = account(withAudio(item.url, audio, streams));
          return {
            title: item.title || item.name,
            url: itemUrl,
            season: parseInt(item.s || episode.season, 10),
            episode: parseInt(item.e || 0, 10),
            voice_name: first.voice_name,
            ffprobe: streams,
            torrent_hash: streamHash(itemUrl),
            pidtor_nextgen: true,
            pidtor_audio_stream_index: first.pidtor_audio_stream_index,
            pidtor_subtitle_stream_index: first.pidtor_subtitle_stream_index,
            card: object.movie,
            movie: object.movie,
            isonline: true
          };
        });
        first = playback.filter(function (i) { return i.episode === episode.episode; })[0] || first;
      }
      if (playback.length > 1) first.playlist = playback;
      Lampa.Player.play(first);
      Lampa.Player.playlist(playback);
    }

    this.create = function () {
      Lampa.Background.immediately('');
      html.append(head).append(scroll.render());
      scroll.append(body);
      scroll.minus(head);
      if (isSerial(object.movie)) showSeasons();
      else loadV2(-1, -1, function (data) { showVariants(data, null); });
      return this.render();
    };

    this.start = function () {
      Lampa.Controller.add('content', {
        toggle: function () {
          Lampa.Controller.collectionSet(scroll.render());
          Lampa.Controller.collectionFocus(last || body.find('.selector')[0] || false, scroll.render());
        },
        left: function () { if (Navigator.canmove('left')) Navigator.move('left'); else Lampa.Controller.toggle('menu'); },
        right: function () { if (Navigator.canmove('right')) Navigator.move('right'); },
        up: function () { if (Navigator.canmove('up')) Navigator.move('up'); else Lampa.Controller.toggle('head'); },
        down: function () { if (Navigator.canmove('down')) Navigator.move('down'); },
        back: function () {
          if (history.length) restore(history.pop());
          else Lampa.Activity.backward();
        }
      });
      Lampa.Controller.toggle('content');
    };

    this.pause = function () {};
    this.stop = function () {};
    this.render = function () { return html; };
    this.destroy = function () { network.clear(); scroll.destroy(); html.remove(); };
  }

  function addButton(e) {
    if (!e || !e.render || !e.render.length || e.render.parent().find('.pidtor-nextgen--button').length) return;
    var button = $(
      '<div class="full-start__button selector view--online pidtor-nextgen--button" data-subtitle="PidTor NextGen">' +
        '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg><span>PidTor</span>' +
      '</div>'
    );
    button.on('hover:enter', function () {
      Lampa.Activity.push({ title: 'PidTor', component: 'pidtor_nextgen', movie: e.movie, page: 1 });
    });
    e.render.after(button);
  }

  function startPlugin() {
    Lampa.Template.add('pidtor_nextgen_css', '<style>.pidtor-nextgen__head{padding:1.2em 1.5em .7em;font-size:1.6em}.pidtor-nextgen__body{padding:0 1.5em 3em}.pidtor-nextgen__item{display:flex;align-items:center;gap:1em;min-height:5.4em;padding:.8em 1em;border-bottom:1px solid rgba(255,255,255,.12)}.pidtor-nextgen__item.focus{background:#fff;color:#111}.pidtor-nextgen__item-main{min-width:0;flex:1}.pidtor-nextgen__item-title{font-size:1.25em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pidtor-nextgen__item-details{margin-top:.35em;opacity:.68}.pidtor-nextgen__item-badge{font-size:.9em;opacity:.75;white-space:nowrap}.pidtor-nextgen--button svg{width:1.4em;height:1.4em}</style>');
    $('body').append(Lampa.Template.get('pidtor_nextgen_css', {}, true));
    Lampa.Component.add('pidtor_nextgen', PidTorComponent);
    Lampa.Player.listener.follow('start', scheduleNativeTracks);
    Lampa.Listener.follow('full', function (e) {
      if (e.type === 'complite') addButton({ render: e.object.activity.render().find('.view--torrent'), movie: e.data.movie });
    });
    try {
      var active = Lampa.Activity.active();
      if (active.component === 'full') addButton({ render: active.activity.render().find('.view--torrent'), movie: active.card });
    } catch (e) {}
  }

  if (window.appready) startPlugin();
  else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') startPlugin(); });
})();
