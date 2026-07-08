(function () {
  'use strict';

  function writeLog(target, message) {
    var line = '[' + new Date().toLocaleTimeString() + '] ' + message;
    if (target) {
      target.textContent += line + '\n';
      target.scrollTop = target.scrollHeight;
    }
    if (window.console) console.log('[mpvwasm]', message);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (window.console) console.log('[mpvwasm-core]', 'loadScript begin', src);
      var script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = function () {
        if (window.console) console.log('[mpvwasm-core]', 'loadScript done', src);
        resolve();
      };
      script.onerror = function () {
        if (window.console) console.log('[mpvwasm-core]', 'loadScript error', src);
        reject(new Error('Unable to load ' + src));
      };
      document.head.appendChild(script);
    });
  }

  var coreVersion = '20260708-54-fallback-grace';
  var libmpvScript = '/mpvwasm/libmpv.js?v=' + coreVersion;
  var wrapperScript = '/mpvwasm/assets/mpvplayer-wrapper.js?v=' + coreVersion;

  function locateMpvFile(file) {
    var url = '/mpvwasm/' + file;
    if (file === 'libmpv.wasm' || file === 'libmpv.data') url += '?v=' + coreVersion;
    return url;
  }

  async function findFactory(log) {
    if (window.console) console.log('[mpvwasm-core]', 'findFactory begin', {
      hasMpvPlayer: !!window.MpvPlayer,
      hasCreateMpvPlayer: !!window.createMpvPlayer,
      hasLoader: typeof window.libmpvLoader
    });
    if (window.MpvPlayer) return window.MpvPlayer;
    if (window.createMpvPlayer) return window.createMpvPlayer;

    if (typeof window.libmpvLoader !== 'function') {
      await loadScript(libmpvScript);
    }

    if (!window.MpvPlayer && !window.createMpvPlayer) {
      await loadScript(wrapperScript);
    }

    var factory = window.MpvPlayer || window.createMpvPlayer;
    if (window.console) console.log('[mpvwasm-core]', 'findFactory done', {
      hasFactory: !!factory,
      hasMpvPlayer: !!window.MpvPlayer,
      hasCreateMpvPlayer: !!window.createMpvPlayer,
      hasLoader: typeof window.libmpvLoader
    });
    return factory;
  }

  function callFirst(target, names, args) {
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (target && typeof target[name] === 'function') {
        return target[name].apply(target, args || []);
      }
    }
    return undefined;
  }

  function command(player, args) {
    var result = callFirst(player, ['command', 'commandAsync', 'mpvCommand'], [args]);
    if (result !== undefined) return result;
    return callFirst(player && player.module, ['command', 'commandAsync', 'mpvCommand'], [args]);
  }

  async function createPlayer(canvas, log, callbacks, createOptions) {
    if (window.console) console.log('[mpvwasm-core]', 'createPlayer begin');
    var factory = await findFactory(log);
    if (window.console) console.log('[mpvwasm-core]', 'createPlayer factory', !!factory);
    if (!factory) throw new Error('libmpv-wasm player factory was not found');

    callbacks = callbacks || {};
    createOptions = createOptions || {};
    var playerOptions = {};
    Object.keys(callbacks).forEach(function (key) {
      playerOptions[key] = callbacks[key];
    });
    if (createOptions.initialUrl) playerOptions.initialUrl = createOptions.initialUrl;
    if (createOptions.initialPath) playerOptions.initialPath = createOptions.initialPath;
    if (createOptions.initialNetworkOptions) playerOptions.initialNetworkOptions = createOptions.initialNetworkOptions;
    if (createOptions.initialMpvOptions) playerOptions.initialMpvOptions = createOptions.initialMpvOptions;

    if (factory && typeof factory.load === 'function') {
      if (window.console) console.log('[mpvwasm-core]', 'factory.load begin');
      return await factory.load(canvas, libmpvScript, playerOptions);
    }

    var opts = {
      canvas: canvas,
      locateFile: locateMpvFile,
      print: function (msg) { writeLog(log, msg); },
      printErr: function (msg) { writeLog(log, 'ERR ' + msg); }
    };
    Object.keys(playerOptions).forEach(function (key) {
      opts[key] = playerOptions[key];
    });

    if (typeof factory === 'function') {
      return await factory(opts);
    }

    if (typeof factory.create === 'function') {
      return await factory.create(opts);
    }

    if (typeof factory.MpvPlayer === 'function') {
      return await factory.MpvPlayer(opts);
    }

    throw new Error('Unsupported libmpv-wasm API shape');
  }

  async function loadUrl(player, url) {
    var result = callFirst(player, ['loadUrl', 'loadURL', 'loadFile', 'load'], [url, '']);
    if (result !== undefined) return result;
    result = callFirst(player && player.module, ['loadUrl', 'loadURL', 'loadFile', 'load'], [url, '']);
    if (result !== undefined) return result;
    return command(player, ['loadfile', url, 'replace']);
  }

  function setPause(player, value) {
    var result = callFirst(player, ['setPause', 'pause'], [value]);
    if (result !== undefined) return result;
    result = callFirst(player && player.module, ['setPause', 'pause'], [value]);
    if (result !== undefined) return result;
    return command(player, ['set_property', 'pause', value ? 'yes' : 'no']);
  }

  function seek(player, seconds) {
    var result = callFirst(player, ['seekRelative', 'seek'], [seconds]);
    if (result !== undefined) return result;
    result = callFirst(player && player.module, ['seekRelative', 'seek'], [seconds]);
    if (result !== undefined) return result;
    return command(player, ['seek', String(seconds), 'relative']);
  }

  function boot(ui) {
    var playerPromise;

    function ensurePlayer() {
      if (!playerPromise) {
        writeLog(ui.log, 'initializing libmpv-wasm');
        playerPromise = createPlayer(ui.canvas, ui.log).then(function (player) {
          writeLog(ui.log, 'player ready');
          return player;
        });
      }
      return playerPromise;
    }

    ui.load.addEventListener('click', async function () {
      try {
        var player = await ensurePlayer();
        writeLog(ui.log, 'loadUrl ' + ui.input.value);
        await loadUrl(player, ui.input.value);
      } catch (err) {
        writeLog(ui.log, err.stack || err.message || String(err));
      }
    });

    ui.pause.addEventListener('click', async function () {
      try { await setPause(await ensurePlayer(), true); } catch (err) { writeLog(ui.log, err.message); }
    });

    ui.resume.addEventListener('click', async function () {
      try { await setPause(await ensurePlayer(), false); } catch (err) { writeLog(ui.log, err.message); }
    });

    ui.back.addEventListener('click', async function () {
      try { await seek(await ensurePlayer(), -30); } catch (err) { writeLog(ui.log, err.message); }
    });

    ui.forward.addEventListener('click', async function () {
      try { await seek(await ensurePlayer(), 30); } catch (err) { writeLog(ui.log, err.message); }
    });
  }

  window.MpvWasmTest = {
    boot: boot,
    createPlayer: createPlayer,
    loadUrl: loadUrl,
    setPause: setPause,
    seek: seek
  };
})();
