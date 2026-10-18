/* NAV-PROBE v5 — диагностика перезагрузок страницы (10.10–11.10.2026).
   Маячок в nginx-лог при загрузке, уходе/возврате в фон и при выгрузке документа.
   В localStorage лежит «последнее состояние» документа, поэтому следующая страница
   сообщает: прошлый документ попрощался (pf=bye) или его убили (pf=kill), сколько он
   прожил (pup), сколько был в фоне (php), и был ли это тот же WebView (psame). */
(function () {
  try {
    var d = document, w = window;
    var nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || null;
    var ntype = nav ? nav.type : 'na';
    var birth = Math.round(performance.timeOrigin || Date.now());
    var sid = '', n = 0;
    try {
      sid = sessionStorage.getItem('__np2') || '';
      if (!sid) { sid = Math.random().toString(36).slice(2, 8); sessionStorage.setItem('__np2', sid); }
      n = (parseInt(sessionStorage.getItem('__npn2') || '0', 10) || 0) + 1;
      sessionStorage.setItem('__npn2', String(n));
    } catch (e) {}
    var KEY = '__nplast2', prev = null;
    try { prev = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { prev = null; }
    var pid = Math.random().toString(36).slice(2, 6);
    var ua = navigator.userAgent || '';
    var tag = /Electron/.test(ua) ? 'el'
            : (/YaBrowser/.test(ua) ? 'ya'
            : (/Android/.test(ua) ? 'an' : 'ot'));
    var hidStart = 0, hidTotal = 0, saidBye = 0;

    function b64(s) {
      try {
        return btoa(unescape(encodeURIComponent(s)))
          .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
      } catch (e) { return 'x'; }
    }

    function send(ev, extra) {
      try {
        var p = { e: ev, t: ntype, b: birth, s: sid, n: n, p: pid, g: tag,
                  u: (location.pathname || '').slice(0, 24), f: (location.hash || '').slice(0, 24) };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) p[k] = extra[k]; } }
        var url = '/lampac-js/uploads/nav-probe/b-' + b64(JSON.stringify(p)) + '.gif';
        if (navigator.sendBeacon) { navigator.sendBeacon(url); }
        else { var im = new Image(); im.src = url; }
      } catch (e) {}
    }

    function state() {
      var st = { v: 0, pl: 0, lp: 0, ls: 0 };
      try {
        var vs = d.querySelectorAll('video');
        st.v = vs.length;
        for (var i = 0; i < vs.length; i++) {
          if (!vs[i].paused && vs[i].currentTime > 0) { st.pl = 1; break; }
        }
      } catch (e) {}
      try {
        st.lp = (w.Lampa && w.Lampa.Player && typeof w.Lampa.Player.opened === 'function'
                 && w.Lampa.Player.opened()) ? 1 : 0;
      } catch (e) {}
      try {
        var tc = localStorage.getItem('player_timecode');
        st.ls = tc ? 1 : 0;
      } catch (e) {}
      return st;
    }

    function note(bye) {
      if (bye) saidBye = 1;
      var st = state();
      var hp = hidTotal + (hidStart ? Date.now() - hidStart : 0);
      try {
        localStorage.setItem(KEY, JSON.stringify({
          t: Date.now(), b: birth, s: sid, n: n, up: Math.round(performance.now()),
          vis: d.visibilityState, bye: (bye || saidBye) ? 1 : 0, hp: Math.round(hp),
          pl: st.pl, lp: st.lp, v: st.v, nt: ntype, u: (location.pathname || '').slice(0, 24)
        }));
      } catch (e) {}
      return st;
    }

    function prevInfo() {
      var o = {};
      if (!prev || !prev.t) return o;
      o.pf = prev.bye ? 'bye' : 'kill';
      o.pg = Math.max(0, birth - prev.t);
      o.pup = prev.up || 0; o.pn = prev.n || 0; o.ps = prev.s || '';
      o.pv = prev.vis || ''; o.php = prev.hp || 0; o.ppl = prev.pl || 0;
      o.psame = (prev.s && prev.s === sid) ? 1 : 0;
      o.pu = prev.u || '';
      return o;
    }

    function withPrev(base) {
      var o = prevInfo();
      for (var k in base) { if (base.hasOwnProperty(k)) o[k] = base[k]; }
      return o;
    }

    note(0);
    send('ld', withPrev({ up: 0, rdy: (w.Lampa && w.Lampa.Utils) ? 1 : 0 }));

    d.addEventListener('visibilitychange', function () {
      var st;
      if (d.visibilityState === 'hidden') { hidStart = Date.now(); st = note(0); st.up = Math.round(performance.now()); st.vis = 'hidden'; send('vs', st); }
      else { if (hidStart) { hidTotal += Date.now() - hidStart; hidStart = 0; } st = note(0); st.up = Math.round(performance.now()); st.vis = 'visible'; send('vs', st); }
    }, false);

    w.addEventListener('pagehide', function (e) {
      var st = note(1); st.ps = e.persisted ? 1 : 0; st.up = Math.round(performance.now()); st.vis = 'gone'; send('ph', st);
    }, false);

    w.addEventListener('beforeunload', function () {
      var st = note(1); st.up = Math.round(performance.now()); st.vis = 'gone'; send('bu', st);
    }, false);


    /* ---- v3: ловим переинициализацию интерфейса Lampa без перезагрузки документа ---- */
    var appEv = 0, plInit = 0, actRestart = 0, hooked = 0, hookTimer = 0;

    function hookLampa() {
      try {
        if (!w.Lampa) return;
        var L = w.Lampa;
        if (L.Listener && L.Listener.follow) {
          try {
            L.Listener.follow('app', function (e) {
              appEv++;
              send('app', { st: (e && e.type) || '?', c: appEv, up: Math.round(performance.now()) });
            });
          } catch (e) {}
        }
        if (L.Plugins && typeof L.Plugins.init === 'function' && !L.Plugins.__npPatched) {
          var origInit = L.Plugins.init;
          L.Plugins.init = function () {
            plInit++;
            send('pinit', { c: plInit, up: Math.round(performance.now()) });
            return origInit.apply(this, arguments);
          };
          L.Plugins.__npPatched = 1;
        }
        if (L.Activity && typeof L.Activity.restart === 'function' && !L.Activity.__npPatched) {
          var origRestart = L.Activity.restart;
          L.Activity.restart = function () {
            actRestart++;
            send('arestart', { c: actRestart, up: Math.round(performance.now()) });
            return origRestart.apply(this, arguments);
          };
          L.Activity.__npPatched = 1;
        }
        if (L.Plugins && L.Listener) {
          hooked = 1;
          if (hookTimer) { clearInterval(hookTimer); hookTimer = 0; }
        }
      } catch (e) {}
    }
    hookTimer = setInterval(hookLampa, 300);
    hookLampa();

    try {
      if (w.navigation && w.navigation.addEventListener) {
        w.navigation.addEventListener('navigate', function (ev) {
          try {
            send('nav', { nt2: ev.navigationType, can: ev.canIntercept ? 1 : 0,
                          dest: String((ev.destination && ev.destination.url) || '').slice(0, 80) });
          } catch (e) {}
        });
      }
    } catch (e) {}



    function shortStack(skip) {
      var out = [];
      try {
        var lines = String((new Error()).stack || '').split('\n');
        for (var i = skip; i < lines.length; i++) {
          var l = lines[i].replace(/^\s*at\s+/, '');
          l = l.replace(/https?:\/\/[^\/]+\//g, '').replace(/\?[^:)]*/g, '').replace(/\s+/g, ' ');
          if (!l) continue;
          out.push(l.slice(0, 80));
          if (out.length >= 9) break;
        }
      } catch (e) {}
      return out.join(' <- ');
    }

    /* ---- v4/v5: кто именно уводит интерфейс на «Главную» (короткий стек вызова) ---- */
    var lstCount = 0;
    try {
      var L2 = w.Lampa;
      if (L2 && L2.Listener && L2.Listener.send && !L2.Listener.__npSendPatched) {
        var origSend = L2.Listener.send;
        L2.Listener.send = function (name, data) {
          try {
            if (lstCount < 80) {
              lstCount++;
              send('lev', { nm: String(name || '').slice(0, 24), st: String((data && data.type) || '').slice(0, 24) });
            }
          } catch (x) {}
          return origSend.apply(this, arguments);
        };
        L2.Listener.__npSendPatched = 1;
      }
    } catch (e) {}

    try {
      var origPush = history.pushState;
      history.pushState = function () {
        var st = '';
        try { send('push', { url: String(arguments[2] || '').slice(0, 70), st: shortStack(2) }); } catch (x) {}
        return origPush.apply(this, arguments);
      };
      var origRepl = history.replaceState;
      history.replaceState = function () {
        var st = '';
        try { send('rpush', { url: String(arguments[2] || '').slice(0, 70), st: shortStack(2) }); } catch (x) {}
        return origRepl.apply(this, arguments);
      };
    } catch (e) {}

    setInterval(function () {
      var st = note(0);
      var mem = 0, dom = 0;
      try { if (performance.memory) mem = Math.round(performance.memory.usedJSHeapSize / 1048576); } catch (e) {}
      try { dom = d.getElementsByTagName('*').length; } catch (e) {}
      send('hb', { up: Math.round(performance.now()), vis: d.visibilityState,
                   ar: appEv, pi: plInit, rs: actRestart, m: mem, nd: dom,
                   v: st.v, pl: st.pl, lp: st.lp });
    }, 60000);

    setInterval(function () { note(0); }, 20000);
  } catch (e) {}
})();
