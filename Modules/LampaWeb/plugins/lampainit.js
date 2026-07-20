(function() {
  'use strict';

  window.lampac_version = { major: 0, minor: 0 };

  //localStorage.setItem('cub_mirrors', '["mirror-kurwa.men"]');

  window.lampa_settings = window.lampa_settings || {};
  window.lampa_settings.torrents_use = true;
  window.lampa_settings.demo = false;
  window.lampa_settings.read_only = false;
  window.lampa_settings.socket_use = true;
  window.lampa_settings.socket_url = undefined;
  window.lampa_settings.socket_methods = true;
  window.lampa_settings.account_use = true;
  window.lampa_settings.account_sync = true;
  window.lampa_settings.plugins_store = true;
  window.lampa_settings.feed = true;
  window.lampa_settings.iptv = false;
  window.lampa_settings.white_use = false;
  window.lampa_settings.push_state = true;
  window.lampa_settings.lang_use = true;
  window.lampa_settings.plugins_use = true;
  window.lampa_settings.dcma = false;
  window.lampa_settings.services = true;
  window.lampa_settings.youtube = true;
  window.lampa_settings.geo = true;
  window.lampa_settings.mirrors = true;

  window.lampa_settings.disable_features = window.lampa_settings.disable_features || {};
  window.lampa_settings.disable_features.dmca = true;
  window.lampa_settings.disable_features.ads = true;
  window.lampa_settings.disable_features.reactions = false;
  window.lampa_settings.disable_features.discuss = false;
  window.lampa_settings.disable_features.ai = false;
  window.lampa_settings.disable_features.install_proxy = false;
  window.lampa_settings.disable_features.subscribe = false;
  window.lampa_settings.disable_features.blacklist = false;
  window.lampa_settings.disable_features.persons = false;
  window.lampa_settings.disable_features.trailers = false;
  window.lampa_settings.disable_features.lgbt = true;

  window.lampa_settings.developer = window.lampa_settings.developer || {};

  {lampainit-invc}

  var timer = setInterval(function() {
    if (typeof Lampa !== 'undefined') {
      clearInterval(timer);

      if (lampainit_invc)
        lampainit_invc.appload();

      if ({btn_priority_forced})
        Lampa.Storage.set('full_btn_priority', '{full_btn_priority_hash}');

      var unic_id = Lampa.Storage.get('lampac_unic_id', '');
      if (!unic_id) {
        unic_id = Lampa.Utils.uid(8).toLowerCase();
        Lampa.Storage.set('lampac_unic_id', unic_id);
      }

      syncLampacPlugins();

      Lampa.Utils.putScriptAsync(["{localhost}/privateinit.js?account_email=" + encodeURIComponent(Lampa.Storage.get('account_email', '')) + "&uid=" + encodeURIComponent(Lampa.Storage.get('lampac_unic_id', ''))], function() {});

      if (window.appready) start();
      else Lampa.Listener.follow('app', function(e) { if (e.type == 'ready') start(); });

      {pirate_store}
    }
  }, 50);

  function normalizePluginUrl(url) {
    var value = String(url || '').replace(/\{localhost\}/g, location.origin);
    if (!value) return '';
    try {
      var a = document.createElement('a');
      a.href = value;
      var path = (a.pathname || '').replace(/\/+/g, '/');
      var local = !a.host || a.host == location.host || a.hostname == '127.0.0.1' || a.hostname == 'localhost';
      if (local && path) return path.toLowerCase();
      if (a.protocol && a.host) return (a.protocol + '//' + a.host + path).toLowerCase();
    }
    catch (e) {}
    return value.split('#')[0].split('?')[0].toLowerCase();
  }

  function samePluginUrl(a, b) {
    return normalizePluginUrl(a) == normalizePluginUrl(b);
  }

  function normalizePluginItem(item) {
    if (!item) return null;
    if (typeof item == 'string') item = { url: item, status: 1 };
    if (!item.url) return null;
    return item;
  }

  function syncStatus(items) {
    var map = {};
    items.forEach(function(item) {
      item = normalizePluginItem(item);
      if (!item) return;
      var key = normalizePluginUrl(item.__lampacSourceUrl || item.url);
      if (!key) return;
      if (item.status == 0 || map[key] === undefined) map[key] = item.status == 0 ? 0 : 1;
    });
    return map;
  }

  function copyPlugin(plugin, status) {
    var item = {};
    for (var key in plugin) item[key] = plugin[key];
    item.__lampacManaged = true;
    item.__lampacSourceUrl = plugin.url;
    item.url = String(plugin.url || '').replace(/\{localhost\}/g, location.origin);
    item.status = status;
    return item;
  }

  function samePluginList(a, b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!samePluginUrl(a[i].__lampacSourceUrl || a[i].url, b[i].__lampacSourceUrl || b[i].url)) return false;
      if ((a[i].status == 0 ? 0 : 1) != (b[i].status == 0 ? 0 : 1)) return false;
      if ((a[i].name || '') != (b[i].name || '')) return false;
      if ((a[i].author || '') != (b[i].author || '')) return false;
      if ((a[i].descr || '') != (b[i].descr || '')) return false;
      if ((a[i].description || '') != (b[i].description || '')) return false;
    }
    return true;
  }

  function cleanupRemovedPluginCache(allowed) {
    if (!window.caches) return;

    caches.keys().then(function(names) {
      names.forEach(function(name) {
        caches.open(name).then(function(cache) {
          cache.keys().then(function(requests) {
            requests.forEach(function(request) {
              var key = normalizePluginUrl(request.url);
              if (key && !allowed[key] && /\/(lampac-js\/uploads|plugins)\//i.test(request.url)) {
                cache.delete(request);
              }
            });
          });
        });
      });
    }).catch(function() {});
  }

  function cleanupRemovedPluginStorage(allowed) {
    var re = /(fps[-_ ]?monitor|lampa[-_ ]?fps[-_ ]?monitor|client-cache-purge)/i;

    ['localStorage', 'sessionStorage'].forEach(function(storageName) {
      var storage = window[storageName];
      if (!storage) return;
      var remove = [];
      try {
        for (var i = 0; i < storage.length; i++) {
          var key = storage.key(i);
          var value = storage.getItem(key) || '';
          if (re.test(key) || re.test(value)) remove.push(key);
        }
        remove.forEach(function(key) { try { storage.removeItem(key); } catch (e) {} });
      }
      catch (e) {}
    });

    try {
      var node = document.getElementById('lampa-fps-monitor');
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
    catch (e) {}
  }

  function syncLampacPlugins() {
    if (!Lampa.Storage || !Lampa.Storage.get || !Lampa.Storage.set) return;

    var installed = [];
    try { installed = Lampa.Storage.get('plugins', '[]') || []; } catch (e) { installed = []; }
    if (!Array.isArray(installed)) installed = [];

    installed = installed.map(normalizePluginItem).filter(Boolean);

    var server = {initiale} || [];
    if (!Array.isArray(server)) server = [];

    var status = syncStatus(installed);
    var allowed = {};
    var next = [];

    server.forEach(function(plugin) {
      plugin = normalizePluginItem(plugin);
      if (!plugin) return;

      var key = normalizePluginUrl(plugin.url);
      if (!key || allowed[key]) return;

      allowed[key] = true;

      var serverDisabled = plugin.status == 0 || plugin.status === false;
      var clientStatus = status[key];
      var targetStatus = clientStatus === 0 || clientStatus === 1 ? clientStatus : (serverDisabled ? 0 : 1);

      next.push(copyPlugin(plugin, targetStatus));
    });

    var removed = installed.some(function(plugin) {
      return !allowed[normalizePluginUrl(plugin.__lampacSourceUrl || plugin.url)];
    });

    if (!samePluginList(installed, next)) {
      Lampa.Storage.set('plugins', next);
      console.log('LampacPlugins', 'synced with admin:', {
        installed: installed.length,
        server: next.length,
        removed: removed
      });
    }

    if (removed) {
      cleanupRemovedPluginCache(allowed);
      cleanupRemovedPluginStorage(allowed);
    }
  }

  function firstRunSettings() {
    if (Lampa.Storage.get('lampac_initiale', 'false')) return false;
    Lampa.Storage.set('lampac_initiale', 'true');
    Lampa.Storage.set('source', 'cub');
    Lampa.Storage.set('video_quality_default', '2160');
    Lampa.Storage.set('full_btn_priority', '{full_btn_priority_hash}');
    Lampa.Storage.set('proxy_tmdb', '{country}' == 'RU');
    Lampa.Storage.set('poster_size', 'w300');
    Lampa.Storage.set('parser_use', 'true');
    Lampa.Storage.set('jackett_url', '{jachost}');
    Lampa.Storage.set('jackett_key', '1');
    Lampa.Storage.set('parser_torrent_type', 'jackett');
    return true;
  }

  function start() {
    {deny}
    if (lampainit_invc) lampainit_invc.appready();
    var first = firstRunSettings();
    syncLampacPlugins();
    if (first && lampainit_invc)
      lampainit_invc.first_initiale();
  }
})();
