(function () {
  'use strict';

  var SERVER = '{localhost}'.replace(/\/+$/, '');
  var CORE = [
    SERVER + '/on.js',
    SERVER + '/privateinit.js'
  ];

  var KNOWN = {
    'dlna.js': true,
    'tracks.js': true,
    'transcoding.js': true,
    'tmdbproxy.js': true,
    'cubproxy.js': true,
    'online.js': true,
    'watchtogether.js': true,
    'catalog.js': true,
    'dorama.js': true,
    'sisi.js': true,
    'startpage.js': true,
    'sync.js': true,
    'timecode.js': true,
    'bookmark.js': true,
    'ts.js': true,
    'backup.js': true,
    'on.js': true,
    'privateinit.js': true,
    'lampainit.js': true,
    'lampac-switch.js': true,
    'audiobook2.js': true,
    'audiobooks.js': true
  };

  var timer = setInterval(function () {
    if (typeof Lampa === 'undefined' || !Lampa.Storage || !Lampa.Plugins || !Lampa.Utils) return;
    clearInterval(timer);
    run();
  }, 200);

  function run() {
    ensureUid();
    rewritePlugins();
    loadCore();
  }

  function ensureUid() {
    var uid = Lampa.Storage.get('lampac_unic_id', '');
    if (!uid && Lampa.Utils.uid) {
      uid = Lampa.Utils.uid(8).toLowerCase();
      Lampa.Storage.set('lampac_unic_id', uid);
    }

    Lampa.Storage.set('lampac_server_url', SERVER);
    Lampa.Storage.set('lampac_switch_host', SERVER);
    Lampa.Storage.set('lampac_hot_plugins_version', '');
  }

  function pathOf(url) {
    if (!url) return '';
    var clean = String(url).split('#')[0].split('?')[0].replace(/\\/g, '/');
    var match = clean.match(/\/([^\/]+\.js)$/i);
    if (match) return match[1].toLowerCase();
    if (/^[a-z0-9_.-]+\.js$/i.test(clean)) return clean.toLowerCase();
    return '';
  }

  function rewriteUrl(url) {
    var path = pathOf(url);
    if (!path) return url;

    if (KNOWN[path])
      return SERVER + '/' + path;

    if (String(url).indexOf('/lampac-js/') !== -1) {
      var tail = String(url).split('/lampac-js/').pop().split('#')[0].split('?')[0];
      if (tail && tail.indexOf('..') === -1)
        return SERVER + '/lampac-js/' + tail;
    }

    return url;
  }

  function sameUrl(a, b) {
    return String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
  }

  function hasPlugin(list, url) {
    return list.some(function (plugin) {
      return plugin && sameUrl(plugin.url, url);
    });
  }

  function rewritePlugins() {
    var list = [];
    var changed = false;

    try { list = Lampa.Plugins.get() || []; } catch (e) { list = []; }

    list.forEach(function (plugin) {
      if (!plugin || !plugin.url) return;
      var next = rewriteUrl(plugin.url);
      if (next !== plugin.url) {
        plugin.url = next;
        changed = true;
      }
    });

    CORE.forEach(function (url) {
      if (!hasPlugin(list, url)) {
        try {
          Lampa.Plugins.add({
            url: url,
            status: 1,
            name: url.indexOf('privateinit') > -1 ? 'Lampac Profile' : 'Lampac Server',
            author: 'lampac'
          });
          changed = true;
        } catch (e) {}
      }
    });

    if (changed) {
      try { Lampa.Plugins.save(); } catch (e) {}
    }
  }

  function withBust(url) {
    return url + (url.indexOf('?') > -1 ? '&' : '?') + '_lampac_switch=' + Date.now();
  }

  function loadCore() {
    var urls = CORE.map(withBust);
    Lampa.Utils.putScript(urls, function () {
      if (Lampa.Noty && !Lampa.Storage.get('lampac_switch_notified', '')) {
        Lampa.Storage.set('lampac_switch_notified', '1');
        Lampa.Noty.show('Lampac server connected');
      }
    }, function () {}, function () {}, true);
  }
})();
