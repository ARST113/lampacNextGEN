(function () {
  'use strict';
  if (window.lampac_timecode_plugin) return;
  window.lampac_timecode_plugin = true;
  var sync = window.LampacSync;

  function object(value) {
    if (typeof value === 'string') { try { return JSON.parse(value) || {}; } catch (e) { return {}; } }
    return value || {};
  }

  function filename() {
    var account = object(Lampa.Storage.get('account', {}));
    var name = 'file_view' + (account.profile ? '_' + account.profile.id : '');
    if (localStorage.getItem(name) === null && account.profile)
      Lampa.Storage.set(name, Lampa.Arrays.clone(Lampa.Storage.cache('file_view', 10000, {})), true);
    return name;
  }

  function path(method) {
    var activity = object(Lampa.Storage.get('activity', {}));
    var card = activity.movie || activity.card || {};
    if (!card.id) return '';
    return '/timecode/' + method + '?card_id=' + encodeURIComponent(card.id + '_' + (card.name ? 'tv' : 'movie')) +
      '&profile_id=' + encodeURIComponent(sync.profile());
  }

  function update() {
    var url = path('all');
    if (!url || !sync.ready()) return;
    var field = filename();
    sync.request('GET', url, null, function (status, result) {
      if (status !== 200 || !result || result.accsdb) return;
      var viewed = Lampa.Storage.cache(field, 10000, {});
      Object.keys(result).forEach(function (key) {
        try {
          var road = typeof result[key] === 'string' ? JSON.parse(result[key]) : result[key];
          if (!road || !Lampa.Arrays.isObject(road)) return;
          Lampa.Arrays.extend(road, {duration: 0, time: 0, percent: 0});
          delete road.hash;
          viewed[key] = road;
        } catch (e) { /* A corrupt row must not prevent the other positions from loading. */ }
      });
      Lampa.Storage.set(field, viewed, true);
    });
  }

  Lampa.Timeline.listener.follow('update', function (event) {
    if (!event || !event.data || !event.data.hash || !event.data.road) return;
    var url = path('add');
    if (url) sync.request('POST', url, {id: event.data.hash, data: JSON.stringify(event.data.road)}, null, {form: true});
  });
  Lampa.Listener.follow('full', function (event) { if (event.type === 'complite') update(); });
  Lampa.Listener.follow('lampac', function (event) {
    if (event.name === 'timecode_pullFromServer' || event.type === 'timecode_pullFromServer') update();
  });
  sync.onChange(update);
})();
