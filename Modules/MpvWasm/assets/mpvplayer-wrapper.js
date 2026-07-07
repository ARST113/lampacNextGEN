(function () {
  'use strict';

  function toCamelCase(value) {
    return String(value || '').replace(/-([a-z])/g, function (_, chr) {
      return chr.toUpperCase();
    });
  }

  function mapTrack(track) {
    if (!track || typeof track !== 'object') return track;
    var mapped = {};
    Object.keys(track).forEach(function (key) {
      mapped[toCamelCase(key)] = track[key];
    });
    return mapped;
  }

  function numberField(value) {
    var number = Number(value || 0);
    return isFinite(number) && number > 0 ? number : 0;
  }

  function trackVideoSize(track) {
    if (!track) return null;
    var width = numberField(track.width || track.w || track.demuxW || track.codecW || track.codecWidth);
    var height = numberField(track.height || track.h || track.demuxH || track.codecH || track.codecHeight);
    return width && height ? { width: width, height: height, w: width, h: height } : null;
  }

  function callback(options, name, value) {
    var fn = options && options[name];
    if (typeof fn === 'function') fn(value);
  }

  function MpvPlayer(module, options) {
    this.module = module;
    this.options = options || {};
    this.isPlaying = false;
    this.duration = 0;
    this.elapsed = 0;
    this.audioTracks = [];
    this.subtitleTracks = [];
    this.videoTracks = [];
    this._workerReady = this._attachWorker();
  }

  function absoluteUrl(url) {
    url = String(url || '');
    if (/^\//.test(url)) return window.location.origin + url;
    return url;
  }

  MpvPlayer.load = async function (canvas, mainScriptUrlOrBlob, options) {
    if (typeof window.libmpvLoader !== 'function') {
      throw new Error('libmpvLoader was not found');
    }

    options = options || {};
    var initialNetworkFile = null;
    if (options.initialUrl && /^https?:\/\//i.test(absoluteUrl(options.initialUrl))) {
      initialNetworkFile = {
        path: options.initialPath || '/net/source-1.mkv',
        url: absoluteUrl(options.initialUrl),
        opts: options.initialNetworkOptions || {
          chunkSize: 4 * 1024 * 1024,
          maxCacheBytes: 192 * 1024 * 1024
        }
      };
    }

    var existingCanvas = document.getElementById('canvas');
    if (existingCanvas && existingCanvas !== canvas) {
      existingCanvas.removeAttribute('id');
    }
    if (canvas && canvas.id !== 'canvas') {
      canvas.id = 'canvas';
    }

    callback(options, 'status', 'libmpvLoader begin');
    var runtimeResolved = false;
    var module = await new Promise(function (resolve, reject) {
      var loaderPromise = window.libmpvLoader({
        canvas: canvas,
        mainScriptUrlOrBlob: mainScriptUrlOrBlob,
        locateFile: function (file) {
          var version = '20260707-34-hw4k';
          var url = '/mpvwasm/' + file;
          if (file === 'libmpv.wasm' || file === 'libmpv.data') url += '?v=' + version;
          return url;
        },
        print: function (message) {
          callback(options, 'status', 'stdout ' + message);
        },
        printErr: function (message) {
          callback(options, 'status', 'stderr ' + message);
        },
        onRuntimeInitialized: function () {
          if (initialNetworkFile) {
            callback(options, 'status', 'NetworkFS runtime mount ' + initialNetworkFile.path);
            this.NetworkFS.mountFile(initialNetworkFile.path, initialNetworkFile.url, initialNetworkFile.opts);
            callback(options, 'status', 'NetworkFS runtime ready ' + initialNetworkFile.path);
          }
          callback(options, 'status', 'runtime initialized');
          runtimeResolved = true;
          resolve(this);
        },
        onAbort: function (reason) {
          reject(new Error(String(reason)));
          callback(options, 'error', { fatal: true, error: String(reason) });
        }
      });
      if (loaderPromise && typeof loaderPromise.then === 'function') {
        loaderPromise.then(function (loadedModule) {
          callback(options, 'status', 'libmpvLoader promise resolved');
          if (!runtimeResolved) resolve(loadedModule);
        }, reject);
      }
    });

    callback(options, 'status', 'libmpvLoader resolved');
    var player = new MpvPlayer(module, options || {});
    if (initialNetworkFile) {
      player._networkSeq = 1;
      await player._workerReady;
      callback(options, 'status', 'loadFile ' + initialNetworkFile.path);
      await player._loadFileInMpvWorker(initialNetworkFile.path, options.initialMpvOptions || '');
    }

    return player;
  };

  MpvPlayer.prototype._attachWorker = async function () {
    var self = this;

    var threadId = await new Promise(function (resolve) {
      var started = Date.now();
      var timer = setInterval(function () {
        if (!self.module || typeof self.module.getMpvThread !== 'function') {
          clearInterval(timer);
          resolve(0);
          return;
        }

        var id = self.module.getMpvThread();
        if (id || Date.now() - started > 60000) {
          clearInterval(timer);
          resolve(id || 0);
        }
      }, 100);
    });

    var pthreads = self.module && self.module.PThread && self.module.PThread.pthreads;
    var worker = pthreads && pthreads[threadId];
    if (!worker) return;

    self.mpvWorker = worker;
    worker.addEventListener('message', function (event) {
      self._handleWorkerMessage(event);
    });
  };

  MpvPlayer.prototype._handleWorkerMessage = function (event) {
    var payload;
    try {
      payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch (_) {
      return;
    }

    if (!payload || typeof payload !== 'object') return;

    if (payload.type === 'networkfs-mounted') {
      callback(this.options, 'status', 'NetworkFS worker mounted ' + payload.path + ' size=' + payload.size);
      return;
    }

    if (payload.type === 'networkfs-error') {
      callback(this.options, 'status', 'NetworkFS worker error ' + payload.error);
      callback(this.options, 'error', payload);
      return;
    }

    if (payload.type === 'mpv-loadfile-dispatched') {
      callback(this.options, 'status', 'mpv-loadfile-dispatched ' + payload.path);
      return;
    }

    if (payload.type === 'mpv-loadfile-error') {
      callback(this.options, 'status', 'mpv-loadfile-error ' + payload.error);
      callback(this.options, 'error', payload);
      return;
    }

    if (payload.type === 'mpv-command-dispatched') {
      callback(this.options, 'status', 'mpv-command-dispatched ' + payload.name + ' ' + payload.value);
      return;
    }

    if (payload.type === 'mpv-command-error') {
      callback(this.options, 'status', 'mpv-command-error ' + payload.name + ' ' + payload.error);
      callback(this.options, 'error', payload);
      return;
    }

    if (payload.type === 'file-end') {
      this.isPlaying = false;
      callback(this.options, 'status', 'file-end');
      callback(this.options, 'fileEnd', payload);
      return;
    }

    if (payload.type === 'file-start') {
      var self = this;
      this.isPlaying = true;
      callback(this.options, 'status', 'file-start');
      callback(this.options, 'isPlaying', true);
      callback(this.options, 'fileStart', payload);
      setTimeout(function () {
        try {
          if (self.module && typeof self.module.getTracks === 'function') self.module.getTracks();
        } catch (_) { }
      }, 800);
      return;
    }

    if (payload.type === 'track-list' && Array.isArray(payload.tracks)) {
      var tracks = payload.tracks.map(mapTrack);
      this.videoTracks = tracks.filter(function (track) { return track && track.type === 'video'; });
      this.audioTracks = tracks.filter(function (track) { return track && track.type === 'audio'; });
      this.subtitleTracks = tracks.filter(function (track) { return track && track.type && track.type !== 'video' && track.type !== 'audio'; });
      var size = trackVideoSize(this.videoTracks.filter(function (track) { return track.selected; })[0] || this.videoTracks[0]);
      if (size) callback(this.options, 'videoSize', size);
      callback(this.options, 'videoTracks', this.videoTracks);
      callback(this.options, 'audioTracks', this.audioTracks);
      callback(this.options, 'subtitleTracks', this.subtitleTracks);
      return;
    }

    if (payload.type !== 'property-change') return;

    switch (payload.name) {
      case 'pause':
        if (this._pauseUserChangeUntil && Date.now() < this._pauseUserChangeUntil) break;
        this.isPlaying = !payload.value;
        callback(this.options, 'isPlaying', this.isPlaying);
        break;
      case 'duration':
        this.duration = Number(payload.value || 0);
        callback(this.options, 'duration', this.duration);
        break;
      case 'playback-time':
        this.elapsed = Number(payload.value || 0);
        callback(this.options, 'elapsed', this.elapsed);
        break;
      case 'demuxer-cache-duration':
      case 'demuxer-cache-time':
        callback(this.options, 'cache', payload.value);
        break;
      case 'cache-buffering-state':
        callback(this.options, 'buffering', payload.value);
        break;
      case 'percent-pos':
        callback(this.options, 'percentPos', payload.value);
        break;
      case 'video-params/w':
      case 'video-params/h':
        this._videoSize = this._videoSize || {};
        if (payload.name === 'video-params/w') this._videoSize.width = this._videoSize.w = Number(payload.value || 0);
        if (payload.name === 'video-params/h') this._videoSize.height = this._videoSize.h = Number(payload.value || 0);
        callback(this.options, 'videoSize', this._videoSize);
        break;
    }
  };

  MpvPlayer.prototype._listPthreadWorkers = function () {
    var workers = [];
    var seen = [];
    var pthreads = this.module && this.module.PThread && this.module.PThread.pthreads;
    if (pthreads) {
      Object.keys(pthreads).forEach(function (key) {
        var worker = pthreads[key];
        if (worker && seen.indexOf(worker) === -1) {
          seen.push(worker);
          workers.push({ id: Number(key), worker: worker });
        }
      });
    }
    if (this.mpvWorker && seen.indexOf(this.mpvWorker) === -1) {
      workers.push({ id: 0, worker: this.mpvWorker });
    }
    return workers;
  };

  MpvPlayer.prototype._listSidePthreadWorkers = function () {
    var workers = this._listPthreadWorkers();
    var mainThreadId = 0;
    if (this.module && typeof this.module.getMpvThread === 'function') {
      mainThreadId = Number(this.module.getMpvThread() || 0);
    }
    var sideWorkers = workers.filter(function (item) {
      return !mainThreadId || item.id !== mainThreadId;
    });
    return sideWorkers.length ? sideWorkers : workers;
  };

  MpvPlayer.prototype._postMpvWorkerCommand = function (cmd, payload) {
    if (!this.mpvWorker) return false;
    this.mpvWorker.postMessage(Object.assign({ cmd: cmd }, payload || {}));
    return true;
  };

  MpvPlayer.prototype._networkFileWorkerCommand = function (worker, cmd, expectedType, path, url, opts, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var timer;
      var listener = function (event) {
        var payload;
        try {
          payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        } catch (_) {
          return;
        }

        if (!payload || payload.path !== path) return;
        if (payload.type === expectedType) {
          clearTimeout(timer);
          worker.removeEventListener('message', listener);
          resolve(payload);
        } else if (payload.type === 'networkfs-error') {
          clearTimeout(timer);
          worker.removeEventListener('message', listener);
          reject(new Error(payload.error || 'NetworkFS worker mount failed'));
        }
      };

      timer = setTimeout(function () {
        worker.removeEventListener('message', listener);
        reject(new Error('NetworkFS worker mount timeout'));
      }, timeoutMs || 45000);

      worker.addEventListener('message', listener);
      worker.postMessage({
        cmd: cmd,
        path: path,
        url: url,
        opts: opts || {}
      });
    });
  };

  MpvPlayer.prototype._mountNetworkFileInWorkers = async function (path, url, opts) {
    await this._workerReady;
    var sideWorkers = this._listSidePthreadWorkers();
    var allWorkers = this._listPthreadWorkers();
    if (!sideWorkers.length) {
      this._workerReady = this._attachWorker();
      await this._workerReady;
      sideWorkers = this._listSidePthreadWorkers();
      allWorkers = this._listPthreadWorkers();
    }
    if (!sideWorkers.length) throw new Error('mpv workers are not ready');

    var creator = null;
    var mounted = null;
    var mountErrors = [];
    for (var i = 0; i < sideWorkers.length; i++) {
      try {
        creator = sideWorkers[i];
        mounted = await this._networkFileWorkerCommand(
          creator.worker,
          'networkfsMount',
          'networkfs-mounted',
          path,
          url,
          opts,
          20000
        );
        break;
      } catch (err) {
        mountErrors.push((creator && creator.id ? creator.id + ': ' : '') + (err && (err.message || err) || err));
        creator = null;
      }
    }
    if (!mounted || !creator) {
      throw new Error('NetworkFS worker mount failed: ' + mountErrors.join('; '));
    }

    if (this.module.NetworkFS && typeof this.module.NetworkFS.attachFile === 'function') {
      try {
        this.module.NetworkFS.attachFile(path, url, Object.assign({}, opts || {}, {
          size: mounted.size,
          backendPointer: mounted.backendPointer
        }));
      } catch (err) {
        callback(this.options, 'status', 'NetworkFS main attach failed ' + (err && (err.message || err) || err));
      }
    }

    var self = this;
    var attachWorkers = allWorkers.filter(function (item) {
      return item.worker !== creator.worker;
    });
    var attachOpts = Object.assign({}, opts || {}, {
      size: mounted.size,
      backendPointer: mounted.backendPointer
    });
    var attachResults = await Promise.allSettled(attachWorkers.map(function (item) {
      return self._networkFileWorkerCommand(
        item.worker,
        'networkfsAttach',
        'networkfs-attached',
        path,
        url,
        attachOpts,
        20000
      );
    }));
    var attached = attachResults.filter(function (result) { return result.status === 'fulfilled'; });
    var failed = attachResults.filter(function (result) { return result.status !== 'fulfilled'; });
    if (failed.length) {
      var reasons = failed.map(function (result) {
        return result.reason && (result.reason.message || result.reason) || result;
      }).join(' | ');
      callback(this.options, 'status', 'NetworkFS attach partial ' + attached.length + '/' + attachWorkers.length + ' ' + reasons);
    }
    return {
      path: path,
      count: 1 + attached.length,
      total: 1 + attachWorkers.length,
      size: mounted.size,
      backendPointer: mounted.backendPointer
    };
  };

  MpvPlayer.prototype.loadUrl = async function (url, options) {
    if (typeof this.module.loadFile !== 'function') {
      throw new Error('libmpv module does not expose loadFile');
    }

    url = absoluteUrl(url);
    this.isPlaying = false;
    this.duration = 0;
    this.elapsed = 0;
    this.audioTracks = [];
    this.subtitleTracks = [];
    this.videoTracks = [];

    if (this.module.NetworkFS && /^https?:\/\//i.test(url)) {
      this._networkSeq = (this._networkSeq || 0) + 1;
      var mountedPath = '/net/source-' + this._networkSeq + '.mkv';
      var mountOpts = {
        chunkSize: 4 * 1024 * 1024,
        maxCacheBytes: 192 * 1024 * 1024
      };
      var workerMounted = await this._mountNetworkFileInWorkers(mountedPath, url, mountOpts);
      callback(this.options, 'status', 'NetworkFS side worker ready ' + workerMounted.path + ' ' + workerMounted.count + '/' + workerMounted.total + ' size=' + workerMounted.size);
      callback(this.options, 'status', 'loadFile ' + mountedPath);
      await this._loadFileInMpvWorker(mountedPath, options || '');
      return;
    }

    callback(this.options, 'status', 'loadFile ' + url);
    await this._loadFileInMpvWorker(url, options || '');
  };

  MpvPlayer.prototype.loadFile = MpvPlayer.prototype.loadUrl;

  MpvPlayer.prototype._waitForMpvReady = async function () {
    var self = this;
    var started = Date.now();
    var logged = false;

    return await new Promise(function (resolve) {
      var timer = setInterval(function () {
        var ready = !self.module || typeof self.module.isMpvReady !== 'function' ? 1 : self.module.isMpvReady();
        var mainThread = self.module && typeof self.module.getMpvThread === 'function' ? self.module.getMpvThread() : 0;
        var sideThread = self.module && typeof self.module.getSideThread === 'function' ? self.module.getSideThread() : 0;

        if (!logged) {
          logged = true;
          callback(self.options, 'status', 'mpv ready wait main=' + mainThread + ' side=' + sideThread + ' ready=' + ready);
        }

        if (ready || Date.now() - started > 60000) {
          clearInterval(timer);
          callback(self.options, 'status', 'mpv ready final main=' + mainThread + ' side=' + sideThread + ' ready=' + ready);
          resolve(!!ready);
        }
      }, 50);
    });
  };

  MpvPlayer.prototype._loadFileInMpvWorker = async function (path, options) {
    await this._workerReady;
    var ready = await this._waitForMpvReady();
    if (!ready) {
      callback(this.options, 'status', 'loadFile skipped mpv not ready ' + path);
      return;
    }
    callback(this.options, 'status', 'loadFile bridge-call ' + path);
    try {
      var loader = typeof this.module.loadFileDirect === 'function' ? this.module.loadFileDirect : this.module.loadFile;
      var loaderName = loader === this.module.loadFileDirect ? 'loadFileDirect' : 'loadFile';
      callback(this.options, 'status', 'loadFile bridge-loader ' + loaderName);
      loader(path, options || '');
      callback(this.options, 'status', 'loadFile bridge-return ' + path);
    } catch (error) {
      callback(this.options, 'status', 'loadFile bridge-error ' + (error && (error.stack || error.message) || error));
      throw error;
    }
  };

  MpvPlayer.prototype.setPause = async function (value) {
    await this._workerReady;
    if (this.isPlaying === !value) return;
    this.isPlaying = !value;
    this._pauseUserChangeUntil = Date.now() + 1200;
    if (this._postMpvWorkerCommand('mpvSetPause', { value: !!value })) {
      callback(this.options, 'status', 'mpv-command-send setPause ' + (!!value));
    } else if (typeof this.module.setPause === 'function') this.module.setPause(!!value);
    else if (typeof this.module.togglePlay === 'function') this.module.togglePlay();
    callback(this.options, 'isPlaying', this.isPlaying);
  };

  MpvPlayer.prototype.pause = MpvPlayer.prototype.setPause;

  MpvPlayer.prototype.seek = async function (seconds) {
    await this._workerReady;
    if (this._postMpvWorkerCommand('mpvSetPlaybackTime', { seconds: Number(seconds) })) {
      callback(this.options, 'status', 'mpv-command-send setPlaybackTime ' + Number(seconds));
      this.elapsed = Number(seconds || 0);
      callback(this.options, 'elapsed', this.elapsed);
    } else if (typeof this.module.setPlaybackTime === 'function') {
      this.module.setPlaybackTime(Number(seconds));
      this.elapsed = Number(seconds || 0);
      callback(this.options, 'elapsed', this.elapsed);
    }
  };

  MpvPlayer.prototype.seekRelative = async function (seconds) {
    await this._workerReady;
    var value = Number(seconds || 0);
    this.elapsed = Math.max(0, this.duration ? Math.min(this.duration, this.elapsed + value) : this.elapsed + value);
    if (this._postMpvWorkerCommand('mpvSetPlaybackTime', { seconds: this.elapsed })) {
      callback(this.options, 'status', 'mpv-command-send setPlaybackTime ' + this.elapsed);
    } else if (typeof this.module.setPlaybackTime === 'function') {
      this.module.setPlaybackTime(this.elapsed);
    } else if (value >= 0 && typeof this.module.skipForward === 'function') {
      this.module.skipForward(value);
    } else if (value < 0 && typeof this.module.skipBackward === 'function') {
      this.module.skipBackward(Math.abs(value));
    }
    callback(this.options, 'elapsed', this.elapsed);
  };

  MpvPlayer.prototype.setVolume = async function (value) {
    await this._workerReady;
    var volume = Number(value || 0);
    if (!isFinite(volume)) volume = 1;
    if (volume <= 1) volume = volume * 100;
    volume = Math.max(0, Math.min(100, volume));
    if (this._postMpvWorkerCommand('mpvSetVolume', { value: volume })) {
      callback(this.options, 'status', 'mpv-command-send setVolume ' + volume);
    } else if (typeof this.module.setVolume === 'function') {
      this.module.setVolume(volume);
    }
  };

  MpvPlayer.prototype.setAudioTrack = function (id) {
    if (this._postMpvWorkerCommand('mpvSetAudioTrack', { id: id })) {
      callback(this.options, 'status', 'mpv-command-send setAudioTrack ' + id);
    } else if (typeof this.module.setAudioTrack === 'function') {
      this.module.setAudioTrack(id);
    }
  };

  MpvPlayer.prototype.setSubtitleTrack = function (id) {
    if (this._postMpvWorkerCommand('mpvSetSubtitleTrack', { id: id })) {
      callback(this.options, 'status', 'mpv-command-send setSubtitleTrack ' + id);
    } else if (typeof this.module.setSubtitleTrack === 'function') {
      this.module.setSubtitleTrack(id);
    }
  };

  MpvPlayer.prototype.setOptions = function (options) {
    this.options = options || {};
  };

  MpvPlayer.prototype.destroy = function () {
    if (typeof this.module.stop === 'function') this.module.stop();
  };

  window.MpvPlayer = MpvPlayer;
})();
