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

  var initialized = false;
  function initializeLampac() {
    if (typeof Lampa !== 'undefined' && !initialized) {
      initialized = true;
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

      loadLampacProfilePlugins();
      syncLampacPlugins();
      installLampacPluginLoader();
      installLampacExtensions();
      loadLampacManagedPluginEarly('{localhost}/lampac-js/continuewatch-ddd.js?v=20260816-v4.0.119', 'continuewatch-ddd');

      Lampa.Utils.putScriptAsync(["{localhost}/privateinit.js?account_email=" + encodeURIComponent(Lampa.Storage.get('account_email', '')) + "&uid=" + encodeURIComponent(Lampa.Storage.get('lampac_unic_id', ''))], function() {});

      if (window.appready) start();
      else Lampa.Listener.follow('app', function(e) { if (e.type == 'ready') start(); });

      {pirate_store}
    }
  }
  var timer = setInterval(initializeLampac, 50);
  initializeLampac();

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

  function exactPluginUrl(url) {
    var value = String(url || '').replace(/\{localhost\}/g, location.origin);
    if (!value) return '';
    try {
      var a = document.createElement('a');
      a.href = value;
      var path = (a.pathname || '').replace(/\/+/g, '/');
      var prefix = a.protocol && a.host ? a.protocol + '//' + a.host : '';
      return (prefix + path + (a.search || '')).toLowerCase();
    }
    catch (e) {}
    return value.split('#')[0].toLowerCase();
  }

  function normalizePluginItem(item) {
    if (!item) return null;
    if (typeof item == 'string') item = { url: item, status: 1 };
    if (!item.url) return null;
    return item;
  }

  function copyPlugin(plugin, status, serverDisabled) {
    var item = {};
    for (var key in plugin) item[key] = plugin[key];
    item.__lampacManaged = true;
    item.__lampacSourceUrl = plugin.url;
    item.__lampacServerDisabled = serverDisabled;
    item.url = String(plugin.url || '').replace(/\{localhost\}/g, location.origin);
    item.status = status;
    return item;
  }

  function samePluginList(a, b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (exactPluginUrl(a[i].__lampacSourceUrl || a[i].url) != exactPluginUrl(b[i].__lampacSourceUrl || b[i].url)) return false;
      if ((a[i].status == 0 ? 0 : 1) != (b[i].status == 0 ? 0 : 1)) return false;
      if ((a[i].name || '') != (b[i].name || '')) return false;
      if ((a[i].author || '') != (b[i].author || '')) return false;
      if ((a[i].descr || '') != (b[i].descr || '')) return false;
      if ((a[i].description || '') != (b[i].description || '')) return false;
      if (!!a[i].__lampacManaged != !!b[i].__lampacManaged) return false;
      if (!!a[i].__lampacServerDisabled != !!b[i].__lampacServerDisabled) return false;
    }
    return true;
  }

  function cleanupRemovedPluginCache(managed, allowed, currentUrls) {
    if (!window.caches) return;

    caches.keys().then(function(names) {
      names.forEach(function(name) {
        caches.open(name).then(function(cache) {
          cache.keys().then(function(requests) {
            requests.forEach(function(request) {
              var key = normalizePluginUrl(request.url);
              var staleVersion = key && currentUrls[key] && exactPluginUrl(request.url) != currentUrls[key];
              if (key && managed[key] && (!allowed[key] || staleVersion)) {
                cache.delete(request);
              }
            });
          });
        });
      });
    }).catch(function() {});
  }

  function syncLampacPlugins() {
    if (!Lampa.Storage || !Lampa.Storage.get || !Lampa.Storage.set) return;

    var installed = [];
    try { installed = Lampa.Storage.get('plugins', '[]') || []; } catch (e) { installed = []; }
    if (!Array.isArray(installed)) installed = [];
    var normalizeNeeded = installed.some(function(item) { return !item || typeof item == 'string' || !item.url; });
    installed = installed.map(normalizePluginItem).filter(Boolean);

    var server = lampacServerPlugins();

    var preferences = lampacPreferences();
    var previousPreferences = JSON.stringify(preferences);
    var allowed = {};
    var managed = {};
    var currentUrls = {};
    var next = [];

    server = server.map(normalizePluginItem).filter(Boolean);
    server.forEach(function(plugin) {
      var key = normalizePluginUrl(plugin.url);
      if (key) allowed[key] = true;
    });

    installed.forEach(function(plugin) {
      var key = normalizePluginUrl(plugin.__lampacSourceUrl || plugin.url);
      if (!key || (!plugin.__lampacManaged && !allowed[key])) return;
      managed[key] = true;
      if (!Object.prototype.hasOwnProperty.call(preferences, key)) preferences[key] = 1;
      // A server-forced off state is not a change to the device's preference.
      if (!plugin.__lampacServerDisabled || plugin.status != 0) {
        preferences[key] = plugin.status == 0 ? 0 : 1;
      }
    });

    server.forEach(function(plugin) {
      var key = normalizePluginUrl(plugin.url);
      if (!key || currentUrls[key]) return;

      managed[key] = true;
      currentUrls[key] = exactPluginUrl(plugin.url);
      if (!Object.prototype.hasOwnProperty.call(preferences, key)) preferences[key] = 1;
      if (preferences[key] === -1) return;

      var serverDisabled = plugin.status == 0 || plugin.status === false;
      var targetStatus = serverDisabled || preferences[key] === 0 ? 0 : 1;

      next.push(copyPlugin(plugin, targetStatus, serverDisabled));
    });

    installed.forEach(function(plugin) {
      var key = normalizePluginUrl(plugin.__lampacSourceUrl || plugin.url);
      if (!plugin.__lampacManaged && !allowed[key]) next.push(plugin);
    });

    var removed = installed.some(function(plugin) {
      return plugin.__lampacManaged && !allowed[normalizePluginUrl(plugin.__lampacSourceUrl || plugin.url)];
    });
    var versionChanged = installed.some(function(plugin) {
      var source = plugin.__lampacSourceUrl || plugin.url;
      var key = normalizePluginUrl(source);
      return !!(allowed[key] && currentUrls[key] && exactPluginUrl(source) != currentUrls[key]);
    });

    if (JSON.stringify(preferences) != previousPreferences) {
      Lampa.Storage.set('lampac_plugin_preferences', preferences);
    }

    if (normalizeNeeded || !samePluginList(installed, next)) {
      Lampa.Storage.set('plugins', next);
      if (window.appready && Lampa.Plugins && Lampa.Plugins.init) Lampa.Plugins.init();
      console.log('LampacPlugins', 'synced with admin:', {
        installed: installed.length,
        server: server.length,
        removed: removed
      });
    }

    if (removed || versionChanged) {
      cleanupRemovedPluginCache(managed, allowed, currentUrls);
    }
  }

  function lampacServerPlugins() {
    var server = {initiale} || [];
    return Array.isArray(server) ? server.map(normalizePluginItem).filter(Boolean) : [];
  }

  // Профильные галочки админки: сервер отдаёт набор запрещённых для этого uid плагинов
  // (users.json -> _admin.plugins). Раньше эти галочки не читал никто, и плагин,
  // снятый у одного профиля, оставался включённым у всех.
  var lampacProfileLoading = false;
  var lampacProfileWaiters = [];

  function lampacProfileMap() {
    var map = window.lampac_profile_plugins;
    return map && typeof map === 'object' && !Array.isArray(map) ? map : null;
  }

  function loadLampacProfilePlugins(done) {
    if (window.lampac_profile_plugins_ready) { if (done) done(); return; }
    if (done) lampacProfileWaiters.push(done);
    if (lampacProfileLoading) return;
    lampacProfileLoading = true;
    var finish = function() {
      if (window.lampac_profile_plugins_ready) return;
      window.lampac_profile_plugins_ready = true;
      lampacProfileLoading = false;
      var waiters = lampacProfileWaiters.splice(0);
      waiters.forEach(function(waiter) { try { waiter(); } catch (e) {} });
    };
    var timer = setTimeout(finish, 1500);
    try {
      Lampa.Utils.putScriptAsync(["{localhost}/lampac/profile-plugins.js?uid=" + encodeURIComponent(Lampa.Storage.get('lampac_unic_id', '')) + "&account_email=" + encodeURIComponent(Lampa.Storage.get('account_email', ''))], function() { clearTimeout(timer); finish(); }, function() { clearTimeout(timer); finish(); });
    } catch (e) { clearTimeout(timer); finish(); }
  }

  function lampacPreferences() {
    var preferences = Lampa.Storage.get('lampac_plugin_preferences', '{}') || {};
    return typeof preferences == 'object' && !Array.isArray(preferences) ? preferences : {};
  }

  function installLampacPluginLoader() {
    var plugins = Lampa.Plugins;
    if (!plugins || window.lampac_plugin_loader_installed) return;
    window.lampac_plugin_loader_installed = true;
    window.lampacPluginAllowed = lampacPluginAllowed;
    var push = plugins.push;
    if (push) plugins.push = function(plugin) {
      if (lampacPluginAllowed(plugin.url)) return push.apply(this, arguments);
      if (Lampa.Noty) Lampa.Noty.show(Lampa.Lang.translate('lampac_extensions_blocked'));
    };
    var add = plugins.add;
    if (add) plugins.add = function(plugin) {
      if (plugin.status == 0 || lampacPluginAllowed(plugin.url)) return add.apply(this, arguments);
      if (Lampa.Noty) Lampa.Noty.show(Lampa.Lang.translate('lampac_extensions_blocked'));
    };
    if (window.appready || !plugins.task || !plugins.load || !plugins.awaits) return;
    var load = plugins.load;
    plugins.load = function(done) {
      plugins.load = load;
      syncLampacPlugins();
      // Native task also applies CUB preferences and the blacklist to the queue.
      // Ждём профильные галочки: иначе первый плагин проскочит до ответа сервера.
      loadLampacProfilePlugins(function() {
        plugins.task(function() {
          var pending = plugins.awaits();
          for (var i = pending.length - 1; i >= 0; i--) {
            if (!lampacPluginAllowed(pending[i])) pending.splice(i, 1);
          }
          load.call(plugins, done);
        });
      });
    };
  }

  function lampacPluginAllowed(url) {
    var key = normalizePluginUrl(url);
    var profile = lampacProfileMap();
    if (profile && Object.prototype.hasOwnProperty.call(profile, key) && profile[key] === false) return false;
    var preferences = lampacPreferences();
    var server = lampacServerPlugins().filter(function(plugin) { return normalizePluginUrl(plugin.url) == key; });
    if (server.length) return server[0].status != 0 && preferences[key] !== 0 && preferences[key] !== -1;
    // Keep ownership of removed URLs so an old CUB copy cannot reinstall them.
    return !Object.prototype.hasOwnProperty.call(preferences, key);
  }

  function installLampacExtensions() {
    if (!Lampa.Extensions || !Lampa.Extensions.listener || !Lampa.Plugins || window.lampac_extensions_installed) return;
    window.lampac_extensions_installed = true;
    Lampa.Lang.add({
      lampac_extensions_title: { ru: '\u0423\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u043d\u044b\u0435 Lampac', en: 'Installed from Lampac' },
      lampac_extensions_restore: { ru: '\u0412\u0435\u0440\u043d\u0443\u0442\u044c \u043f\u043b\u0430\u0433\u0438\u043d', en: 'Restore plugin' },
      lampac_extensions_remove: { ru: '\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u0441 \u0443\u0441\u0442\u0440\u043e\u0439\u0441\u0442\u0432\u0430', en: 'Remove from this device' },
      lampac_extensions_blocked: { ru: '\u041f\u043b\u0430\u0433\u0438\u043d \u043e\u0442\u043a\u043b\u044e\u0447\u0451\u043d \u0438\u043b\u0438 \u0443\u0434\u0430\u043b\u0451\u043d \u0432 Lampac', en: 'Plugin disabled or removed in Lampac' },
      lampac_extensions_server_off: { ru: '\u041e\u0442\u043a\u043b\u044e\u0447\u0435\u043d\u043e \u043d\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0435', en: 'Disabled on server' }
    });

    Lampa.Extensions.listener.follow('open', function(event) {
      var view = event.extensions;
      if (!view || view.__lampacRows) return;
      view.__lampacRows = true;
      var appendLine = view.appendLine;
      var add = view.add;

      function refresh() {
        view.onBack();
        Lampa.Extensions.show();
      }

      view.appendLine = function(data, params) {
        if (params.type == 'installs' && !params.lampac) {
          data = data.filter(function(plugin) { return !plugin.__lampacManaged; });
        }
        return appendLine.call(this, data, params);
      };

      view.add = function() {
        if (!this.items.some(function(line) { return line.params.lampac; })) {
          var installed = Lampa.Plugins.get().filter(function(plugin) { return plugin.__lampacManaged; });
          var preferences = lampacPreferences();
          var removed = lampacServerPlugins().filter(function(plugin) {
            return preferences[normalizePluginUrl(plugin.url)] === -1;
          });
          if (installed.length || removed.length) {
            appendLine.call(this, installed, {
              title: Lampa.Lang.translate('lampac_extensions_title'),
              type: 'installs', autocheck: true, noedit: true, lampac: true
            });
            var line = this.items.pop();
            var position = 1;
            this.items.forEach(function(item, index) {
              if (item.params.type == 'plugins' && item.params.cub) position = index + 1;
            });
            var before = this.items[position];
            this.items.splice(position, 0, line);
            this.scroll.body(true).insertBefore(line.render(), before ? before.render() : null);

            var append = line.append;
            line.append = function(data) {
              append.call(this, data);
              decorateLampacCard(this.items[this.items.length - 1], refresh);
            };
            if (removed.length) {
              var restore = document.createElement('div');
              restore.className = 'extensions__block-add selector';
              restore.textContent = Lampa.Lang.translate('lampac_extensions_restore');
              restore.addEventListener('hover:enter', function() {
                var controller = Lampa.Controller.enabled().name;
                Lampa.Select.show({
                  title: Lampa.Lang.translate('lampac_extensions_restore'),
                  items: removed.map(function(plugin) { return { title: plugin.name || plugin.url, plugin: plugin }; }),
                  onBack: function() { Lampa.Controller.toggle(controller); },
                  onSelect: function(choice) {
                    var plugin = choice.plugin;
                    var disabled = plugin.status == 0 || plugin.status === false;
                    rememberLampacPreference(plugin.url, 1);
                    Lampa.Plugins.add(copyPlugin(plugin, disabled ? 0 : 1, disabled));
                    refresh();
                  }
                });
              });
              line.scroll.body(true).appendChild(restore);
            }
          }
        }
        return add.apply(this, arguments);
      };

      // Cached catalog responses can finish before the native "open" event.
      if (view.items.length) {
        var rows = view.items.map(function(line) { return { data: line.data, params: line.params }; });
        view.items.forEach(function(line) { line.destroy(); });
        view.items = [];
        view.active = 0;
        rows.forEach(function(row) { view.appendLine(row.data, row.params); });
        view.add();
        view.items.slice(0, 3).forEach(function(line) { line.display(); });
        Lampa.Layer.visible(view.render());
        view.toggle();
      }
    });
  }

  function rememberLampacPreference(url, status) {
    var preferences = lampacPreferences();
    preferences[normalizePluginUrl(url)] = status;
    Lampa.Storage.set('lampac_plugin_preferences', preferences);
  }

  function lampacReload(back) {
    var message = document.createElement('div');
    message.className = 'about';
    message.textContent = Lampa.Lang.translate('plugins_need_reload');
    Lampa.Modal.open({
      title: '', align: 'center', zIndex: 300, html: $(message),
      buttons: [
        { name: Lampa.Lang.translate('settings_param_no'), onSelect: function() { Lampa.Modal.close(); back(); } },
        { name: Lampa.Lang.translate('settings_param_yes'), onSelect: function() { window.location.reload(); } }
      ],
      onBack: function() { Lampa.Modal.close(); back(); }
    });
  }

  function decorateLampacCard(item, refresh) {
    var update = item.update;
    item.update = function() {
      update.call(this);
      var html = this.render();
      if (!html.querySelector('.lampac-plugin-badge')) {
        var badge = document.createElement('div');
        badge.className = 'extensions__cub lampac-plugin-badge';
        badge.textContent = 'LAMPAC';
        html.appendChild(badge);
      }
      if (this.data.__lampacServerDisabled) {
        var status = html.querySelector('.extensions__item-disabled');
        if (status) {
          status.textContent = Lampa.Lang.translate('lampac_extensions_server_off');
          status.classList.remove('hide');
        }
      }
    };
    item.menu = function() {
      if (this.removed) return;
      var controller = Lampa.Controller.enabled().name;
      var back = function() { Lampa.Controller.toggle(controller); };
      var menu = [];
      if (!this.data.__lampacServerDisabled) {
        menu.push({ title: Lampa.Lang.translate('extensions_' + (this.data.status ? 'disable' : 'enable')), toggle: true });
      }
      menu.push({ title: Lampa.Lang.translate('extensions_check'), status: true });
      menu.push({ title: Lampa.Lang.translate('lampac_extensions_remove'), remove: true });
      Lampa.Select.show({
        title: this.data.name || Lampa.Lang.translate('title_action'),
        items: menu, onBack: back,
        onSelect: function(action) {
          var source = item.data.__lampacSourceUrl || item.data.url;
          if (action.toggle) {
            item.data.status = item.data.status == 1 ? 0 : 1;
            rememberLampacPreference(source, item.data.status);
            Lampa.Plugins.save(item.data);
            item.update();
            if (item.data.status) { back(); Lampa.Plugins.push(item.data); }
            else lampacReload(back);
          }
          else if (action.remove) {
            rememberLampacPreference(source, -1);
            Lampa.Plugins.remove(item.data);
            item.removed = true;
            item.render().style.opacity = 0.5;
            lampacReload(refresh);
          }
          else if (action.status) { back(); item.check(); }
        }
      });
    };
  }

  function loadLampacManagedPluginEarly(url, marker) {
    var installed = [];
    try { installed = Lampa.Storage.get('plugins', '[]') || []; } catch (e) { installed = []; }
    if (!Array.isArray(installed)) return;

    var enabled = installed.some(function(plugin) {
      plugin = normalizePluginItem(plugin);
      return plugin && samePluginUrl(plugin.__lampacSourceUrl || plugin.url, url) && plugin.status != 0;
    });
    if (!enabled) return;

    var id = 'lampac-early-' + marker;
    if (document.getElementById(id)) return;

    var script = document.createElement('script');
    script.id = id;
    script.async = true;
    script.src = String(url || '').replace(/\{localhost\}/g, location.origin);
    (document.head || document.documentElement).appendChild(script);
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
    if (Lampa.Plugins && Lampa.Plugins.init) Lampa.Plugins.init();
    if (first && lampainit_invc)
      lampainit_invc.first_initiale();
  }
})();
