(function () {
  'use strict';
  var ci = window.__MPV2_CI__ = { loadedAt: Date.now(), started: false, error: '', languageSelected: false };
  window.addEventListener('error', function (e) {
    ci.error = String(e.message || 'Unknown browser error');
    console.error('[mpv2-ci]', ci.error);
  });
  window.addEventListener('unhandledrejection', function (e) {
    ci.error = String(e.reason && (e.reason.message || e.reason) || 'Promise rejected');
    console.error('[mpv2-ci]', ci.error);
  });
  var tries = 0;
  var readySince = 0;
  var timer = setInterval(function () {
    if (++tries > 360) {
      clearInterval(timer);
      ci.error = 'Lampa / MPV2 not ready within 90s';
      return;
    }
    // Upstream Lampa starts with a language wizard on fresh profiles.
    // Complete it with its own DOM event before opening the player overlay.
    var ru = document.querySelector('.lang__selector-item[data-code="ru"]');
    if (ru && !ci.languageSelected) {
      ci.languageSelected = true;
      ru.click();
      console.info('[mpv2-ci] Selected Russian in Lampa welcome wizard');
      return;
    }
    if (document.querySelector('.lang') && !ci.languageSelected) return;
    if (!window.Lampa || !Lampa.Storage || !Lampa.Controller ||
        !window.MpvWasmLampa || !MpvWasmLampa.open) return;
    var controller = '';
    try { controller = String(Lampa.Controller.enabled().name || ''); } catch (_) { }
    // On a fresh Lampa install, MPV2 can be closed by Lampa's final startup
    // controller transition (e.g. controller='loading'). Only open after the
    // UI has been stable for a few seconds and no wizard is visible.
    if (!controller || /loading|welcome|language/i.test(controller) ||
        document.querySelector('.lang:not(.hide)')) {
      readySince = 0;
      return;
    }
    if (!readySince) readySince = Date.now();
    if (Date.now() - readySince < 4500) return;
    ci.controllerAtStart = controller;
    clearInterval(timer);
    try {
      Lampa.Storage.set('mpvwasm_player_mode', 'mpv2');
      Lampa.Storage.set('mpvwasm_audio_output', 'auto');
      ci.started = true;
      ci.startedAt = Date.now();
      MpvWasmLampa.open({
        title: 'MPV2 Android CI',
        url: location.origin + '/ci/source',
        path: 'mpv2-ci',
        __mpvwasmBackendDecision: {
          selected: 'hybrid-webcodecs',
          candidate: 'hybrid-webcodecs',
          reason: 'ci-forced-mpv2',
          probe: { videoCodec: 'unknown', audioCodec: 'unknown' }
        }
      });
      console.info('[mpv2-ci] MPV2 opened inside Lampa');
    } catch (e) {
      ci.error = String(e && (e.stack || e.message || e));
      console.error('[mpv2-ci] Failed to launch:', ci.error);
    }
  }, 250);
})();