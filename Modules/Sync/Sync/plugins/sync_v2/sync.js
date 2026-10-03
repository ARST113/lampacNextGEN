(function () {
  'use strict';
  if (window.sync_init) return;
  window.sync_init = true;
  var sync = window.LampacSync;
  var importing = {};
  var exporting = {};
  var queued = {};
  var revisions = {};
  var viewFields = ['online_view', 'online_last_balanser', 'online_watched_last',
    'torrents_view', 'torrents_filter_data', 'lampac_resume_history_v1'];

  {sync-invc}

  function importKeys() {
    var keys = [].concat(sync_invc.import_keys || [], window.lampac_storage_import_keys || []);
    return keys.filter(function (key, index) {
      return typeof key === 'string' && key && key.indexOf('lampac_sync_') !== 0 && keys.indexOf(key) === index;
    });
  }

  // The account runtime also isolates custom synchronized fields on switches.
  window.lampac_storage_import_keys = importKeys();

  function pathFor(method, path) {
    var url = '/storage/' + method + '?path=' + encodeURIComponent(path) + '&pathfile=' + encodeURIComponent(sync.profile());
    if (window.lwsEvent && window.lwsEvent.connectionId)
      url += '&connectionId=' + encodeURIComponent(window.lwsEvent.connectionId);
    return url;
  }

  function goExport(path) {
    if (window.sync_disable || !sync.ready()) return;
    if (importing[path] || exporting[path]) { queued[path] = true; return; }
    var value = {};
    if (path === 'sync_view') viewFields.forEach(function (field) { value[field] = Lampa.Storage.get(field, ''); });
    else value[path] = Lampa.Storage.get(path, '');
    value = sync_invc.goExport(path, value);
    if (!value || !Object.keys(value).length) return;
    exporting[path] = true;
    queued[path] = false;
    sync.request('POST', pathFor('set', path), value, function (status, data) {
      exporting[path] = false;
      if (data && data.success && data.fileInfo)
        Lampa.Storage.set('lampac_' + path, data.fileInfo.changeTime, true);
      if (queued[path]) goExport(path);
    });
  }

  function goImport(path, callback) {
    if (window.sync_disable || !sync.ready() || !path || importing[path]) return;
    importing[path] = true;
    var revision = revisions[path] || 0;
    sync.request('GET', pathFor('get', path), null, function (status, data) {
      importing[path] = false;
      if (data && !data.accsdb && data.success && data.fileInfo && data.data) {
        if ((revisions[path] || 0) === revision && data.fileInfo.changeTime > Number(Lampa.Storage.get('lampac_' + path, 0))) {
          try {
            var saved = JSON.parse(data.data);
            Object.keys(saved).forEach(function (field) {
              if (field.indexOf('lampac_sync_') === 0 || ['account', 'account_email', 'account_use', 'lampac_unic_id', 'lampac_profile_id', 'extensions'].indexOf(field) >= 0) return;
              Lampa.Storage.set(field, saved[field], true);
              if (field === 'favorite') Lampa.Favorite.read ? Lampa.Favorite.read(true) : Lampa.Favorite.init();
            });
            Lampa.Storage.set('lampac_' + path, data.fileInfo.changeTime, true);
          } catch (e) { /* Keep local data if a stored document is malformed. */ }
        }
      } else if (data && !data.accsdb && data.msg === 'outFile') queued[path] = true;
      if (queued[path]) goExport(path);
      if (callback) callback();
      sync_invc.importСompleted(path);
      Lampa.Listener.send('lampac', {name: 'storage_importСompleted', value: path});
    });
  }

  function pull() {
    goImport('sync_view');
    importKeys().forEach(function (key) { goImport(key); });
  }

  Lampa.Storage.listener.follow('change', function (event) {
    var path = importKeys().indexOf(event.name) >= 0 ? event.name : '';
    if (!path && (viewFields.indexOf(event.name) >= 0 || event.name.indexOf('online_view') === 0 || event.name.indexOf('torrents_view') === 0)) path = 'sync_view';
    if (!path) return;
    revisions[path] = (revisions[path] || 0) + 1;
    goExport(path);
  });

  document.addEventListener('lwsEvent', function (event) {
    var detail = event.detail || {};
    if (!sync.ready() || detail.uid !== sync.uid()) return;
    if (detail.name === 'sync_storage') goImport(detail.data);
    else if (detail.name === 'storage') {
      try {
        var data = JSON.parse(detail.data);
        if (String(data.pathfile || '') !== sync.profile()) return;
        goImport(data.path);
      } catch (e) {}
    } else if (detail.name === 'system' && detail.data === 'reconnected') pull();
  });

  sync.onChange(function () {
    importing = {}; exporting = {}; queued = {}; revisions = {};
    pull();
  });

  Lampa.Utils.putScriptAsync(['{localhost}/bookmark.js', '{localhost}/timecode.js'], function () {});
  if (!window.lampacSyncSocketInitialized)
    Lampa.Utils.putScriptAsync(['{localhost}/invc-ws.js'], function () {});
})();
