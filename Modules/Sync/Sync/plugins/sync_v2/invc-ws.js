(function () {
  'use strict';
  if (window.lampacSyncSocketInitialized) return;
  window.lampacSyncSocketInitialized = true;
  var sync = window.LampacSync;
  var client = null;
  var started = false;
  var epoch = 0;
  window.lwsEvent = {uid: '', connectionId: '', init: false};

  function dispatch(name, data, uid) {
    var event = document.createEvent('CustomEvent');
    event.initCustomEvent('lwsEvent', true, true, {uid: uid, name: name, data: data});
    document.dispatchEvent(event);
  }

  window.lwsEvent.send = function (name, data) {
    if (sync.ready() && client && epoch === sync.epoch()) client.invoke('events', sync.uid(), name, data);
  };
  window.lwsEvent.sendId = function (connectionId, name, data) {
    if (sync.ready() && client && epoch === sync.epoch()) client.invoke('eventsId', connectionId, sync.uid(), name, data);
  };

  function connect() {
    if (!sync.ready()) return;
    if (client) client.close();
    epoch = sync.epoch();
    var currentEpoch = epoch;
    var uid = sync.uid();
    var current = new NativeWsClient('{localhost}/nws'.replace(/^http/, 'ws'), {autoReconnect: true});
    // NativeWsClient defaults to the same device ID used by online playback.
    // Lampac closes an earlier socket with that ID, so give sync its own ID.
    var socketId = 'sync-' + Lampa.Utils.uid(32).toLowerCase() + '-' + currentEpoch;
    if (/[?&]id=/.test(current.url)) current.url = current.url.replace(/([?&])id=[^&]*/, '$1id=' + encodeURIComponent(socketId));
    else current.url = Lampa.Utils.addUrlComponent(current.url, 'id=' + encodeURIComponent(socketId));
    client = current;
    // Sync owns this socket. Do not close or replace window.nwsClient's playback socket.
    window.lampacSyncSocket = current;
    window.lwsEvent.uid = uid;
    window.lwsEvent.connectionId = '';
    window.lwsEvent.init = true;
    window.lwsEvent.uid = j.user_uid;
    if (typeof NativeWsClient == 'undefined') {
        Lampa.Utils.putScript(["{localhost}/js/nws-client-es5.js?v21042026"], function() {}, false, function() {
        waitEvent();
      }, true);
    } else waitEvent();
  }
  
  
  if (!window.lwsEvent.init) {
    if (!window.reqinfo) {
      var network = new Lampa.Reguest();
      network.silent(account('{localhost}/reqinfo'), function(j) {
        if (j.user_uid)
          start(j);
      });
    } 
    else
      start(window.reqinfo);
  }

  sync.onChange(function () {
    if (typeof NativeWsClient !== 'undefined') connect();
    else if (!started) {
      started = true;
      Lampa.Utils.putScriptAsync(['{localhost}/js/nws-client-es5.js?v21042026'], function () {
        started = false;
        if (typeof NativeWsClient !== 'undefined') connect();
      });
    }
  });
})();
