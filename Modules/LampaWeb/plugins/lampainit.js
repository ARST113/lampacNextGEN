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

      Lampa.Utils.putScriptAsync(["{localhost}/privateinit.js?account_email=" + encodeURIComponent(Lampa.Storage.get('account_email', '')) + "&uid=" + encodeURIComponent(Lampa.Storage.get('lampac_unic_id', ''))], function() {});

      if (window.appready) start();
      else Lampa.Listener.follow('app', function(e) { if (e.type == 'ready') start(); });

      {pirate_store}
    }
  }, 200);

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

  function pluginLoadUrl(url) {
    var value = String(url || '').replace(/\{localhost\}/g, location.origin);
    if (!value) return value;
    var key = window.__lampacPluginCacheKey;
    if (!key) {
      key = String(Date.now());
      window.__lampacPluginCacheKey = key;
    }
    value = value.replace(/([?&])lampac_cache=[^&]*/g, '$1').replace(/[?&]$/, '');
    return value + (value.indexOf('?') >= 0 ? '&' : '?') + 'lampac_cache=' + encodeURIComponent(key);
  }

  function samePluginUrl(a, b) {
    return normalizePluginUrl(a) == normalizePluginUrl(b);
  }

  function findPlugin(list, url) {
    var first = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && samePluginUrl(list[i].__lampacSourceUrl || list[i].url, url)) {
        if (!first) first = list[i];
        if (list[i].status == 0) return list[i];
      }
    }
    return first;
  }

  function syncLampacPlugins() {
    if (!Lampa.Plugins || !Lampa.Plugins.get || !Lampa.Plugins.add) return;
    var installed = [];
    try { installed = Lampa.Plugins.get() || []; } catch (e) { installed = []; }
    var server = {initiale} || [];
    var changed = false;
    var load = [];

    server.forEach(function(plugin) {
      if (!plugin || !plugin.url) return;
      var existing = findPlugin(installed, plugin.url);
      var serverDisabled = plugin.status == 0 || plugin.status === false;
      if (existing) {
        var clientHasStatus = existing.status == 0 || existing.status == 1;
        existing.name = plugin.name || existing.name;
        existing.author = plugin.author || existing.author;
        existing.descr = plugin.descr || existing.descr;
        existing.description = plugin.description || existing.description;
        existing.__lampacManaged = true;
        existing.__lampacSourceUrl = plugin.url;
        existing.url = String(plugin.url || '').replace(/\\{localhost\\}/g, location.origin);
        existing.status = clientHasStatus ? existing.status : (serverDisabled ? 0 : 1);
        changed = true;
        if (existing.status == 1) load.push(pluginLoadUrl(plugin.url));
      }
      else {
        var item = {};
        for (var key in plugin) item[key] = plugin[key];
        item.__lampacManaged = true;
        item.__lampacSourceUrl = plugin.url;
        item.url = String(plugin.url || '').replace(/\\{localhost\\}/g, location.origin);
        item.status = serverDisabled ? 0 : 1;
        Lampa.Plugins.add(item);
        changed = true;
        if (item.status == 1) load.push(pluginLoadUrl(plugin.url));
      }
    });

    if (changed && Lampa.Plugins.save) {
      try { Lampa.Plugins.save(); } catch (e) {}
    }
    if (load.length && Lampa.Utils && Lampa.Utils.putScript) {
      Lampa.Utils.putScript(load, function() {}, function() {}, function() {}, true);
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
