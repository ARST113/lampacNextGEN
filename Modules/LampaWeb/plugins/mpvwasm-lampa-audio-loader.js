/* Standalone loader: opt in to Audio WASM without replacing the existing MPV2 plugin. */
(function () {
  'use strict';
  if (window.__lampa_audio_wasm_loader) return;
  window.__lampa_audio_wasm_loader = true;
  var script = document.createElement('script');
  script.src = '/lampac-js/uploads/mpvwasm-lampa-audio.js?v=20261010-android-10';
  script.async = false;
  script.onerror = function () {
    window.__lampa_audio_wasm_loader = false;
    console.error('[Lampa Audio WASM] Plugin not installed at /lampac-js/uploads/');
  };
  document.head.appendChild(script);
})();
