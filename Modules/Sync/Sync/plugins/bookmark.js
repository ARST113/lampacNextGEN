(function () {
  'use strict';
  if (window.lampacBookmarkSyncInitialized) return;
  window.lampacBookmarkSyncInitialized = true;
  var sync = window.LampacSync;
  var pulling = false;

  function url(path) {
    var result = '/bookmark' + path + '?profile_id=' + encodeURIComponent(sync.profile());
    if (window.lwsEvent && window.lwsEvent.connectionId)
      result += '&connectionId=' + encodeURIComponent(window.lwsEvent.connectionId);
    return result;
  }

  function ajax(method, path, body, callback) {
    return sync.request(method, url(path), body, function (status, data) {
      if (callback) callback(status, data);
      if (status === 200 && data && !data.accsdb)
        Lampa.Listener.send('lampac', {name: 'bookmark_importСompleted', value: body, path: path});
    });
  }

  function valid(data) {
    return data && typeof data === 'object' && !Array.isArray(data) && !data.accsdb && data.success !== false && !data.dbInNotInitialization;
  }

  function apply(data) {
    if (!valid(data)) return;
    Lampa.Storage.set('favorite', data, true);
    if (Lampa.Favorite.read) Lampa.Favorite.read();
    else Lampa.Favorite.init();
  }

  function seed() {
    var favorite = Lampa.Storage.get('favorite', {});
    if (typeof favorite === 'string') { try { favorite = JSON.parse(favorite) || {}; } catch (e) { favorite = {}; } }
    var result = [];
    Object.keys(favorite).forEach(function (where) {
      var data = favorite[where];
      if (data && typeof data === 'object' && Object.keys(data).length)
        result.push({where: where, data: data});
    });
    return result;
  }

  function pull() {
    if (pulling || !sync.ready()) return;
    pulling = true;
    ajax('GET', '/list', null, function (status, data) {
      if (status === 200 && data && !data.accsdb && data.dbInNotInitialization === true) {
        var initial = seed();
        if (initial.length) {
          ajax('POST', '/set', initial, function (posted, saved) {
            if (posted !== 200 || !saved || !saved.success) { pulling = false; return; }
            ajax('GET', '/list', null, function (loaded, result) {
              if (loaded === 200) apply(result);
              pulling = false;
            });
          });
          return;
        }
      } else if (status === 200) apply(data);
      pulling = false;
    });
  }

  function cardId(event) {
    if (event.card && event.card.id != null) return event.card.id;
    return event.id != null ? event.id : null;
  }

  function send(action, event) {
    if (!event || (event.card && event.card.received === true)) return;
    var id = cardId(event);
    if (id == null) return;
    var body = {where: event.where || '', card_id: id, id: id};
    if (event.card) body.card = Lampa.Utils.clearCard(Lampa.Arrays.clone(event.card));
    if (action === '/remove') body.method = event.method || 'card';
    ajax('POST', action, body);
  }

  function setFields(payload) {
    var favorite = Lampa.Storage.get('favorite', {});
    var items = Array.isArray(payload) ? payload : [payload];
    items.forEach(function (item) {
      if (!item || typeof item.where !== 'string' || !item.where || item.where === '__proto__') return;
      var data = item.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { return; } }
      favorite[item.where] = data;
    });
    apply(favorite);
  }

  Lampa.Favorite.listener.follow('add', function (event) { send('/add', event); });
  Lampa.Favorite.listener.follow('added', function (event) { send('/added', event); });
  Lampa.Favorite.listener.follow('remove', function (event) { send('/remove', event); });
  sync.onChange(function () { pulling = false; pull(); });

  document.addEventListener('lwsEvent', function (event) {
    var detail = event.detail || {};
    if (!sync.ready() || detail.uid !== sync.uid()) return;
    if (detail.name === 'system' && detail.data === 'reconnected') { pull(); return; }
    if (detail.name !== 'bookmark') return;
    try {
      var message = JSON.parse(detail.data);
      if (String(message.profile_id || '') !== sync.profile()) return;
      if (message.type === 'set') { setFields(message.data); return; }
      if (['add', 'added', 'remove'].indexOf(message.type) < 0) return;
      var items = Array.isArray(message.data) ? message.data : [message.data];
      items.forEach(function (item) {
        if (!item || !item.card || !item.where) return;
        item.card.received = true;
        Lampa.Favorite[message.type === 'remove' ? 'remove' : 'add'](item.where, item.card);
      });
    } catch (e) { /* Ignore malformed event payloads. */ }
  });

  Lampa.Listener.follow('lampac', function (event) {
    if (event.name === 'bookmark_set') { setFields(event.value); ajax('POST', '/set', event.value); }
    else if (event.name === 'bookmark_pullFromServer') pull();
  });

  var visibleAt = Date.now();
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (Date.now() - visibleAt > 600000) pull();
    visibleAt = Date.now();
  });
})();
