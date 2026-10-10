/* Additional AC3 / EAC3 / DTS audio decoding for the ORIGINAL Lampa video player.
 * No replacement video element, no video remuxing and no external player UI.
 * The existing MPV2 plugin is deliberately left untouched.
 */
(function () {
  'use strict';
  if (window.__lampa_audio_wasm_bridge_v1) return;
  window.__lampa_audio_wasm_bridge_v1 = true;

  var VERSION = '20261010-android-10';
  var CODECS = { ac3: true, eac3: true, dts: true, dca: true };
  var session = null, sessionNumber = 0;

  function userAgent() {
    try { return String((typeof navigator !== 'undefined' && navigator.userAgent) || ''); } catch (_) { return ''; }
  }
  function storage(key, fallback) {
    try { return Lampa.Storage.get(key, fallback); } catch (_) { return fallback; }
  }
  function notice(message) {
    console.warn('[Lampa Audio WASM] ' + message);
    try { if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message); } catch (_) {}
  }
  /* Телеметрия: короткий GET на /mpvwasm/assets/tel-<base64>.js. Файла нет — lampac
   * отвечает 404, зато полный URL попадает в nginx-лог, и мы видим с устройства
   * ровно то, что происходит (какой плеер, какая сборка, сколько читается).
   * Больше 40 отчётов за сессию не шлём. */
  function report(payload) {
    try {
      report.count = (report.count || 0) + 1;
      if (report.count > 40) return;
      var body = base64Url(JSON.stringify(payload)).slice(0, 1400);
      if (typeof fetch !== 'function') return;
      fetch('/mpvwasm/assets/tel-' + body + '.js', { cache: 'no-store' })
        .then(function () {}).catch(function () {});
    } catch (_) {}
  }
  /* Плеер MPV2 (плагин mpvwasm-lampa-player.js) забирает воспроизведение себе:
   * сам демуксит контейнер и сам декодирует AC3/EAC3/DTS. Наш мост в этом режиме
   * только мешает — второй раз читает тот же файл и глушит звук. */
  function mpv2Active() {
    return storage('mpvwasm_player_mode', 'default') === 'mpv2' && !!window.__mpvwasm_lampa_plugin;
  }
  /* Контейнеры, которые встроенный <video> в WebView/Chrome реально умеет открыть.
   * Chromium 145+ играет и matroska, поэтому MKV тоже в списке — но если контейнер
   * заведомо не для браузера, насильно оставлять пользователя во встроенном плеере
   * нельзя: получится чёрный экран вместо нативного плеера приложения. */
  function containerLikelyPlayable(url) {
    var path = String(url || '').split('?')[0].split('#')[0].toLowerCase();
    if (/\.(mp4|m4v|mov|webm|mkv|mk3d|ts|m2ts|m3u8|mpd)$/.test(path)) return true;
    if (/\.(avi|wmv|flv|mpg|mpeg|vob|iso|rmvb|divx)$/.test(path)) return false;
    return true;
  }
  function codecName(track) {
    var name = String(track.codecName || track.codec_name || '').toLowerCase();
    if (name === 'eac3' || name === 'e-ac-3') return 'eac3';
    if (name === 'ac3' || name === 'ac-3') return 'ac3';
    if (name.indexOf('dts') === 0 || name === 'dca') return 'dts';
    return name;
  }
  function needsDecoder(video, track, mode) {
    var codec = codecName(track);
    if (!CODECS[codec] || mode === 'off') return false;
    // 'force' — всегда декодируем сами; 'inner' — то же плюс удерживаем встроенный плеер Lampa
    // на Android (ветка Lampa.Android.openPlayer не отдаёт поток нативному/внешнему плееру).
    if (mode === 'force' || mode === 'inner') return true;
    var label = codec === 'ac3' ? 'ac-3' : codec === 'eac3' ? 'ec-3' : 'dtsc';
    try { return !video.canPlayType('audio/mp4; codecs="' + label + '"'); }
    catch (_) { return true; }
  }
  function base64Url(value) {
    var bytes = new TextEncoder().encode(value);
    var text = '';
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return btoa(text).split('+').join('-').split('/').join('_').replace(/=+$/, '');
  }
  function sourceUrl(video) {
    return String(video.currentSrc || video.src || '');
  }
  function proxyUrl(url) {
    // Using the existing MPV WASM proxy ensures the worker can read HTTP byte ranges
    // even when the source server does not provide cross-origin access.
    // window.__mpvwasmProxyBase позволяет увести чтение на другой (быстрый) прокси.
    var base = String(window.__mpvwasmProxyBase || '').replace(/\/+$/, '');
    // Если ссылка уже идёт через наш прокси — не заворачиваем её второй раз.
    if (url.indexOf('/mpvwasm/proxy?u=') >= 0) return url;
    return base + '/mpvwasm/proxy?u=' + base64Url(url);
  }
  function AudioSession(video, data) {
    this.video = video;
    this.data = data || {};
    this.id = ++sessionNumber;
    this.closed = false;
    this.worker = null;
    this.workerId = 0;
    this.pending = {};
    this.ctx = null;
    this.node = null;
    this.tracks = [];
    this.selection = -1;
    this.selectedCodec = '';
    this.active = false;
    this.ready = false;
    this.opened = false;
    this.reading = false;
    this.eof = false;
    this.bufferedUs = 0;
    this.timer = null;
    this.lastSeek = -1;
    this.epoch = 0;
    this.lastError = '';
    this.stalled = false;
    this.startedAt = 0;
    this.reads = 0;
    this.mode = storage('mpvwasm_audio_mode', 'auto');
    this.url = sourceUrl(video);
    this.originalMuted = !!video.muted;
    var self = this;
    this.onNativeSeek = function () { self.seek(); };
    video.addEventListener('seeking', this.onNativeSeek);
  }
  AudioSession.prototype.request = function (command, payload) {
    var self = this;
    if (self.closed || !self.worker) return Promise.reject(Error('Audio session closed'));
    var id = ++self.workerId;
    // Без таймаута «зависший» read/open навсегда оставлял self.reading = true и звук умолкал.
    // Открытие включает загрузку wasm-глu (2.4 МБ) и разбор заголовка через прокси:
    // на телефоне это легко перевалить за 15 с, особенно на первом запуске.
    var limit = command === 'open' ? 30000 : command === 'read' ? 15000 : 8000;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (!self.pending[id]) return;
        delete self.pending[id];
        self.timeouts = (self.timeouts || 0) + 1;
        reject(Error('таймаут ' + command + ' (' + limit + ' мс)'));
      }, limit);
      self.pending[id] = {
        resolve: function (value) { clearTimeout(timer); resolve(value); },
        reject: function (error) { clearTimeout(timer); reject(error); }
      };
      try { self.worker.postMessage(Object.assign({ id: id, command: command }, payload || {})); }
      catch (error) { delete self.pending[id]; clearTimeout(timer); reject(error); }
    });
  };
  AudioSession.prototype.createWorker = function () {
    var self = this;
    self.worker = new Worker('/mpvwasm/assets/mpvwasm-audio-only-worker.js?v=' + VERSION);
    self.worker.onmessage = function (event) {
      var message = event.data || {};
      var pending = self.pending[message.id];
      if (!pending) return;
      delete self.pending[message.id];
      if (message.ok) pending.resolve(message.result);
      else pending.reject(Error(message.error || 'Audio worker error'));
    };
    self.worker.onerror = function (event) {
      self.fail('WASM worker: ' + (event.message || 'unable to start'));
    };
  };
  AudioSession.prototype.start = async function () {
    var self = this;
    if (self.closed || self.mode === 'off' || !self.url || !/^https?:/i.test(self.url)) return;
    if (typeof Worker !== 'function') {
      self.fail('Для Audio WASM нужен Web Worker');
      return;
    }
    // AudioWorklet есть только в защищённом контексте (HTTPS/localhost). Для http://IP:порт
    // и старых WebView остаётся ScriptProcessorNode — он работает везде.
    if (!window.isSecureContext || typeof AudioWorkletNode !== 'function') {
      console.warn('[Lampa Audio WASM] защищённого контекста нет — используется резервный рендерер (ScriptProcessor)');
    }
    try {
      self.createWorker();
      // Never alter the source video URL or its playback state.
      var info = await self.request('open', { url: proxyUrl(self.url) });
      if (self.closed) return;
      self.opened = true;
      self.tracks = (info.tracks || []).filter(function (t) { return t.type === 'audio'; });
      report({ ev: 'open', n: self.tracks.length, codecs: self.tracks.map(codecName).join(','),
        url: String(self.url).slice(-60), pmode: storage('mpvwasm_player_mode', 'default'),
        aw: typeof AudioWorkletNode, sec: !!window.isSecureContext });
      if (!self.tracks.some(function (t) { return needsDecoder(self.video, t, self.mode); })) {
        self.stopWorker();
        return;
      }
      self.renderTracks();
      var initial = self.tracks.findIndex(function (t) { return needsDecoder(self.video, t, self.mode); });
      // Auto-enable WASM only when the initial audio stream actually needs it.
      // Otherwise, leave native playback intact until the user chooses an unsupported track.
      if (initial === 0) self.selectTrack(0);
    } catch (error) {
      self.fail('Не удалось открыть Audio WASM: ' + (error.message || error));
    }
  };
  AudioSession.prototype.renderTracks = function () {
    var self = this;
    if (self.closed || !Lampa.PlayerPanel || !Lampa.PlayerPanel.setTracks) return;
    var ffprobe = Array.isArray(self.data.ffprobe) ? self.data.ffprobe : [];
    var items = self.tracks.map(function (track, audioIndex) {
      var codec = codecName(track);
      var meta = ffprobe.find(function (entry) { return entry.index === track.index; }) || {};
      var language = meta.tags && meta.tags.language || '';
      var title = track.title || meta.tags && meta.tags.title || (language ? language.toUpperCase() : 'Дорожка ' + (audioIndex + 1));
      var unsupported = needsDecoder(self.video, track, self.mode);
      return {
        index: audioIndex,
        title: title + ' / ' + codec.toUpperCase() + (unsupported ? ' / WASM' : ''),
        language: language,
        label: codec.toUpperCase(),
        extra: { channels: track.channels || 2 },
        selected: audioIndex === self.selection,
        enabled: audioIndex === self.selection,
        onSelect: function () { self.selectTrack(audioIndex); }
      };
    });
    Lampa.PlayerPanel.setTracks(items);
  };
  // Резервный рендерер: нужен там, где нет AudioWorklet (http://, старый WebView).
  // Логика микса/синхронизации повторяет mpvwasm-audio-only-worklet.js.
  function FallbackSink(ctx) {
    var self = this;
    this.blocks = [];
    this.clockUs = 0;
    this.rate = 1;
    this.paused = true;
    this.volume = 1;
    this.reportFrames = 0;
    this.underruns = 0;
    this.gaps = 0;
    this.slips = 0;
    this.skew = 1;
    this.inGap = false;
    // Очередь резервного рендерера заметно меньше, чем у ворклета. Раньше она молча
    // выбрасывала PCM: демуксер читал вперёд, буфер «не рос», мост доходил до EOF
    // и замолкал на середине фильма. Теперь лишнее не читается (см. AudioSession.pump),
    // а выброс виден снаружи и лечится пере-синхронизацией.
    this.capacity = 600;
    this.dropped = 0;
    var create = ctx.createScriptProcessor || ctx.createJavaScriptNode;
    if (!create) throw Error('ScriptProcessorNode недоступен');
    this.processor = create.call(ctx, 4096, 1, 2);
    this.port = {
      onmessage: null,
      postMessage: function (data) {
        var type = data && data.type;
        if (type === 'clear') {
          self.blocks.length = 0;
          self.clockUs = Math.max(0, Number(data.clockUs || 0));
          self.underruns = 0;
          self.gaps = 0;
          self.dropped = 0;
          self.skew = 1;
          self.inGap = false;
        } else if (type === 'sync') {
          var target = Math.max(0, Number(data.clockUs || 0));
          var delta = target - self.clockUs;
          // Жёсткий перескок — только перемотка/пауза/первый запуск. Мелкое
          // расхождение выбираем ходом (±2.5%), иначе каждый перескок = щелчок.
          if (self.paused || Math.abs(delta) > 400000) {
            self.clockUs = target;
            self.skew = 1;
            if (!self.paused) self.slips++;
          } else {
            self.skew = Math.max(0.975, Math.min(1.025, 1 + delta / 1000000));
          }
          self.paused = !!data.paused;
          self.rate = Math.max(0.25, Math.min(4, Number(data.rate || 1)));
          self.volume = Math.max(0, Math.min(1, Number(data.volume)));
          if (!isFinite(self.volume)) self.volume = 1;
        } else if (type === 'pcm') {
          var pcm = data.pcm;
          var channels = Math.max(1, Math.min(16, Number(data.channels || 2)));
          var rate = Math.max(8000, Number(data.sampleRate || 48000));
          var samples = Math.floor(pcm.length / channels);
          var start = Number(data.ptsUs);
          if (!samples || !isFinite(start)) return;
          if (self.blocks.length >= self.capacity) { self.dropped++; return; }
          self.blocks.push({ pcm: pcm, channels: channels, rate: rate, samples: samples,
                             start: start, end: start + samples * 1000000 / rate });
          self.blocks.sort(function (a, b) { return a.start - b.start; });
        }
      }
    };
    this.mix = function (block, frame, channel) {
      var channels = block.channels;
      var index = Math.max(0, Math.min(block.samples - 1, frame)) * channels;
      var pcm = block.pcm;
      if (channels === 1) return pcm[index] || 0;
      if (channels === 2) return pcm[index + channel] || 0;
      var value = pcm[index + channel] || 0;
      if (channels >= 3) value += (pcm[index + 2] || 0) * 0.7071;
      if (channels >= 5) value += (pcm[index + (channel === 0 ? 4 : (channels >= 6 ? 5 : 4))] || 0) * 0.5;
      if (channels >= 7) value += (pcm[index + (channel === 0 ? 6 : (channels >= 8 ? 7 : 6))] || 0) * 0.3;
      return value * 0.65;
    };
    this.report = function () {
      var last = self.blocks.length ? self.blocks[self.blocks.length - 1] : null;
      if (self.port.onmessage) self.port.onmessage({ data: {
        type: 'status',
        clockUs: Math.round(self.clockUs),
        bufferedUs: Math.max(0, Math.round((last ? last.end : self.clockUs) - self.clockUs)),
        queueLength: self.blocks.length,
        capacity: self.capacity,
        dropped: self.dropped,
        paused: self.paused,
        underruns: self.underruns,
        gaps: self.gaps,
        slips: self.slips,
        skew: self.skew
      } });
    };
    this.processor.onaudioprocess = function (event) {
      var output = event.outputBuffer;
      var frames = output.length;
      for (var i = 0; i < frames; i++) {
        if (self.paused) break;
        var now = self.clockUs;
        while (self.blocks.length && self.blocks[0].end <= now) self.blocks.shift();
        var block = self.blocks.length ? self.blocks[0] : null;
        if (block && now >= block.start && now < block.end) {
          self.inGap = false;
          var position = (now - block.start) * block.rate / 1000000;
          var frame = Math.floor(position);
          var alpha = position - frame;
          for (var channel = 0; channel < output.numberOfChannels; channel++) {
            var a = self.mix(block, frame, channel);
            var b = self.mix(block, Math.min(block.samples - 1, frame + 1), channel);
            var value = (a + (b - a) * alpha) * self.volume;
            output.getChannelData(channel)[i] = Math.max(-1, Math.min(1, value));
          }
        } else {
          self.underruns++;
          if (!self.inGap) { self.inGap = true; self.gaps++; }
        }
        self.clockUs += self.rate * self.skew * 1000000 / ctx.sampleRate;
      }
      self.reportFrames += frames;
      if (self.reportFrames >= ctx.sampleRate / 5) { self.reportFrames = 0; self.report(); }
    };
    this.connect = function (dest) { self.processor.connect(dest); };
    this.disconnect = function () { try { self.processor.disconnect(); } catch (e) {} };
  }

  AudioSession.prototype.ensureAudio = async function () {
    if (this.ctx && this.node) return;
    var Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw Error('AudioContext unavailable');
    var ctx = new Context({ latencyHint: 'playback' });
    var self = this;
    function attach(node) {
      node.port.onmessage = function (event) {
        var data = event.data || {};
        if (data.type !== 'status' || self.closed) return;
        self.lastStatus = { bufferedUs: Math.round(Number(data.bufferedUs || 0)), queueLength: data.queueLength,
                            paused: data.paused, underruns: data.underruns, gaps: data.gaps, slips: data.slips,
                            skew: data.skew, clockUs: data.clockUs };
        self.bufferedUs = Math.max(0, Number(data.bufferedUs || 0));
        self.sinkQueue = Number(data.queueLength || 0);
        self.sinkCapacity = Number(data.capacity || 0) || 4000;
        self.dropped = Number(data.dropped || 0);
        // Пре-ролл: сначала набираем запас, и только потом отдаём звук. С 0.35 с
        // любой провал в сети/декодировании слышен как щелчок.
        if (!self.ready && self.bufferedUs > 1500000 && ctx.state === 'running' && self.selection >= 0) {
          self.ready = true;
          self.active = true;
          self.video.muted = true;
        }
        // pump() из обработчика статуса нельзя звать синхронно: каждый пост PCM
        // порождает новый статус, и выходит бесконечная цепочка микротасок,
        // которая голодит таймеры (тест не может ни завершиться, ни упасть).
        // Планируем ход макротаской и склеиваем повторные статусы.
        if (!self.pumpPending) {
          self.pumpPending = true;
          setTimeout(function () {
            self.pumpPending = false;
            if (!self.closed) self.pump();
          }, 0);
        }
      };
      if ('onprocessorerror' in node) node.onprocessorerror = function () { self.fail('Ошибка звукового процессора'); };
      node.connect(ctx.destination);
      self.ctx = ctx;
      self.node = node;
    }
    var wantWorklet = !window.__mpvwasmForceFallback && typeof AudioWorkletNode === 'function' && !!ctx.audioWorklet;
    try {
      if (wantWorklet) {
        await ctx.audioWorklet.addModule('/mpvwasm/assets/mpvwasm-audio-only-worklet.js?v=' + VERSION);
        if (this.closed) { await ctx.close(); return; }
        attach(new AudioWorkletNode(ctx, 'lampa-audio-wasm-bridge', { outputChannelCount: [2] }));
      } else {
        attach(new FallbackSink(ctx));
      }
      await ctx.resume();
      if (ctx.state !== 'running') throw Error('AudioContext suspended (autoplay policy)');
      if (!wantWorklet) console.warn('[Lampa Audio WASM] рендерер: ScriptProcessor (резервный)');
    } catch (error) {
      if (wantWorklet) {
        // AudioWorklet не поднялся — пробуем резервный рендерер, а не отказываемся от звука
        try {
          attach(new FallbackSink(ctx));
          await ctx.resume();
          if (ctx.state === 'running') { console.warn('[Lampa Audio WASM] рендерер: ScriptProcessor (fallback после ошибки worklet)'); return; }
        } catch (fallbackError) { /* ниже сообщим исходную ошибку */ }
      }
      try { await ctx.close(); } catch (_) {}
      throw error;
    }
  };
  AudioSession.prototype.selectTrack = async function (index) {
    var self = this;
    if (self.closed || !self.opened) return;
    var track = self.tracks[index];
    if (!track) return;
    var epoch = ++self.epoch;
    self.selection = index;
    self.selectedCodec = codecName(track);
    self.stalled = false;
    self.startedAt = Date.now();
    self.reads = 0;
    self.ready = false;
    self.active = false;
    self.bufferedUs = 0;
    self.eof = false;
    self.video.muted = self.originalMuted;
    if (self.node) self.node.port.postMessage({ type: 'clear', clockUs: Math.round((self.video.currentTime || 0) * 1000000) });
    if (!needsDecoder(self.video, track, self.mode)) {
      try {
        var tracks = self.video.audioTracks;
        if (tracks && tracks.length > index) {
          for (var i = 0; i < tracks.length; i++) tracks[i].enabled = (i === index);
        } else {
          notice('Нативный выбор аудиодорожки недоступен на этом устройстве');
        }
      } catch (error) { notice('Ошибка переключения нативной дорожки'); }
      self.renderTracks();
      return;
    }
    // Мост берёт дорожку на себя: глушим нативное звучание сразу, иначе первые
    // секунды (пока копится пре-ролл) слышен «гул» аппаратного декодера.
    self.video.muted = true;
    self.mutedByBridge = true;
    try {
      await self.ensureAudio();
      if (self.closed || epoch !== self.epoch) return;
      var selection = await self.request('select', { index: track.index });
      if (!selection || self.closed || epoch !== self.epoch) return;
      var position = Math.max(0, Math.round(Number(self.video.currentTime || 0) * 1000000));
      await self.request('seek', { us: position });
      if (self.closed || epoch !== self.epoch) return;
      self.sync(true);
      self.pump();
      self.renderTracks();
    } catch (error) { self.fail('Аудиодекодер ' + codecName(track) + ': ' + (error.message || error)); }
  };
  AudioSession.prototype.pump = async function () {
    var self = this;
    if (self.closed || self.stalled || self.reading || self.eof || !self.node || self.selection < 0) return;
    if (!needsDecoder(self.video, self.tracks[self.selection], self.mode)) return;
    // Цель 5 с запаса: этого хватает, чтобы пережить и провал сети, и подтормаживание
    // декодера. За один проход воркер отдаёт не больше 3 с (maxPackets ниже), так
    // что очередь рендерера не переполняется и PCM не теряется.
    if (self.bufferedUs > 5000000) return;
    if (self.sinkQueue > Math.floor((self.sinkCapacity || 600) * 0.5)) return;
    var epoch = self.epoch;
    self.reading = true;
    try {
      var result = await self.request('read', { maxPackets: 96 });
      if (self.closed || epoch !== self.epoch || !self.node) return;
      self.reads++;
      var chunks = result && result.chunks || [];
      self.readErrors = 0;
      chunks.forEach(function (chunk) {
        self.node.port.postMessage({
          type: 'pcm', pcm: chunk.pcm, ptsUs: chunk.ptsUs,
          channels: chunk.channels, sampleRate: chunk.sampleRate
        }, [chunk.pcm.buffer]);
      });
      if (window.__mpvwasmDebug) {
        var now = Date.now();
        var dt = self.lastReadAt ? now - self.lastReadAt : 0;
        self.lastReadAt = now;
        var firstPts = chunks[0] && chunks[0].ptsUs;
        var audioSec = self.lastReadPts != null && firstPts != null ? (firstPts - self.lastReadPts) / 1e6 : 0;
        self.lastReadPts = firstPts;
        console.log('[Lampa Audio WASM] read: chunks=' + chunks.length +
          ' pts=' + firstPts + ' +' + audioSec.toFixed(2) + 's за ' + dt + 'мс' +
          ' eof=' + !!(result && result.eof) + ' buf=' + Math.round(self.bufferedUs) +
          ' video=' + (self.video.currentTime || 0).toFixed(1));
      }
      self.eof = !!(result && result.eof);
    } catch (error) {
      // Одиночный сбой чтения (таймаут/обрыв) не должен убивать звук целиком:
      // пробуем ещё несколько раз, и только потом сдаёмся.
      self.readErrors = (self.readErrors || 0) + 1;
      if (window.__mpvwasmDebug) console.log('[Lampa Audio WASM] read error #' + self.readErrors + ': ' + (error.message || error));
      if (epoch === self.epoch && self.readErrors > 5) {
        self.fail('Ошибка чтения аудио: ' + (error.message || error));
      }
    }
    finally { self.reading = false; }
  };
  AudioSession.prototype.seek = function () {
    var self = this;
    if (self.closed || !self.opened || self.selection < 0 || !needsDecoder(self.video, self.tracks[self.selection], self.mode)) return;
    var epoch = ++self.epoch;
    self.ready = false;
    self.bufferedUs = 0;
    self.eof = false;
    // После перемотки даём мосту второй шанс: буфер мог не успеть, а канал — освободиться.
    if (self.stalled) { self.stalled = false; self.startedAt = Date.now(); }
    var position = Math.max(0, Math.round(Number(self.video.currentTime || 0) * 1000000));
    self.video.muted = true;
    if (self.node) self.node.port.postMessage({ type: 'clear', clockUs: position });
    self.request('seek', { us: position }).then(function () {
      if (self.closed || epoch !== self.epoch) return;
      self.sync(true);
      self.pump();
    }).catch(function (error) { if (epoch === self.epoch) self.fail('Audio seek: ' + (error.message || error)); });
  };
  AudioSession.prototype.sync = function (force) {
    if (this.closed || !this.node || this.selection < 0) return;
    if (!needsDecoder(this.video, this.tracks[this.selection], this.mode)) return;
    if (this.active && !this.video.muted) this.video.muted = true;
    this.node.port.postMessage({
      type: 'sync',
      clockUs: Math.round(Math.max(0, Number(this.video.currentTime || 0)) * 1000000),
      paused: !!this.video.paused || !!this.video.seeking ||
        (typeof this.video.readyState === 'number' && this.video.readyState < 3),
      rate: Number(this.video.playbackRate || 1),
      volume: Number(this.video.volume)
    });
    if (force || this.bufferedUs < 3500000) this.pump();
  };
  /* Если чтение отстало от видео (в буфере ворклета пусто, а видео играет),
   * переставляем демуксер на текущую позицию — иначе PCM приходит «в прошлом»
   * и ворклет его выбрасывает, получается тишина. */
  AudioSession.prototype.keepUp = function () {
    var self = this;
    if (self.closed || !self.opened || self.selection < 0) return;
    if (!needsDecoder(self.video, self.tracks[self.selection], self.mode)) return;
    var playing = !self.video.paused && !self.video.seeking &&
      (typeof self.video.readyState !== 'number' || self.video.readyState >= 3);
    if (!playing) { self.starveSince = 0; return; }
    if (self.dropped > 0) {
      self.dropped = 0;
      if (self.lastResyncAt && Date.now() - self.lastResyncAt < 4000) return;
      self.lastResyncAt = Date.now();
      self.starveSince = 0;
      if (window.__mpvwasmDebug) console.log('[Lampa Audio WASM] PCM не помещался в буфер: пере-синхронизация');
      self.seek();
      return;
    }
    if (self.bufferedUs >= 200000) { self.starveSince = 0; return; }
    if (!self.starveSince) { self.starveSince = Date.now(); return; }
    if (Date.now() - self.starveSince < 2500 || self.reading) return;
    if (self.lastResyncAt && Date.now() - self.lastResyncAt < 4000) return;
    self.lastResyncAt = Date.now();
    self.starveSince = Date.now();
    if (window.__mpvwasmDebug) {
      console.log('[Lampa Audio WASM] отстали: пере-синхронизация на ' +
        Number(self.video.currentTime || 0).toFixed(1) + 'с');
    }
    self.seek();
  };
  /* Если за 15 с пре-ролл так и не набрался — канал/источник не тянет контейнер
   * (типичный 4K-ремьюкс: 25 Мбит/с при 2–5 Мбит/с от источника). Тогда честнее
   * отпустить: снять глушение, перестать читать (второе чтение само съедает канал)
   * и сказать пользователю, что нужна AAC-дорожка. Иначе фильм идёт вообще без звука. */
  AudioSession.prototype.checkStarvation = function () {
    var self = this;
    if (self.closed || self.stalled || self.selection < 0 || self.ready) return;
    if (!self.opened || !needsDecoder(self.video, self.tracks[self.selection], self.mode)) return;
    if (self.video.paused || self.video.seeking) { self.startedAt = Date.now(); return; }
    if (!self.startedAt) { self.startedAt = Date.now(); return; }
    if (Date.now() - self.startedAt < 15000) return;
    if (self.bufferedUs > 800000) { self.startedAt = Date.now(); return; }
    self.stalled = true;
    self.active = false;
    self.stallCount = (self.stallCount || 0) + 1;
    try { self.video.muted = self.originalMuted; } catch (_) {}
    if (self.stallCount <= 2) notice('Поток не успевает за видео — AC3/EAC3/DTS выключен. Выберите AAC-дорожку');
    report({ ev: 'stalled', codec: self.selectedCodec, buf: Math.round(self.bufferedUs), reads: self.reads, mode: self.mode, vw: self.video.videoWidth || 0, n: self.stallCount });
  };
  AudioSession.prototype.stopWorker = function () {
    var self = this;
    Object.keys(self.pending).forEach(function (id) {
      self.pending[id].reject(Error('Audio worker stopped'));
      delete self.pending[id];
    });
    if (self.worker) { self.worker.terminate(); self.worker = null; }
  };
  AudioSession.prototype.fail = function (message) {
    if (this.closed) return;
    this.lastError = message;
    notice(message);
    this.destroy();
  };
  AudioSession.prototype.destroy = function () {
    if (this.closed) return;
    this.closed = true;
    this.epoch++;
    if (this.timer) clearInterval(this.timer);
    try { this.video.removeEventListener('seeking', this.onNativeSeek); } catch (_) {}
    if (this.active || this.video.muted) {
      try { this.video.muted = this.originalMuted; } catch (_) {}
    }
    this.stopWorker();
    if (this.node) { try { this.node.disconnect(); this.node.port.onmessage = null; } catch (_) {} }
    if (this.ctx) { try { this.ctx.close().catch(function () {}); } catch (_) {} }
    this.node = null; this.ctx = null;
  };
  function attach(data) {
    if (!Lampa.PlayerVideo || typeof Lampa.PlayerVideo.video !== 'function') return;
    // MPV2-плеер сам демуксит и декодирует звук — наш мост в этом режиме лишний.
    if (mpv2Active()) return;
    var video = Lampa.PlayerVideo.video();
    if (!video || !video.tagName || video.tagName.toLowerCase() !== 'video') return;
    if (session && !session.closed && session.video === video && session.url === sourceUrl(video)) return;
    if (session) session.destroy();
    session = new AudioSession(video, data || (Lampa.Player.playdata && Lampa.Player.playdata()) || {});
    window.__mpvwasmSession = session;
    window.__mpvwasmState = function () {
      if (!session) return null;
      var st = session;
      return {
        mode: st.mode, url: String(st.url || '').slice(0, 90), opened: st.opened, ready: st.ready, active: st.active,
        selection: st.selection, tracks: st.tracks.length, bufferedUs: Math.round(st.bufferedUs), eof: st.eof,
        closed: st.closed, lastError: st.lastError, renderer: st.fallback ? 'ScriptProcessor' : 'AudioWorklet',
        ctxState: st.ctx ? st.ctx.state : null, reading: !!st.reading, timeouts: st.timeouts || 0,
        readErrors: st.readErrors || 0, lastStatus: st.lastStatus || null
      };
    };
    var target = session;
    target.timer = setInterval(function () {
      if (target.closed) return;
      if (sourceUrl(video) !== target.url) {
        target.destroy();
        if (session === target) { session = null; attach(); }
        return;
      }
      if (target.lastReportAt === undefined || Date.now() - target.lastReportAt > 15000) {
        target.lastReportAt = Date.now();
        report({ ev: 'tick', mode: target.mode, ready: target.ready, stalled: !!target.stalled,
          buf: Math.round(target.bufferedUs || 0), q: target.sinkQueue || 0, drop: target.dropped || 0,
          reads: target.reads || 0, sel: target.selection, tracks: target.tracks.length,
          vrs: video.readyState, vt: Math.round(video.currentTime || 0), vw: video.videoWidth || 0,
          np: video.paused, mut: video.muted, mpv2: mpv2Active(), err: target.lastError || '' });
      }
      target.checkStarvation();
      target.sync(false);
      target.keepUp();
    }, 120);
    target.start();
  }
  function cleanup() {
    if (session) session.destroy();
    session = null;
  }
  function registerSettings() {
    if (!Lampa.SettingsApi || !Lampa.SettingsApi.addParam) return;
    Lampa.SettingsApi.addParam({
      component: 'player',
      param: {
        name: 'mpvwasm_audio_mode', type: 'select', default: 'auto',
        values: {
          auto: 'Автоматически',
          force: 'Для AC3 / EAC3 / DTS всегда',
          inner: 'AC3 / EAC3 / DTS во встроенном плеере Lampa',
          off: 'Выключено'
        }
      },
      field: { name: 'Audio WASM (AC3 / EAC3 / DTS)', description: 'Звук через FFmpeg WASM; видео и управление остаются штатными. В режиме «MPV2 WebCodecs» мост не включается — звук декодирует сам плеер MPV2' }
    });
  }
  /* Разбор кодека до старта плеера: на Android Lampa по умолчанию отдаёт поток
   * нативному/внешнему плееру (Lampa.Android.openPlayer), куда наш мост не достаёт.
   * В режиме 'inner' быстро читаем заголовок контейнера через тот же WASM-воркер и,
   * если звук действительно AC3/EAC3/DTS, оставляем воспроизведение во встроенном
   * <video> Lampa, где мост и озвучивает дорожку. Иначе — как было. */
  var probeCache = {};
  function probeStream(url) {
    if (probeCache[url]) return probeCache[url];
    var promise = new Promise(function (resolve) {
      var worker = null, done = false;
      function finish(value) {
        if (done) return;
        done = true;
        try { if (worker) worker.terminate(); } catch (_) {}
        resolve(value);
      }
      try {
        worker = new Worker('/mpvwasm/assets/mpvwasm-audio-only-worker.js?v=' + VERSION);
        worker.onmessage = function (event) {
          var message = event.data || {};
          if (message.id !== 1) return;
          if (!message.ok) return finish({ audio: [] });
          var tracks = (message.result && message.result.tracks) || [];
          var audio = tracks.filter(function (t) { return t && t.type === 'audio'; });
          finish({ audio: audio.map(codecName), count: audio.length });
        };
        worker.onerror = function () { finish({ audio: [] }); };
        worker.postMessage({ id: 1, command: 'open', url: proxyUrl(url) });
        setTimeout(function () { finish({ audio: [] }); }, 6000);
      } catch (error) { finish({ audio: [] }); }
    });
    probeCache[url] = promise;
    return promise;
  }
  function guardAndroidPlayer() {
    if (!Lampa.Android || typeof Lampa.Android.openPlayer !== 'function' || Lampa.Android.__mpvwasmInnerGuard) return;
    var original = Lampa.Android.openPlayer;
    // Если встроенный плеер не открыл видео — возвращаемся к нативному плееру приложения,
    // иначе пользователь получает чёрный экран («в APK не работает ничего»).
    function fallbackToNative(link, data, why) {
      notice('Встроенный плеер не открыл видео (' + why + ') — переключаю на плеер приложения');
      report({ ev: 'guard-fallback', why: why });
      try { original.call(Lampa.Android, link, data); } catch (error) {
        console.warn('[Lampa Audio WASM] fallback to native failed: ' + error);
      }
    }
    function watchInner(link, data) {
      var done = false, video = null;
      function stop() { done = true; clearInterval(check); }
      var check = setInterval(function () {
        if (done) return;
        try {
          if (!video && Lampa.PlayerVideo && typeof Lampa.PlayerVideo.video === 'function') video = Lampa.PlayerVideo.video();
          if (video && video.tagName && video.tagName.toLowerCase() === 'video') {
            if (video.readyState >= 2) { stop(); return; }
            if (video.error && video.error.code) { stop(); fallbackToNative(link, data, 'ошибка ' + video.error.code); return; }
          }
        } catch (_) {}
      }, 1500);
      setTimeout(function () {
        if (done) return;
        var ready = 0;
        try { ready = video && video.readyState || 0; } catch (_) {}
        if (ready < 2) { stop(); fallbackToNative(link, data, 'видео не началось'); }
      }, 20000);
    }
    Lampa.Android.openPlayer = function (link, data) {
      var self = this;
      var url = String(link || '');
      if (storage('mpvwasm_audio_mode', 'auto') !== 'inner' || !/^https?:/i.test(url)) {
        return original.apply(self, arguments);
      }
      // В режиме MPV2 воспроизведением занимается плагин плеера — не вмешиваемся.
      if (mpv2Active()) return original.apply(self, arguments);
      // Контейнер, который встроенный плеер не откроет, насильно ему не отдаём.
      if (!containerLikelyPlayable(url)) return original.apply(self, arguments);
      probeStream(url).then(function (info) {
        var needed = (info.audio || []).some(function (codec) { return !!CODECS[codec]; });
        if (!needed) { original.call(self, link, data); return; }
        notice('AC3/EAC3/DTS — играю во встроенном плеере Lampa (Audio WASM)');
        report({ ev: 'guard-inner', url: url.slice(-60), audio: (info.audio || []).join(',') });
        var payload = {};
        for (var key in (data || {})) {
          if (Object.prototype.hasOwnProperty.call(data, key)) payload[key] = data[key];
        }
        payload.url = url;
        payload.launch_player = 'inner';
        Lampa.Player.play(payload);
        watchInner(link, data);
      }).catch(function () { original.call(self, link, data); });
    };
    Lampa.Android.__mpvwasmInnerGuard = true;
    console.log('[Lampa Audio WASM] Android inner-player guard armed');
  }
  function init() {
    if (!window.Lampa || !Lampa.Player || !Lampa.PlayerVideo || !Lampa.PlayerPanel) return false;
    registerSettings();
    guardAndroidPlayer();
    report({ ev: 'env', ver: VERSION, ua: userAgent().slice(-80),
      sec: !!window.isSecureContext, aw: typeof AudioWorkletNode, sab: typeof SharedArrayBuffer,
      player: storage('player', ''), pmode: storage('mpvwasm_player_mode', 'default'),
      amode: storage('mpvwasm_audio_mode', 'auto'), mpv2: !!window.__mpvwasm_lampa_plugin,
      android: !!(window.Lampa && Lampa.Android && Lampa.Android.openPlayer) });
    Lampa.Player.listener.follow('ready', function (event) { attach(event); });
    Lampa.Player.listener.follow('destroy', cleanup);
    Lampa.PlayerVideo.listener.follow('loadeddata', function () { attach(); });
    Lampa.PlayerVideo.listener.follow('destroy', cleanup);
    Lampa.PlayerVideo.listener.follow('tracks', function () {
      if (session && session.opened && !session.closed) setTimeout(function () {
        if (session && !session.closed) session.renderTracks();
      }, 0);
    });
    console.log('[Lampa Audio WASM] audio backend registered');
    return true;
  }
  if (!init()) {
    var tries = 0;
    var waiting = setInterval(function () { if (init() || ++tries >= 30) clearInterval(waiting); }, 500);
  }
})();
