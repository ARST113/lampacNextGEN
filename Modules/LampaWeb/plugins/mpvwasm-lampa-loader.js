(function () {
  'use strict';

  if (window.__mpvwasm_live_loader) return;
  window.__mpvwasm_live_loader = true;

  var BUILD = '20260809-51-ddd-sync-final';

  if (window.isSecureContext && navigator.serviceWorker) {
    navigator.serviceWorker.register('/mpvwasm/assets/mpvwasm-cache-sw.js?v=' + BUILD, {
      scope: '/mpvwasm/assets/'
    }).catch(function (error) {
      console.warn('[mpvwasm-loader] Runtime cache unavailable', error);
    });
  }

  var script = document.createElement('script');
  script.type = 'text/javascript';
  script.async = false;
  script.src = '/lampac-js/uploads/mpvwasm-lampa-player.js?v=' + BUILD;
  script.onerror = function () {
    window.__mpvwasm_live_loader = false;
    console.error('[mpvwasm-loader] Unable to load player plugin');
  };
  document.head.appendChild(script);
})();
