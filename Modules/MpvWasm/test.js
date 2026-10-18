(function () {
  'use strict';

  function $(id) {
    return document.getElementById(id);
  }

  function log(message) {
    var target = $('log');
    var line = '[' + new Date().toLocaleTimeString() + '] ' + message;
    target.textContent += line + '\n';
    target.scrollTop = target.scrollHeight;
    if (window.console) console.log('[mpvwasm-test]', message);
  }

  function setText(id, value) {
    var node = $(id);
    if (node) node.textContent = value == null || value === '' ? '-' : String(value);
  }

  function encodeBase64Url(value) {
    var bytes = new TextEncoder().encode(value);
    var binary = '';
    bytes.forEach(function (b) { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function normalizeHeadersJson(value) {
    value = (value || '').trim();
    if (!value) return '';

    var parsed = JSON.parse(value);
    var keys = Object.keys(parsed || {});
    if (!keys.length) return '';

    return encodeBase64Url(JSON.stringify(parsed));
  }

  function buildUrl() {
    var raw = $('source-url').value.trim();
    if (!raw) throw new Error('URL is empty');
    if (raw.indexOf('/mpvwasm/') === 0 || /^https?:\/\/[^/]+\/mpvwasm\//i.test(raw)) return raw;
    if (!$('use-proxy').checked) return raw;

    var route = $('use-hls').checked || /\.m3u8(\?|$)/i.test(raw) ? '/mpvwasm/hls' : '/mpvwasm/proxy';
    var result = route + '?u=' + encodeURIComponent(encodeBase64Url(raw));
    var headers = normalizeHeadersJson($('headers-json').value);
    if (headers) result += '&h=' + encodeURIComponent(headers);
    return result;
  }

  function callbacks() {
    function valueOf(value) {
      if (value && typeof value === 'object' && 'value' in value) return value.value;
      return value;
    }

    return {
      duration: function (value) {
        setText('duration', valueOf(value));
        log('duration ' + JSON.stringify(value));
      },
      elapsed: function (value) {
        setText('elapsed', valueOf(value));
      },
      audioTracks: function (value) {
        setText('audio-tracks', Array.isArray(value) ? value.length : JSON.stringify(value));
        log('audioTracks ' + JSON.stringify(value));
      },
      subtitleTracks: function (value) {
        setText('subtitle-tracks', Array.isArray(value) ? value.length : JSON.stringify(value));
        log('subtitleTracks ' + JSON.stringify(value));
      },
      fileEnd: function (value) {
        log('fileEnd ' + JSON.stringify(value));
      },
      error: function (value) {
        log('error ' + JSON.stringify(value));
      },
      buffering: function (value) {
        setText('buffering', valueOf(value));
      },
      cache: function (value) {
        setText('cache', valueOf(value));
      },
      percentPos: function (value) {
        setText('percent-pos', valueOf(value));
      },
      videoSize: function (value) {
        if (value && typeof value === 'object') {
          setText('video-size', (value.w || value.width || '-') + 'x' + (value.h || value.height || '-'));
        } else {
          setText('video-size', value);
        }
      }
    };
  }

  var playerPromise;

  function ensurePlayer() {
    if (!playerPromise) {
      log('initializing libmpv-wasm');
      playerPromise = window.MpvWasmTest.createPlayer($('screen'), $('log'), callbacks()).then(function (player) {
        log('player ready');
        return player;
      });
    }
    return playerPromise;
  }

  function wire() {
    $('build-url').addEventListener('click', function () {
      try {
        $('built-url').value = buildUrl();
      } catch (err) {
        log(err.message || String(err));
      }
    });

    $('play').addEventListener('click', async function () {
      try {
        var url = buildUrl();
        $('built-url').value = url;
        log('loadUrl ' + url);
        await window.MpvWasmTest.loadUrl(await ensurePlayer(), url);
      } catch (err) {
        log(err.stack || err.message || String(err));
      }
    });

    $('pause').addEventListener('click', async function () {
      try { await window.MpvWasmTest.setPause(await ensurePlayer(), true); } catch (err) { log(err.message); }
    });

    $('resume').addEventListener('click', async function () {
      try { await window.MpvWasmTest.setPause(await ensurePlayer(), false); } catch (err) { log(err.message); }
    });

    $('back').addEventListener('click', async function () {
      try { await window.MpvWasmTest.seek(await ensurePlayer(), -30); } catch (err) { log(err.message); }
    });

    $('forward').addEventListener('click', async function () {
      try { await window.MpvWasmTest.seek(await ensurePlayer(), 30); } catch (err) { log(err.message); }
    });

    $('build-url').click();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
