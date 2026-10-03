(function () {
  'use strict';

  if (!window.LampacSync) {
    var storage = Lampa.Storage;
    var server = '';
    var scriptToken = '';
    var selectedToken = '';
    var selectedId = '';
    var selectedUid = '';
    var selectedProfile = '';
    var selectedSource = 'login';
    var connected = false;
    var generation = 0;
    var validationId = 0;
    var validation = null;
    var activeRequests = [];
    var subscribers = [];
    var state = 'checking';
    var lastSuccess = 0;
    var settingsAdded = false;
    var passwordItem;
    var statusItem;
    var passwordKey = 'lampac_sync_id';
    var ownerKey = 'lampac_sync_owner_v1';
    var cacheKey = 'lampac_sync_accounts_v1';
    var syncFields = ['online_view', 'online_last_balanser', 'online_watched_last',
      'torrents_view', 'torrents_filter_data', 'lampac_resume_history_v1',
      'lampac_resume_history_cache_v1', 'favorite', 'file_view'];

    function text(value) {
      return value == null ? '' : String(value).replace(/^\s+|\s+$/g, '');
    }

    function object(value) {
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch (e) { return {}; }
      }
      return value && typeof value === 'object' ? value : {};
    }

    function copy(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function persist(key, value) {
      // Lampa.Storage.set can swallow quota errors and defer to IndexedDB.
      // Ownership changes require a durable copy before replacing history.
      localStorage.setItem(key, value && typeof value === 'object' ? JSON.stringify(value) : String(value));
      storage.set(key, value, true);
    }

    function profile() {
      return text(storage.get('lampac_profile_id', ''));
    }

    function automaticPassword() {
      var account = object(storage.get('account', {}));
      return text(storage.get('account_email', '')) || text(account.email) || scriptToken ||
        text(storage.get('lampac_unic_id', ''));
    }

    function timelineKey() {
      var account = object(storage.get('account', {}));
      return 'file_view' + (account.profile ? '_' + account.profile.id : '');
    }

    function fields() {
      var result = syncFields.concat([timelineKey()]);
      var extra = window.lampac_storage_import_keys;
      if (Array.isArray(extra)) result = result.concat(extra);
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && key.indexOf('file_view_') === 0) result.push(key);
      }
      return result.filter(function (key, index) {
        return typeof key === 'string' && key && key.indexOf('lampac_sync_') !== 0 && result.indexOf(key) === index;
      });
    }

    function defaultValue(key) {
      if (key === 'lampac_resume_history_v1' || key === 'lampac_resume_history_cache_v1')
        return {schema: 1, cards: {}};
      if (key === 'online_view' || key === 'torrents_view') return [];
      return {};
    }

    function namespace(uid, userProfile) {
      return server.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase() + '|' + uid + '|' + userProfile;
    }

    function localSnapshot() {
      var saved = {values: {}, markers: {}};
      fields().forEach(function (key) {
        saved.values[key] = copy(storage.get(key, defaultValue(key)));
      });
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key === 'lampac_sync_view' || (key && fields().some(function (field) { return key === 'lampac_' + field; })))
          saved.markers[key] = storage.get(key, 0);
      }
      return saved;
    }

    function restoreSnapshot(saved) {
      saved = saved || {values: {}, markers: {}};
      fields().forEach(function (key) {
        var value = Object.prototype.hasOwnProperty.call(saved.values, key) ? saved.values[key] : defaultValue(key);
        persist(key, copy(value));
      });
      var markers = ['lampac_sync_view'];
      fields().forEach(function (key) { markers.push('lampac_' + key); });
      markers.forEach(function (key) { persist(key, saved.markers[key] || 0); });
      if (Lampa.Favorite && Lampa.Favorite.read) Lampa.Favorite.read(true);
      else if (Lampa.Favorite && Lampa.Favorite.init) Lampa.Favorite.init();
    }

    function releaseRequests() {
      generation++;
      var pending = activeRequests;
      activeRequests = [];
      pending.forEach(function (xhr) { try { xhr.abort(); } catch (e) {} });
    }

    function updateSettings() {
      if (passwordItem) passwordItem.find('.settings-param__value').text(selectedSource === 'manual' ? 'Свой ID: ' + selectedId : 'Базовый ID: ' + (selectedUid || 'из входа'));
      if (statusItem) {
        var captions = {checking: 'Проверка подключения…', connected: 'Подключено', offline: 'Сервер недоступен', error: 'Проверьте вход в Lampac', unconfigured: 'Войдите в Lampac'};
        var caption = captions[state] || captions.error;
        if (lastSuccess && state === 'connected') caption += ' · ' + new Date(lastSuccess).toLocaleTimeString();
        statusItem.find('.settings-param__value').text(caption);
      }
    }

    function notify(reason, changed) {
      updateSettings();
      var event = {reason: reason, changed: !!changed, epoch: generation, user_uid: selectedUid, profile: selectedProfile};
      subscribers.slice().forEach(function (callback) { try { callback(event); } catch (e) {} });
    }

    function endpoint(path, token, id) {
      var url = Lampa.Utils.addUrlComponent(server + path, 'token=' + encodeURIComponent(token));
      if (id) url = Lampa.Utils.addUrlComponent(url, 'sync_id=' + encodeURIComponent(id));
      return url;
    }

    function rawRequest(method, url, body, callback, options) {
      options = options || {};
      var xhr = new XMLHttpRequest();
      var finished = false;
      function finish(status, data) {
        if (finished) return;
        finished = true;
        callback(status, data);
      }
      xhr.open(method, url, true);
      xhr.timeout = 15000;
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        var response;
        try { response = JSON.parse(xhr.responseText); } catch (e) { response = null; }
        finish(xhr.status, response);
      };
      xhr.onerror = xhr.ontimeout = function () { finish(0, null); };
      var payload = null;
      if (body != null) {
        if (options.form) {
          xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
          payload = Object.keys(body).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(body[key]); }).join('&');
        } else {
          xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
          payload = JSON.stringify(body);
        }
      }
      xhr.send(payload);
      return xhr;
    }

    function request(method, path, body, callback, options) {
      if (!connected) return null;
      var epoch = generation;
      var xhr = rawRequest(method, endpoint(path, selectedToken, selectedId), body, function (status, data) {
        var index = activeRequests.indexOf(xhr);
        if (index >= 0) activeRequests.splice(index, 1);
        if (epoch !== generation || !connected) return;
        if (status >= 200 && status < 300 && data && !data.accsdb) {
          state = 'connected';
          lastSuccess = Date.now();
        } else state = status ? 'error' : 'offline';
        updateSettings();
        if (callback) callback(status, data);
      }, options);
      activeRequests.push(xhr);
      return xhr;
    }

    function commit(password, source, uid, userProfile, reason, loginToken, legacyUid) {
      var oldOwner = text(storage.get(ownerKey, ''));
      var previousOwner = oldOwner || (legacyUid ? namespace(legacyUid, userProfile) : '');
      var newOwner = namespace(uid, userProfile);
      var changed = previousOwner && previousOwner !== newOwner;
      var cache = object(storage.get(cacheKey, {version: 1, owners: {}}));
      cache.version = 1;
      cache.owners = object(cache.owners);
      var oldVisible = changed ? localSnapshot() : null;
      var oldPassword = storage.get(passwordKey, '');
      var oldCub = storage.get('account_use', false);
      if (changed) {
        cache.owners[previousOwner] = oldVisible;
        // Persist the old owner's copy before replacing any visible data.
        persist(cacheKey, cache);
      }
      try {
        if (changed) restoreSnapshot(cache.owners[newOwner]);
        persist(passwordKey, source === 'manual' ? password : '');
        persist(ownerKey, newOwner);
        // Select one sync provider; retain the user's CUB account and playback login.
        persist('account_use', false);
      } catch (error) {
        if (oldVisible) restoreSnapshot(oldVisible);
        persist(passwordKey, oldPassword);
        persist(ownerKey, oldOwner);
        persist('account_use', oldCub);
        throw error;
      }
      releaseRequests();
      selectedToken = loginToken;
      selectedId = source === 'manual' ? password : '';
      selectedUid = uid;
      selectedProfile = userProfile;
      selectedSource = source;
      connected = true;
      state = 'connected';
      notify(reason, changed);
      if (Lampa.Listener) Lampa.Listener.send('lampac', {name: 'storage_importСompleted', value: 'sync_view'});
    }

    function validate(password, source, callback, reason) {
      password = text(password);
      var checkId = ++validationId;
      if (validation) { try { validation.abort(); } catch (e) {} }
      if (!password || (source === 'manual' && (password.length > 128 || /[\x00-\x1f\x7f-\x9f]/.test(password)))) {
        state = connected ? 'connected' : 'unconfigured';
        updateSettings();
        if (callback) callback('Введите ID синхронизации: от 1 до 128 символов');
        return;
      }
      var loginToken = automaticPassword();
      var userProfile = profile();
      var checkServer = server;
      state = 'checking';
      updateSettings();
      function validationError(status, data) {
        if (status < 200 || status >= 300 || !data) return 'Не удалось подключиться к серверу Lampac';
        if (data.accsdb || data.success !== true || !text(data.user_uid)) return 'Проверьте пароль входа в Lampac';
        return '';
      }
      function complete(status, data, legacyUid) {
        if (checkId !== validationId || checkServer !== server) return;
        validation = null;
        var error = validationError(status, data);
        if (!error) {
          try { commit(password, source, text(data.user_uid), userProfile, reason, loginToken, legacyUid); }
          catch (e) { error = 'Не удалось сохранить настройки синхронизации'; }
        }
        if (error) {
          state = connected ? 'connected' : (status ? 'error' : 'offline');
          updateSettings();
        }
        if (callback) callback(error || null);
      }
      function check(legacyUid) {
        validation = rawRequest('GET', endpoint('/sync/account', loginToken, source === 'manual' ? password : ''), null, function (status, data) {
          complete(status, data, legacyUid);
        });
      }
      if (reason === 'manual' && !text(storage.get(ownerKey, ''))) {
        // A user can edit the ID before startup validation returns. Identify the
        // basic owner first, so its legacy history remains reachable on reset.
        validation = rawRequest('GET', endpoint('/sync/account', loginToken, ''), null, function (status, data) {
          if (checkId !== validationId || checkServer !== server) return;
          if (validationError(status, data)) complete(status, data);
          else check(text(data.user_uid));
        });
      } else check('');
    }

    function setPassword(password, callback) {
      validate(password, 'manual', callback, 'manual');
    }

    function useLogin(callback) {
      validate(automaticPassword(), 'login', callback, 'login');
    }

    function checkSelected(reason) {
      var manual = text(storage.get(passwordKey, ''));
      validate(manual || automaticPassword(), manual ? 'manual' : 'login', null, reason);
    }

    function refresh() {
      checkSelected('refresh');
    }

    function status() {
      return {state: state, source: selectedSource, last_sync: lastSuccess};
    }

    function notice(error) {
      if (Lampa.Noty) Lampa.Noty.show(error || 'Синхронизация Lampac подключена');
    }

    function valueItem(item) {
      item.addClass('lampac-sync-setting');
      if (!item.find('.settings-param__value').length) item.append('<div class="settings-param__value"></div>');
      return item;
    }

    function addSettings() {
      if (settingsAdded || !Lampa.SettingsApi) return;
      settingsAdded = true;
      Lampa.SettingsApi.addParam({component: 'account', param: {type: 'title'},
        field: {name: 'Синхронизация Lampac'},
        onRender: function (item) { item.addClass('lampac-sync-setting'); }});
      Lampa.SettingsApi.addParam({component: 'account', param: {type: 'button', name: 'lampac_sync_password_action'},
        field: {name: 'ID синхронизации', description: 'Базовый ID берётся из входа в Lampac. Можно задать любой общий код для ваших устройств. Синхронизация CUB отключается.'},
        onRender: function (item) { passwordItem = valueItem(item); updateSettings(); },
        onChange: function () {
          Lampa.Input.edit({free: true, title: 'Свой ID синхронизации Lampac', value: '', nosave: true, nomic: true}, function (value) {
            Lampa.Controller.toggle('settings_component');
            if (text(value)) setPassword(value, notice);
          });
        }});
      Lampa.SettingsApi.addParam({component: 'account', param: {type: 'button', name: 'lampac_sync_login_action'},
        field: {name: 'Использовать базовый ID', description: 'Автоматически использовать ID из входа в Lampac.'},
        onRender: function (item) { item.addClass('lampac-sync-setting'); },
        onChange: function () { useLogin(notice); }});
      Lampa.SettingsApi.addParam({component: 'account', param: {type: 'button', name: 'lampac_sync_refresh_action'},
        field: {name: 'Синхронизировать сейчас'},
        onRender: function (item) { item.addClass('lampac-sync-setting'); }, onChange: refresh});
      Lampa.SettingsApi.addParam({component: 'account', param: {type: 'button', name: 'lampac_sync_status'},
        field: {name: 'Состояние подключения'},
        onRender: function (item) { statusItem = valueItem(item); updateSettings(); }, onChange: refresh});
      if (Lampa.Settings && Lampa.Settings.listener) Lampa.Settings.listener.follow('open', function (event) {
        if (event.name !== 'account' || !event.body) return;
        var items = event.body.find('.lampac-sync-setting');
        if (items.length) items.first().parent().prepend(items.detach());
        event.body.find('[data-name="account_use"] .settings-param__name').text('Синхронизация CUB');
      });
    }

    window.LampacSync = {
      configure: function (host, token) {
        host = text(host).replace(/\/+$/, '');
        try { token = decodeURIComponent((token || '').replace(/\+/g, ' ')); } catch (e) { token = ''; }
        var first = !server;
        var hostChanged = server && server !== host;
        var tokenChanged = token && token !== scriptToken;
        server = host;
        if (token) scriptToken = text(token);
        if (first) {
          if (!storage.get('lampac_unic_id', '')) storage.set('lampac_unic_id', Lampa.Utils.uid(8).toLowerCase(), true);
          selectedSource = text(storage.get(passwordKey, '')) ? 'manual' : 'login';
          addSettings();
          storage.listener.follow('change', function (event) {
            if (event.name === 'lampac_profile_id') {
              connected = false;
              releaseRequests();
              checkSelected('profile');
            } else if (event.name === 'account_email' || event.name === 'account' || event.name === 'lampac_unic_id') {
              if (automaticPassword() !== selectedToken) {
                connected = false;
                releaseRequests();
                checkSelected('login');
              }
            }
          });
          checkSelected('startup');
        } else if (hostChanged || (tokenChanged && automaticPassword() !== selectedToken)) {
          connected = false;
          releaseRequests();
          checkSelected('configuration');
        }
      },
      request: request,
      setPassword: setPassword,
      setId: setPassword,
      useLogin: useLogin,
      useBaseId: useLogin,
      refresh: refresh,
      ready: function () { return connected; },
      epoch: function () { return generation; },
      uid: function () { return selectedUid; },
      profile: function () { return selectedProfile; },
      status: status,
      onChange: function (callback) {
        subscribers.push(callback);
        if (connected) callback({reason: 'ready', changed: false, epoch: generation, user_uid: selectedUid, profile: selectedProfile});
      }
    };
  }

  window.LampacSync.configure('{localhost}', '{token}');
})();
