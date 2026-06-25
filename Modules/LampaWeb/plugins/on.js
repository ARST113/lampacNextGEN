(function () {
    'use strict';

    function lampacPluginLoadUrl(url) {
        var value = String(url || '').replace(/\{localhost\}/g, location.origin);
        if (!value) return value;
        var key = window.__lampacPluginCacheKey;
        if (!key) {
            key = String(Date.now());
            window.__lampacPluginCacheKey = key;
        }
        value = value.replace(/([?&])lampac_cache=[^&]*/g, '$1').replace(/[?&]$/, '');
        return value + (value.indexOf('?') >= 0 ? '&' : '?') + 'lampac_cache=' + encodeURIComponent(key);
    }

    function normalizeLampacPluginUrl(url) {
        var value = String(url || '').replace(/\{localhost\}/g, location.origin);
        if (!value) return '';
        try {
            var a = document.createElement('a');
            a.href = value;
            var path = (a.pathname || '').replace(/\/+/g, '/');
            var local = !a.host || a.host == location.host || a.hostname == '127.0.0.1' || a.hostname == 'localhost';
            if (local && path) return path.toLowerCase();
            if (a.protocol && a.host) return (a.protocol + '//' + a.host + path).toLowerCase();
        }
        catch (e) {}
        return value.split('#')[0].split('?')[0].toLowerCase();
    }

    function lampacPluginDisabled(url) {
        var list = [];
        try { list = Lampa.Plugins && Lampa.Plugins.get ? (Lampa.Plugins.get() || []) : []; } catch (e) { list = []; }
        var target = normalizeLampacPluginUrl(url);
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            if (item && item.status == 0 && normalizeLampacPluginUrl(item.__lampacSourceUrl || item.url) == target) return true;
        }
        return false;
    }

    var plugins = [{plugins}].filter(function(url) {
        return !lampacPluginDisabled(url);
    }).map(lampacPluginLoadUrl);
    Lampa.Utils.putScriptAsync(plugins, function() {});
})();
