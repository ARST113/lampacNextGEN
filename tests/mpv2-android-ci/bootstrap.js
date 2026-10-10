(function () {
  'use strict';
  var ci = window.__MPV2_CI__ = { loadedAt: Date.now(), started: false, error: '' };
  window.addEventListener('error', function (e) {
    ci.error = String(e.message || 'Unknown browser error');
    console.error('[mpv2-ci]', ci.error);
  });
  window.addEventListener('unhandledrejection', function (e) {
    ci.error = String(e.reason && (e.reason.message || e.reason) || 'Promise rejected');
    console.error('[mpv2-ci]', ci.error);
  });
  var tries = 0;
  var timer = setInterval(function () {
    if (++tries > 200) {
      clearInterval(timer);
      ci.error = 'Lampa / MPV2 not ready within 50s';
      return;
    }
    if (!window.Lampa || !Lampa.Storage || !window.MpvWasmLampa || !MpvWasmLampa.open) return;
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