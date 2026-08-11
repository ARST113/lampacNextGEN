(function () {
    'use strict';

        var BOOT_VERSION = 'v4.0.107-android-playlist-proxy-mobile-20260811';

    function rememberBootStatus(phase, details) {
        try {
            if (window.__CONTINUE_WATCH_DDD_DEBUG__ === true) {
                console.warn('[ContinueWatching DDD]', BOOT_VERSION, phase, details || '');
            }
        } catch (e) {}

        try {
            localStorage.setItem('continue_watch_boot_status', JSON.stringify({
                version: BOOT_VERSION,
                phase: phase,
                details: details || '',
                timestamp: Date.now()
            }));
        } catch (e) {}
    }

    if (typeof Lampa === 'undefined' || !Lampa) {
        rememberBootStatus('waiting', 'Lampa is not ready');

        if (!window.__CONTINUE_WATCH_WAITING_FOR_LAMPA__) {
            window.__CONTINUE_WATCH_WAITING_FOR_LAMPA__ = true;

            var waitingScriptUrl = '';
            var waitingAttempts = 0;

            try {
                waitingScriptUrl = document.currentScript && document.currentScript.src
                    ? document.currentScript.src
                    : '';
            } catch (e) {}

            var waitingTimer = setInterval(function () {
                waitingAttempts += 1;

                if (typeof Lampa !== 'undefined' && Lampa && waitingScriptUrl) {
                    clearInterval(waitingTimer);
                    window.__CONTINUE_WATCH_WAITING_FOR_LAMPA__ = false;
                    rememberBootStatus('retrying', 'Lampa became ready');

                    var retryScript = document.createElement('script');
                    retryScript.async = true;
                    retryScript.src = waitingScriptUrl;
                    (document.head || document.documentElement).appendChild(retryScript);
                    return;
                }

                if (waitingAttempts >= 120) {
                    clearInterval(waitingTimer);
                    window.__CONTINUE_WATCH_WAITING_FOR_LAMPA__ = false;
                    rememberBootStatus('timeout', 'Lampa did not become ready');
                }
            }, 250);
        }

        return;
    }

    rememberBootStatus('executing', 'Lampa is ready');

    if (
        window.__CONTINUE_WATCH_DDD_LAYER_V3_READY__ &&
        window.__CONTINUE_WATCH_DDD_LAYER_V3_VERSION__ === BOOT_VERSION
    ) {
        return;
    }

    var stopPreviousDDDTransport = null;

    try {
        if (
            window.ContinueWatchUniversal &&
            window.ContinueWatchUniversal.ddd &&
            typeof window.ContinueWatchUniversal.ddd.stop === 'function'
        ) {
            stopPreviousDDDTransport = window.ContinueWatchUniversal.ddd.stop;
            stopPreviousDDDTransport();
        }
    } catch (e) {}

    window.__CONTINUE_WATCH_DDD_LAYER_V3_LOADING__ = true;
    window.__CONTINUE_WATCH_DDD_LAYER_V3_VERSION__ = BOOT_VERSION;

    var PLUGIN_NAME = 'ContinueWatchUniversal';
    var PLUGIN_VERSION = BOOT_VERSION;

    var DDD_DEBUG = false;
    var DDD_TRACE = false;

    try {
        if (DDD_DEBUG) console.log('[ContinueWatching DDD]', BOOT_VERSION);
    } catch (e) {}

    var DEBUG = {
        enabled: !!(DDD_DEBUG || DDD_TRACE),
        console: !!(DDD_DEBUG || DDD_TRACE),
        noty: !!DDD_DEBUG,
        notyLevel: DDD_DEBUG ? 3 : 0,
        notyMinIntervalMs: 1200,
        pollSuccess: false,
        pollFail: false,
        statusButton: false,
        exposeApi: true
    };

    var CONFIG = {
        storageBaseKey: 'continue_watch_params',
        sessionStorageKey: 'continue_watch_ddd_session',

        cleanupAgeMs: 60 * 24 * 60 * 60 * 1000,
        debounceDelayMs: 1000,

        dddEnabled: true,
        dddAndroidOnly: false,
        dddHost: 'http://127.0.0.1',
        dddPort: 39677,
        dddClient: 'lampa',
        dddMode: 'local',
        dddToken: '',

        dddPollIntervalMs: 1500,
        dddFetchTimeoutMs: 1800,
        dddTimelineSaveIntervalMs: 5000,
        dddEventsLimit: 50,
        dddPcBridgeLaunchEnabled: true,
        dddLaunchTimeoutMs: 2500,
        dddRemoteEnabled: true,
        // Use the page origin so HTTPS clients never hit mixed-content blocking.
        dddRemoteBaseUrl: '',
        dddRemoteEventsPath: '/ddd-sync/v1/events',
        dddRemoteLatestPath: '/ddd-sync/v1/latest',
        dddRemoteDeviceStorageKey: 'ddd_sync_device_id_v1',
        // Each client writes under its own stable id; reads merge all household clients.
        dddRemoteDeviceId: '',

        minSaveSeconds: 8,
        minDurationSeconds: 60,
        finishPercent: 90,

        onlyExternalTorrentPlayer: true,
        nativeTimelineEnabled: true,
        nativePlayerEventsEnabled: true,
        saveNativeTimelineToCustomStorage: true,
        updateLampaTimelineFromDDD: true,
        maxNativeAfterDDDSilenceMs: 30000,

        launchLockMs: 3000
    };

    // ============================================================
    // Utils
    // ============================================================

    var Utils = (function () {
        var lastNotyMessage = '';
        var lastNotyTime = 0;
        var lastActivityMovie = null;

        function now() {
            return Date.now ? Date.now() : new Date().getTime();
        }

        function stringifyArgs(args) {
            var out = [];

            for (var i = 0; i < args.length; i++) {
                var item = args[i];

                if (item === undefined) continue;

                if (item === null) {
                    out.push('null');
                    continue;
                }

                if (
                    typeof item === 'string' ||
                    typeof item === 'number' ||
                    typeof item === 'boolean'
                ) {
                    out.push(String(item));
                    continue;
                }

                try {
                    out.push(JSON.stringify(item));
                } catch (e) {
                    out.push('[object]');
                }
            }

            return out.join(' ');
        }

        function showConsole(method, args) {
            if (!window.console) return;
            if (method !== 'error' && (!DEBUG.enabled || !DEBUG.console)) return;

            var fn = console[method] || console.log;

            try {
                fn.apply(console, ['[' + PLUGIN_NAME + ']'].concat(Array.prototype.slice.call(args)));
            } catch (e) {}
        }

        function showNoty(message, level, force) {
            if (!DEBUG.enabled || !DEBUG.noty) return;

            level = Number(level || 0);
            if (!force && level > Number(DEBUG.notyLevel || 0)) return;

            var current = now();
            var text = String(message || '');

            if (!force && text === lastNotyMessage && current - lastNotyTime < DEBUG.notyMinIntervalMs) {
                return;
            }

            lastNotyMessage = text;
            lastNotyTime = current;

            try {
                if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(text);
            } catch (e) {}
        }

        function debugLine(prefix, args, level, force) {
            var text = stringifyArgs(args);

            if (!text) text = '';
            if (prefix) text = prefix + (text ? ': ' + text : '');

            showNoty(text.slice(0, 180), level, force);
        }

        function log() {
            showConsole('log', arguments);
        }

        function warn() {
            showConsole('warn', arguments);
            debugLine('warn', arguments, 2, false);
        }

        function error() {
            showConsole('error', arguments);
            debugLine('error', arguments, 0, true);
        }

        function noty(message, force, level) {
            showNoty(message, level, force);
        }

        function stripFragment(url) {
            if (typeof url !== 'string') return url;

            var pos = url.indexOf('#');
            return pos >= 0 ? url.substring(0, pos) : url;
        }

        function normalizePlaybackUrl(url) {
            url = stripFragment(url || '');
            if (!url) return '';

            try {
                var match = url.match(/^http:\/\/([^/]+)(?:\/|$)/i);
                if (
                    match &&
                    window.location &&
                    window.location.protocol === 'https:' &&
                    String(match[1] || '').toLowerCase() === String(window.location.host || '').toLowerCase()
                ) {
                    return 'https://' + url.substring('http://'.length);
                }
            } catch (e) {}

            return url;
        }

        function getFragment(url) {
            if (typeof url !== 'string') return '';

            var pos = url.indexOf('#');
            return pos >= 0 ? url.substring(pos + 1) : '';
        }

        function isStreamUrl(url) {
            return typeof url === 'string' && url.indexOf('/stream/') !== -1;
        }

        function isRemoteMediaUrl(url) {
            if (!url || typeof url !== 'string') return false;

            return /^(?:https?:)?\/\//i.test(url) || /^\//.test(url);
        }

        function isEphemeralProxyUrl(url) {
            if (!url || typeof url !== 'string') return false;

            var clean = stripFragment(url);

            try {
                var parsed = new URL(clean, window.location && window.location.href || undefined);
                var sameHost = !window.location || !window.location.host ||
                    String(parsed.host || '').toLowerCase() === String(window.location.host || '').toLowerCase();

                return sameHost && /^\/proxy\//i.test(parsed.pathname || '') && /\.m3u8$/i.test(parsed.pathname || '');
            } catch (e) {
                return /^\/?proxy\/.*\.m3u8(?:\?|$)/i.test(clean);
            }
        }

        function encodeParams(params) {
            var result = [];

            Object.keys(params || {}).forEach(function (key) {
                if (params[key] === undefined || params[key] === null || params[key] === '') return;

                result.push(
                    encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key]))
                );
            });

            return result.join('&');
        }

        function appendFragmentParams(url, params) {
            if (!url || typeof url !== 'string') return url;

            var base = stripFragment(url);
            var oldFragment = getFragment(url);
            var add = encodeParams(params || {});

            if (!oldFragment) return add ? base + '#' + add : base;
            if (!add) return base + '#' + oldFragment;

            return base + '#' + oldFragment + '&' + add;
        }

        function stripDddQueryParams(url) {
            if (!url || typeof url !== 'string') return url;

            var fragment = getFragment(url);
            var base = stripFragment(url);
            var queryPos = base.indexOf('?');

            if (queryPos < 0) return fragment ? base + '#' + fragment : base;

            var path = base.substring(0, queryPos);
            var query = base.substring(queryPos + 1).split('&').filter(function (part) {
                var key = part.split('=', 1)[0] || '';

                try {
                    key = decodeURIComponent(key.replace(/\+/g, ' '));
                } catch (e) {}

                return key.indexOf('ddd_') !== 0;
            }).join('&');

            var clean = path + (query ? '?' + query : '');
            return fragment ? clean + '#' + fragment : clean;
        }

        function appendQueryParams(url, params) {
            if (!url || typeof url !== 'string') return url;

            var base = stripFragment(url);
            var fragment = getFragment(url);
            var add = encodeParams(params || {});

            if (add) base += (base.indexOf('?') < 0 ? '?' : '&') + add;
            return fragment ? base + '#' + fragment : base;
        }

        function pad2(value) {
            value = Number(value || 0);
            return value < 10 ? '0' + value : String(value);
        }

        function formatSeconds(seconds) {
            seconds = Number(seconds || 0);

            if (!seconds || seconds < 0) return '0:00';

            var total = Math.floor(seconds);
            var h = Math.floor(total / 3600);
            var m = Math.floor((total % 3600) / 60);
            var s = total % 60;

            if (h > 0) return h + ':' + pad2(m) + ':' + pad2(s);

            return m + ':' + pad2(s);
        }

        function msToSeconds(ms) {
            ms = Number(ms || 0);
            if (!ms || ms < 0) return 0;
            return Math.floor(ms / 1000);
        }

        function clamp(value, min, max) {
            value = Number(value || 0);
            if (value < min) return min;
            if (value > max) return max;
            return value;
        }

        function safeJson(value) {
            try {
                return JSON.stringify(value);
            } catch (e) {
                return '';
            }
        }

        function safeDecode(value) {
            value = String(value || '');

            try {
                return decodeURIComponent(value);
            } catch (e) {
                return value;
            }
        }

        function normalizeText(value) {
            return String(value || '')
                .toLowerCase()
                .replace(/\+/g, ' ')
                .replace(/[_]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        }

        function firstNonEmpty() {
            for (var i = 0; i < arguments.length; i++) {
                if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== '') {
                    return arguments[i];
                }
            }

            return '';
        }

        function normalizeImageUrl(src) {
            src = String(src || '').trim();

            if (!src) return '';

            if (/^\/\//.test(src)) {
                return location.protocol + src;
            }

            if (/^(https?:|data:image\/|blob:)/i.test(src)) {
                return src;
            }

            if (src.charAt(0) === '/') {
                try {
                    if (Lampa.Api && Lampa.Api.img) {
                        return Lampa.Api.img(src, 'w300');
                    }
                } catch (e) {}

                try {
                    if (Lampa.TMDB && Lampa.TMDB.image) {
                        return Lampa.TMDB.image(src, 'w300');
                    }
                } catch (e2) {}
            }

            return src;
        }

        function extractImage(obj) {
            if (!obj || typeof obj !== 'object') return '';

            var direct = firstNonEmpty(
                obj.img,
                obj.image,
                obj.picture,
                obj.poster,
                obj.cover,
                obj.thumb,
                obj.thumbnail,
                obj.preview,
                obj.still_path,
                obj.still,
                obj.poster_path,
                obj.backdrop_path
            );

            if (direct) return normalizeImageUrl(direct);

            var nested = [
                obj.currentItem,
                obj.item,
                obj.file,
                obj.episode_data,
                obj.episodeData,
                obj.episode,
                obj.timeline,
                obj.card,
                obj.movie,
                obj.data
            ];

            for (var i = 0; i < nested.length; i++) {
                direct = extractImage(nested[i]);
                if (direct) return direct;
            }

            return '';
        }

        function copyImageFields(target, image) {
            image = normalizeImageUrl(image);

            if (!target || !image) return target;

            target.img = target.img || image;
            target.image = target.image || image;
            target.picture = target.picture || image;
            target.poster = target.poster || image;
            target.cover = target.cover || image;
            target.thumb = target.thumb || image;
            target.thumbnail = target.thumbnail || image;
            target.preview = target.preview || image;
            target.still_path = target.still_path || image;

            return target;
        }

        function getPlatformKind() {
            var ua = '';

            try {
                ua = String(navigator.userAgent || '').toLowerCase();
            } catch (e) {}

            try {
                if (Lampa.Platform && Lampa.Platform.is) {
                    if (Lampa.Platform.is('android')) return 'android';
                    if (Lampa.Platform.is('webos')) return 'lg_webos';
                    if (Lampa.Platform.is('tizen')) return 'samsung_tizen';
                    if (Lampa.Platform.is('samsung')) return 'samsung_tizen';
                    if (Lampa.Platform.is('apple_tv')) return 'apple_tv';
                    if (Lampa.Platform.is('apple')) return 'apple';
                }
            } catch (e2) {}

            if (/android/.test(ua)) return 'android';
            if (/web0s|webos|netcast|lg browser/.test(ua)) return 'lg_webos';
            if (/tizen|samsungbrowser|smart-tv|smarttv/.test(ua)) return 'samsung_tizen';

            return 'unknown';
        }

        function isAndroidPlatform() {
            return getPlatformKind() === 'android';
        }

        function isAndroidUserAgent() {
            try {
                return /android/i.test(String(navigator.userAgent || ''));
            } catch (e) {
                return false;
            }
        }

        function getTorrentPlayerType() {
            try {
                return String(Lampa.Storage.field('player_torrent') || '');
            } catch (e) {
                return '';
            }
        }

        function getMpvWasmPlayerMode() {
            try {
                return String(
                    Lampa.Storage.field('mpvwasm_player_mode') ||
                    Lampa.Storage.get('mpvwasm_player_mode', '') ||
                    ''
                ).toLowerCase();
            } catch (e) {
                return '';
            }
        }

        function isMpv2Player() {
            return getMpvWasmPlayerMode() === 'mpv2';
        }

        function isExternalTorrentPlayer() {
            var type = getTorrentPlayerType();

            if (!type) return true;
            if (type === 'inner') return false;
            if (type === 'lampa') return false;

            return true;
        }

        function shouldUseDDDLayer() {
            if (!CONFIG.dddEnabled) return false;

            if (CONFIG.dddAndroidOnly && !isAndroidPlatform()) return false;

            // The Android wrapper selects the actual external player package
            // outside the WebView. Its player_torrent field can still be "inner",
            // so it must not disable DDD2 URL metadata and remote progress sync.
            if (isAndroidPlatform()) return true;

            // MPV2 is an in-page player, but it still uses DDD Sync for
            // cross-device progress and Continue Watching metadata.
            if (isMpv2Player()) return true;

            if (!CONFIG.onlyExternalTorrentPlayer) return true;

            return isExternalTorrentPlayer();
        }

        function parseStreamUrl(url) {
            if (!url || typeof url !== 'string') return null;

            url = stripFragment(url);

            var fileMatch = url.match(/\/stream\/([^?]+)/);
            var linkMatch = url.match(/[?&]link=([^&#]+)/);
            var indexMatch = url.match(/[?&]index=(\d+)/);

            if (!fileMatch || !linkMatch) return null;

            return {
                file_name: safeDecode(fileMatch[1])
                    .replace(/\+/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim(),
                torrent_link: safeDecode(linkMatch[1]),
                file_index: indexMatch ? parseInt(indexMatch[1], 10) : 0
            };
        }

        function streamIdentity(url) {
            var parsed = parseStreamUrl(url);

            if (!parsed) return stripFragment(url || '');

            return [
                parsed.torrent_link || '',
                parsed.file_index !== undefined ? parsed.file_index : '',
                parsed.file_name || ''
            ].join('|');
        }

        function getOriginalLanguage(obj) {
            obj = obj || {};

            var card = obj.card || obj.movie || obj.data || obj;

            return String(
                obj.original_language ||
                obj.originalLanguage ||
                obj.language ||
                card.original_language ||
                card.originalLanguage ||
                card.language ||
                ''
            ).toLowerCase();
        }

        function getMovieTitle(obj) {
            obj = obj || {};

            return String(
                obj.original_name ||
                obj.original_title ||
                obj.name ||
                obj.title ||
                obj.originalName ||
                obj.originalTitle ||
                ''
            );
        }

        function getMediaKind(obj) {
            obj = obj || {};

            var card = obj.card || obj.movie || obj.data || obj;
            var media = String(
                obj.media_type ||
                obj.mediaType ||
                card.media_type ||
                card.mediaType ||
                ''
            ).toLowerCase();

            if (media === 'movie' || media === 'film') return 'movie';
            if (media === 'tv' || media === 'show' || media === 'series') return 'tv';

            if (
                Number(card.number_of_seasons || 0) > 0 ||
                Number(card.number_of_episodes || 0) > 0 ||
                card.original_name ||
                card.first_air_date ||
                card.seasons !== undefined ||
                card.episodes !== undefined ||
                card.last_episode_to_air !== undefined ||
                card.next_episode_to_air !== undefined
            ) {
                return 'tv';
            }

            if (card.release_date || Number(card.runtime || 0) > 0 || card.original_title) {
                return 'movie';
            }

            return 'movie';
        }

        function isJapaneseSeries(obj) {
            obj = obj || {};

            var card = obj.card || obj.movie || obj.data || obj;
            var lang = getOriginalLanguage(card);

            return lang === 'ja' && getMediaKind(card) === 'tv';
        }

        function getStreamFileNameFromData(data) {
            if (!data) return '';

            var url = data.url || data.uri || data.src || '';

            if (url && typeof url === 'string') {
                var parsed = parseStreamUrl(url);
                if (parsed && parsed.file_name) return parsed.file_name;
            }

            return '';
        }

        function extractSE(data, options) {
            options = options || {};

            var preferText = !!options.preferText;
            var allowEpisodeOnly = !!options.allowEpisodeOnly;
            var fallbackSeason = Number(options.fallbackSeason || 0);

            function parseText(text) {
                if (!text || typeof text !== 'string') return null;

                text = safeDecode(text)
                    .replace(/\+/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();

                var m;

                m = text.match(/\bS\s*0?(\d{1,2})\s*[-_. ]+\s*0?(\d{1,3})\b/i);
                if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), source: 'text_s_dash_e' };

                m = text.match(/\bS(?:eason)?\s*0?(\d{1,2})\s*[\.\-_: ]*\s*E(?:p(?:isode)?)?\s*0?(\d{1,3})\b/i);
                if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), source: 'text_sxe' };

                m = text.match(/\b0?(\d{1,2})\s*[xх×]\s*0?(\d{1,3})\b/i);
                if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), source: 'text_1x02' };

                m = text.match(/season\s*0?(\d{1,2}).*?(?:episode|ep\.?)\s*0?(\d{1,3})/i);
                if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), source: 'text_season_episode' };

                m = text.match(/0?(\d{1,2})\s*сезон.*?0?(\d{1,3})\s*сер/i);
                if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), source: 'text_ru_season_episode' };

                m = text.match(/第\s*0?(\d{1,3})\s*話/i);
                if (m && allowEpisodeOnly && fallbackSeason) {
                    return { season: fallbackSeason, episode: parseInt(m[1], 10), source: 'text_ja_episode_only' };
                }

                m = text.match(/(?:эпизод|сер(?:ия|ии|и)?|episode|ep\.?|сер\.)\s*[-–—:]?\s*0?(\d{1,3})/i);
                if (m && allowEpisodeOnly && fallbackSeason) {
                    return { season: fallbackSeason, episode: parseInt(m[1], 10), source: 'text_episode_only' };
                }

                m = text.match(/\s[-–—]\s0?(\d{1,3})(?:\s|$|\.|\[|\()/i);
                if (m && allowEpisodeOnly && fallbackSeason) {
                    return { season: fallbackSeason, episode: parseInt(m[1], 10), source: 'text_dash_episode_only' };
                }

                m = text.match(/(?:^|[\s._\-\[\(])0?(\d{1,3})(?:\s*(?:v\d+)?\s*(?:\[[^\]]+\]|\([^)]+\))*)?\.(?:mkv|mp4|avi|ts)$/i);
                if (m && allowEpisodeOnly && fallbackSeason) {
                    return { season: fallbackSeason, episode: parseInt(m[1], 10), source: 'text_filename_episode_only' };
                }

                return null;
            }

            function parseFields() {
                if (data && data.season !== undefined && data.episode !== undefined) {
                    var s = Number(data.season || 0);
                    var e = Number(data.episode || 0);
                    if (s && e) return { season: s, episode: e, source: 'fields_season_episode' };
                }

                if (data && data.season_number !== undefined && data.episode_number !== undefined) {
                    var ss = Number(data.season_number || 0);
                    var ee = Number(data.episode_number || 0);
                    if (ss && ee) return { season: ss, episode: ee, source: 'fields_season_number_episode_number' };
                }

                if (data && data.s !== undefined && data.e !== undefined) {
                    var s2 = Number(data.s || 0);
                    var e2 = Number(data.e || 0);
                    if (s2 && e2) return { season: s2, episode: e2, source: 'fields_s_e' };
                }

                return null;
            }

            function parseTexts() {
                var fields = [];

                if (data) {
                    fields.push(
                        getStreamFileNameFromData(data),
                        data.file_name,
                        data.filename,
                        data.title,
                        data.name,
                        data.path,
                        data.path_human,
                        data.folder_name,
                        data.episode_title,
                        data.url,
                        data.uri,
                        data.src
                    );

                    if (data.currentItem) {
                        fields.push(
                            data.currentItem.filename,
                            data.currentItem.title,
                            data.currentItem.uri,
                            data.currentItem.url
                        );
                    }
                }

                for (var i = 0; i < fields.length; i++) {
                    var parsed = parseText(fields[i]);
                    if (parsed && parsed.season && parsed.episode) return parsed;
                }

                return null;
            }

            var result = preferText ? parseTexts() : parseFields();
            if (result) return result;

            result = preferText ? parseFields() : parseTexts();
            if (result) return result;

            return { season: 0, episode: 0, source: '' };
        }

        function shallowClone(obj) {
            var out = {};

            if (!obj || typeof obj !== 'object') return out;

            Object.keys(obj).forEach(function (key) {
                out[key] = obj[key];
            });

            return out;
        }

        function getActivityMovie() {
            try {
                var active = Lampa.Activity && Lampa.Activity.active && Lampa.Activity.active();
                var movie = active && (
                    active.movie ||
                    active.card ||
                    (active.params && active.params.movie)
                );

                if (movie) {
                    lastActivityMovie = movie;
                    return movie;
                }
            } catch (e) {}

            return lastActivityMovie;
        }

        function rememberActivityMovie(movie) {
            if (movie && typeof movie === 'object') lastActivityMovie = movie;

            return lastActivityMovie;
        }

        return {
            log: log,
            warn: warn,
            error: error,
            noty: noty,
            now: now,
            stripFragment: stripFragment,
            getFragment: getFragment,
            appendFragmentParams: appendFragmentParams,
            appendQueryParams: appendQueryParams,
            stripDddQueryParams: stripDddQueryParams,
            isStreamUrl: isStreamUrl,
            isRemoteMediaUrl: isRemoteMediaUrl,
            isEphemeralProxyUrl: isEphemeralProxyUrl,
            encodeParams: encodeParams,
            formatSeconds: formatSeconds,
            msToSeconds: msToSeconds,
            clamp: clamp,
            safeJson: safeJson,
            safeDecode: safeDecode,
            normalizeText: normalizeText,
            firstNonEmpty: firstNonEmpty,
            normalizeImageUrl: normalizeImageUrl,
            extractImage: extractImage,
            copyImageFields: copyImageFields,
            getPlatformKind: getPlatformKind,
            isAndroidPlatform: isAndroidPlatform,
            isAndroidUserAgent: isAndroidUserAgent,
            getTorrentPlayerType: getTorrentPlayerType,
            getMpvWasmPlayerMode: getMpvWasmPlayerMode,
            isMpv2Player: isMpv2Player,
            isExternalTorrentPlayer: isExternalTorrentPlayer,
            shouldUseDDDLayer: shouldUseDDDLayer,
            normalizePlaybackUrl: normalizePlaybackUrl,
            parseStreamUrl: parseStreamUrl,
            streamIdentity: streamIdentity,
            extractSE: extractSE,
            getOriginalLanguage: getOriginalLanguage,
            getMovieTitle: getMovieTitle,
            getMediaKind: getMediaKind,
            isJapaneseSeries: isJapaneseSeries,
            getStreamFileNameFromData: getStreamFileNameFromData,
            shallowClone: shallowClone,
            getActivityMovie: getActivityMovie,
            rememberActivityMovie: rememberActivityMovie
        };
    })();

    // ============================================================
    // StorageManager
    // ============================================================

    var StorageManager = (function () {
        var memoryCache = null;
        var activeStorageKey = null;
        var syncedStorageKey = null;
        var accountReady = !!window.appready;
        var saveTimer = null;

        function setAccountReady(value) {
            accountReady = !!value;
            activeStorageKey = null;
            syncedStorageKey = null;
            memoryCache = null;
        }

        function getProfileId() {
            var account = null;

            try {
                if (
                    Lampa.Account &&
                    Lampa.Account.Permit &&
                    Lampa.Account.Permit.account
                ) {
                    account = Lampa.Account.Permit.account;
                }
            } catch (e) {}

            try {
                if (!account && Lampa.Storage && Lampa.Storage.get) {
                    account = Lampa.Storage.get('account', {});
                }
            } catch (e) {}

            if (
                account &&
                account.profile &&
                account.profile.id !== undefined &&
                account.profile.id !== null &&
                account.profile.id !== ''
            ) {
                return account.profile.id;
            }

            return null;
        }

        function getStorageKey() {
            var profileId = getProfileId();

            if (profileId !== null && profileId !== undefined) return CONFIG.storageBaseKey + '_' + profileId;

            return CONFIG.storageBaseKey;
        }

        function getSessionStorageKey() {
            var profileId = getProfileId();

            if (profileId !== null && profileId !== undefined) return CONFIG.sessionStorageKey + '_' + profileId;

            return CONFIG.sessionStorageKey;
        }

        function getActiveStorageKey() {
            var key = getStorageKey();

            if (activeStorageKey !== key) {
                activeStorageKey = key;
                memoryCache = null;
            }

            return key;
        }

        function ensureSync() {
            var key = getActiveStorageKey();

            if (syncedStorageKey === key) return;

            try {
                Lampa.Storage.sync(key, 'object_object');
                syncedStorageKey = key;
            } catch (e) {
                Utils.error('Storage sync failed', e);
            }
        }

        function getParams() {
            ensureSync();

            if (!memoryCache) {
                try {
                    var activeKey = getActiveStorageKey();
                    memoryCache = Lampa.Storage.get(activeKey, {});

                    if (!memoryCache || typeof memoryCache !== 'object') memoryCache = {};

                    if (activeKey !== CONFIG.storageBaseKey) {
                        var legacy = Lampa.Storage.get(CONFIG.storageBaseKey, {});
                        var mergedLegacy = false;

                        if (legacy && typeof legacy === 'object') {
                            Object.keys(legacy).forEach(function (key) {
                                if (key === '__last_by_movie') return;

                                var legacyItem = legacy[key];
                                var activeItem = memoryCache && memoryCache[key];

                                if (
                                    legacyItem &&
                                    typeof legacyItem === 'object' &&
                                    (
                                        !activeItem ||
                                        Number(legacyItem.timestamp || 0) > Number(activeItem.timestamp || 0)
                                    )
                                ) {
                                    memoryCache[key] = legacyItem;
                                    mergedLegacy = true;
                                }
                            });

                            if (legacy.__last_by_movie && typeof legacy.__last_by_movie === 'object') {
                                if (!memoryCache.__last_by_movie) memoryCache.__last_by_movie = {};

                                Object.keys(legacy.__last_by_movie).forEach(function (movieKey) {
                                    var legacyPointer = legacy.__last_by_movie[movieKey];
                                    var activePointer = memoryCache.__last_by_movie[movieKey];

                                    if (
                                        legacyPointer &&
                                        legacyPointer.hash &&
                                        memoryCache[legacyPointer.hash] &&
                                        (
                                            !activePointer ||
                                            Number(legacyPointer.timestamp || 0) > Number(activePointer.timestamp || 0)
                                        )
                                    ) {
                                        memoryCache.__last_by_movie[movieKey] = legacyPointer;
                                        mergedLegacy = true;
                                    }
                                });
                            }

                            if (mergedLegacy) Lampa.Storage.set(activeKey, memoryCache);
                        }
                    }
                } catch (e) {
                    Utils.error('Storage get failed', e);
                    memoryCache = {};
                }
            }

            if (!memoryCache || typeof memoryCache !== 'object') memoryCache = {};

            return memoryCache;
        }

        function setParams(data, force) {
            ensureSync();

            memoryCache = data;

            var key = getActiveStorageKey();

            function save() {
                try {
                    Lampa.Storage.set(key, data);
                } catch (e) {
                    Utils.error('Storage set failed', e);
                }
            }

            if (saveTimer) {
                clearTimeout(saveTimer);
                saveTimer = null;
            }

            if (force) save();
            else {
                saveTimer = setTimeout(function () {
                    saveTimer = null;
                    save();
                }, CONFIG.debounceDelayMs);
            }
        }

        function getMovieKey(movie) {
            if (!movie) return '';

            var id = movie.id || movie.movie_id || movie.tmdb_id || movie.tmdbId || '';
            var title = Utils.getMovieTitle(movie);

            if (id) return 'id:' + id;
            if (title) return 'title:' + Lampa.Utils.hash(title);

            return '';
        }

        function getMovieKeyFromData(data) {
            if (!data) return '';

            if (data.movie_key) return data.movie_key;
            if (data.movie_id) return 'id:' + data.movie_id;
            if (data.tmdb_id) return 'id:' + data.tmdb_id;

            var title = data.original_title || data.original_name || data.title || data.name || '';

            if (title) return 'title:' + Lampa.Utils.hash(title);

            return '';
        }

        function updateLastPointer(params, data, hash) {
            if (!data || !hash) return;

            var mediaType = String(data.media_type || data.mediaType || '').toLowerCase();
            var isMovieRecord = mediaType === 'movie';

            if (!isMovieRecord && (!data.season || !data.episode)) return;

            var movieKey = getMovieKeyFromData(data);
            if (!movieKey) return;

            if (!params.__last_by_movie) params.__last_by_movie = {};

            params.__last_by_movie[movieKey] = {
                hash: hash,
                season: Number(data.season || 0),
                episode: Number(data.episode || 0),
                media_type: mediaType || '',
                timestamp: Utils.now()
            };
        }

        function saveStreamParams(hash, data, forceTimestamp) {
            if (!hash || !data) return false;

            var params = getParams();

            if (!params[hash]) params[hash] = {};

            var old = params[hash];
            var changed = false;
            var progressKeys = {
                time: true,
                duration: true,
                percent: true,
                position: true,
                last_source: true,
                last_event_type: true,
                last_reason: true
            };

            Object.keys(data).forEach(function (key) {
                if (key === 'playlist') return;
                if (progressKeys[key]) return;

                var value = data[key];

                if (value === undefined) return;

                if (old[key] !== value) {
                    old[key] = value;
                    changed = true;
                }
            });

            if (Array.isArray(data.playlist) && data.playlist.length) {
                var oldJson = old.playlist ? Utils.safeJson(old.playlist) : '';
                var newJson = Utils.safeJson(data.playlist);

                if (oldJson !== newJson) {
                    old.playlist = data.playlist;
                    changed = true;
                }
            }

            if (forceTimestamp || changed || !old.timestamp) {
                old.timestamp = Utils.now();

                if (!old.original_timestamp) old.original_timestamp = old.timestamp;

                updateLastPointer(params, old, hash);
                setParams(params, true);

                Utils.log('Saved stream params', hash, 'S' + (old.season || 0) + 'E' + (old.episode || 0), old.episode_title || old.title || '');

                return true;
            }

            return false;
        }

        function cleanupProgressCopies() {
            var params = getParams();
            var changed = false;
            var progressKeys = ['time', 'duration', 'percent', 'position', 'last_source', 'last_event_type', 'last_reason'];

            Object.keys(params).forEach(function (key) {
                if (key === '__last_by_movie') return;

                var item = params[key];
                if (!item || typeof item !== 'object') return;

                progressKeys.forEach(function (name) {
                    if (Object.prototype.hasOwnProperty.call(item, name)) {
                        delete item[name];
                        changed = true;
                    }
                });
            });

            if (changed) setParams(params, true);
            return changed;
        }

        function getTorrServerUrl() {
            try {
                var url1 = Lampa.Storage.get('torrserver_url');
                var url2 = Lampa.Storage.get('torrserver_url_two');
                var useTwo = Lampa.Storage.field('torrserver_use_link') === 'two';

                var url = useTwo ? (url2 || url1) : (url1 || url2);

                if (!url) return null;

                url = String(url).trim();

                if (!url.match(/^https?:\/\//)) url = 'http://' + url;

                url = url.replace(/\/$/, '');

                if (!/^https?:\/\/[^/]+/.test(url)) return null;

                return url;
            } catch (e) {
                Utils.error('Invalid TorrServer URL', e);
                return null;
            }
        }

        function buildStreamUrl(params) {
            if (!params || !params.file_name || !params.torrent_link) {
                Utils.error('Missing stream params', params);
                return null;
            }

            var server = getTorrServerUrl();

            if (!server) {
                try { Lampa.Noty.show('TorrServer не настроен'); } catch (e) {}
                return null;
            }

            var file = encodeURIComponent(params.file_name);
            var link = encodeURIComponent(params.torrent_link);
            var index = params.file_index !== undefined ? params.file_index : 0;

            return server + '/stream/' + file + '?link=' + link + '&index=' + index + '&play';
        }

        function recoverStreamParams(params) {
            if (!params || !Array.isArray(params.playlist) || !params.playlist.length) return null;

            var playlist = params.playlist;
            var season = Number(params.season || 0);
            var episode = Number(params.episode || 0);
            var targetIndex = Number(
                params.playlist_index !== undefined && params.playlist_index !== null
                    ? params.playlist_index
                    : params.start_index !== undefined && params.start_index !== null
                        ? params.start_index
                        : 0
            );

            if (isNaN(targetIndex) || targetIndex < 0 || targetIndex >= playlist.length) targetIndex = 0;

            if (season > 0 && episode > 0) {
                for (var exactIndex = 0; exactIndex < playlist.length; exactIndex++) {
                    var exact = playlist[exactIndex] || {};

                    if (
                        Number(exact.season || exact.season_number || exact.s || 0) === season &&
                        Number(exact.episode || exact.episode_number || exact.e || 0) === episode
                    ) {
                        targetIndex = exactIndex;
                        break;
                    }
                }
            }

            var active = playlist[targetIndex] || {};
            var activeUrl = active.url || active.uri || active.src || '';
            var activeParsed = Utils.parseStreamUrl(activeUrl);

            if (activeParsed) return activeParsed;

            var fileName =
                params.file_name || params.filename ||
                active.file_name || active.filename || active.file ||
                active.title || active.name || '';

            if (!fileName) return null;

            var best = null;
            var bestDistance = Number.MAX_SAFE_INTEGER || 9007199254740991;

            for (var index = 0; index < playlist.length; index++) {
                var item = playlist[index] || {};
                var parsed = Utils.parseStreamUrl(item.url || item.uri || item.src || '');

                if (!parsed || !parsed.torrent_link) continue;

                var distance = Math.abs(targetIndex - index);
                if (distance >= bestDistance) continue;

                var predictedIndex = Number(parsed.file_index || 0) + (targetIndex - index);
                if (predictedIndex < 0) continue;

                bestDistance = distance;
                best = {
                    file_name: fileName,
                    torrent_link: parsed.torrent_link,
                    file_index: predictedIndex
                };
            }

            return best;
        }

        function buildLaunchUrl(params) {
            if (!params) return '';

            if (params.file_name && params.torrent_link) {
                return buildStreamUrl(params) || '';
            }

            var recovered = recoverStreamParams(params);
            if (recovered) return buildStreamUrl(recovered) || '';

            if (params.url && !Utils.isEphemeralProxyUrl(params.url)) return Utils.normalizePlaybackUrl(params.url);
            if (params.uri && !Utils.isEphemeralProxyUrl(params.uri)) return Utils.normalizePlaybackUrl(params.uri);
            if (params.src && !Utils.isEphemeralProxyUrl(params.src)) return Utils.normalizePlaybackUrl(params.src);

            return '';
        }

        function rebuildStreamUrl(url) {
            var parsed = Utils.parseStreamUrl(url);

            if (!parsed) return Utils.normalizePlaybackUrl(url || '');

            return buildStreamUrl(parsed) || Utils.normalizePlaybackUrl(url || '');
        }

        function generateTimelineHash(movie, season, episode) {
            if (!movie) return '';

            var originalTitle = Utils.getMovieTitle(movie);

            season = Number(season || 0);
            episode = Number(episode || 0);

            if (!originalTitle) return '';

            if (season > 0 && episode > 0) {
                var separator = season > 10 ? ':' : '';
                return Lampa.Utils.hash([season, separator, episode, originalTitle].join(''));
            }

            return Lampa.Utils.hash(originalTitle);
        }

        function updateTimeline(hash, time, duration, percent, source) {
            if (!hash) return;
            if (!Lampa.Timeline || !Lampa.Timeline.update) return;

            time = Number(time || 0);
            duration = Number(duration || 0);
            percent = Number(percent || 0);

            if (!duration && time) return;

            if (!percent && duration) percent = Math.round(time / duration * 100);

            percent = Utils.clamp(percent, 0, 100);

            try {
                if (
                    source === 'ddd' &&
                    typeof NativeTimelineSync !== 'undefined' &&
                    NativeTimelineSync &&
                    NativeTimelineSync.beginExternalApply
                ) {
                    NativeTimelineSync.beginExternalApply(hash, Utils.now());
                }

                Lampa.Timeline.update({
                    hash: hash,
                    percent: percent,
                    time: time,
                    duration: duration,
                    received: source === 'ddd'
                });
            } catch (e) {
                Utils.error('Timeline update failed', e);
            }
        }

        function recordHasLaunchableUrl(item) {
            if (!item || typeof item !== 'object') return false;

            if (item.file_name && item.torrent_link) return true;
            if (recoverStreamParams(item)) return true;
            if (item.url && !Utils.isEphemeralProxyUrl(item.url)) return true;
            if (item.uri && !Utils.isEphemeralProxyUrl(item.uri)) return true;
            if (item.src && !Utils.isEphemeralProxyUrl(item.src)) return true;

            return false;
        }

        function getLastStreamParams(movie) {
            if (!movie) return null;

            var originalTitle = Utils.getMovieTitle(movie);
            var movieId = movie.id || movie.movie_id || movie.tmdb_id || movie.tmdbId;
            var mediaKind = Utils.getMediaKind(movie);
            var isMovieLike = mediaKind === 'movie';
            var params = getParams();
            var movieKey = getMovieKey(movie);

            if (
                movieKey &&
                params.__last_by_movie &&
                params.__last_by_movie[movieKey] &&
                params.__last_by_movie[movieKey].hash &&
                params[params.__last_by_movie[movieKey].hash] &&
                recordHasLaunchableUrl(params[params.__last_by_movie[movieKey].hash])
            ) {
                return params[params.__last_by_movie[movieKey].hash];
            }

            if (!originalTitle && !movieId) return null;

            var list = [];

            Object.keys(params).forEach(function (key) {
                var item = params[key];

                if (!item || typeof item !== 'object') return;
                if (!recordHasLaunchableUrl(item)) return;

                var sameId = false;
                var sameTitle = false;

                if (movieId && item.movie_id) sameId = String(item.movie_id) === String(movieId);
                if (originalTitle && item.original_title) sameTitle = sameTitle || String(item.original_title) === String(originalTitle);
                if (originalTitle && item.original_name) sameTitle = sameTitle || String(item.original_name) === String(originalTitle);
                if (originalTitle && item.title) sameTitle = sameTitle || String(item.title) === String(originalTitle);

                if (!(sameId || sameTitle)) return;

                if (isMovieLike) {
                    var itemMediaType = String(item.media_type || item.mediaType || '').toLowerCase();
                    if (itemMediaType && itemMediaType !== 'movie') return;
                }

                list.push(item);
            });

            if (!list.length) return null;

            list.sort(function (a, b) {
                return Number(b.timestamp || 0) - Number(a.timestamp || 0);
            });

            return list[0] || null;
        }

        function cleanupOld() {
            var params = getParams();
            var maxAge = CONFIG.cleanupAgeMs;
            var current = Utils.now();
            var changed = false;

            Object.keys(params).forEach(function (key) {
                if (key === '__last_by_movie') return;

                var item = params[key];
                if (!item || typeof item !== 'object') return;

                if (item.timestamp && current - Number(item.timestamp) > maxAge) {
                    delete params[key];
                    changed = true;
                }
            });

            if (params.__last_by_movie) {
                Object.keys(params.__last_by_movie).forEach(function (key) {
                    var pointer = params.__last_by_movie[key];

                    if (!pointer || !pointer.hash || !params[pointer.hash]) {
                        delete params.__last_by_movie[key];
                        changed = true;
                    }
                });
            }

            if (changed) setParams(params, true);
        }

        return {
            setAccountReady: setAccountReady,
            ensureSync: ensureSync,
            getParams: getParams,
            setParams: setParams,
            getMovieKey: getMovieKey,
            getMovieKeyFromData: getMovieKeyFromData,
            saveStreamParams: saveStreamParams,
            getTorrServerUrl: getTorrServerUrl,
            buildStreamUrl: buildStreamUrl,
            buildLaunchUrl: buildLaunchUrl,
            recoverStreamParams: recoverStreamParams,
            rebuildStreamUrl: rebuildStreamUrl,
            generateTimelineHash: generateTimelineHash,
            updateTimeline: updateTimeline,
            recordHasLaunchableUrl: recordHasLaunchableUrl,
            getLastStreamParams: getLastStreamParams,
            cleanupProgressCopies: cleanupProgressCopies,
            cleanupOld: cleanupOld,
            getSessionStorageKey: getSessionStorageKey,
            getProfileId: getProfileId,
            getStorageKey: getStorageKey
        };
    })();

    // ============================================================
    // SessionManager
    // ============================================================

    var SessionManager = (function () {
        var currentSession = null;
        var sessionByHash = {};
        var hashMetaByHash = {};

        function rememberHash(hash, session, meta) {
            if (!hash) return;

            hash = String(hash);
            sessionByHash[hash] = session;
            hashMetaByHash[hash] = meta || {};
        }

        function hasHash(hash) {
            return !!(hash && hashMetaByHash[String(hash)]);
        }

        function clonePlaylistItem(item) {
            var normalized = {};

            item = item || {};

            Object.keys(item).forEach(function (key) {
                var value = item[key];

                if (value === undefined) return;
                if (typeof value === 'function') return;

                normalized[key] = value;
            });

            return normalized;
        }

        function firstDefined() {
            for (var i = 0; i < arguments.length; i++) {
                if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== '') {
                    return arguments[i];
                }
            }

            return '';
        }

        function normalizePlaylist(playlist) {
            if (!Array.isArray(playlist)) return [];

            return playlist
                .filter(function (item) {
                    return item && typeof item === 'object';
                })
                .map(function (item, index) {
                    var url = item.url || item.uri || item.src || '';
                    var parsed = Utils.parseStreamUrl(url);
                    var normalized = clonePlaylistItem(item);
                    var image = Utils.extractImage(item);

                    normalized.url = Utils.stripFragment(url || '');
                    normalized.uri = normalized.uri || normalized.url;
                    normalized.src = normalized.src || normalized.url;

                    normalized.title = firstDefined(item.title, item.name, item.label);
                    normalized.name = firstDefined(item.name, item.title, item.label);

                    normalized.filename = firstDefined(item.filename, item.file_name, item.path, parsed ? parsed.file_name : '');
                    normalized.file_name = firstDefined(item.file_name, item.filename, item.path, parsed ? parsed.file_name : '');

                    normalized.index = index;

                    normalized.season = Number(firstDefined(item.season, item.season_number, item.s, 0) || 0);
                    normalized.episode = Number(firstDefined(item.episode, item.episode_number, item.e, 0) || 0);

                    if (image) {
                        Utils.copyImageFields(normalized, image);
                    }

                    return normalized;
                });
        }

        function getMovieFromData(data) {
            data = data || {};

            return data.card || data.movie || data.card_data || data.data || Utils.getActivityMovie() || data;
        }

        function inferPlaylistIndex(data, playlist, url) {
            var i;
            var cleanUrl = Utils.stripFragment(url || '');
            var identity = Utils.streamIdentity(cleanUrl);

            if (playlist && playlist.length) {
                for (i = 0; i < playlist.length; i++) {
                    if (Utils.stripFragment(playlist[i].url || '') === cleanUrl) return i;
                    if (Utils.streamIdentity(playlist[i].url || '') === identity) return i;
                }
            }

            if (data) {
                if (data.playlist_index !== undefined) return Number(data.playlist_index || 0);
                if (data.start_index !== undefined) return Number(data.start_index || 0);
                if (data.windowIndex !== undefined) return Number(data.windowIndex || 0);
                if (data.index !== undefined) return Number(data.index || 0);
            }

            var parsed = Utils.parseStreamUrl(cleanUrl);
            if (parsed && parsed.file_index !== undefined) return Number(parsed.file_index || 0);

            return 0;
        }

        function getItemAt(playlist, index) {
            if (!playlist || !playlist.length) return null;

            index = Number(index || 0);

            if (index < 0) index = 0;
            if (index >= playlist.length) index = playlist.length - 1;

            return playlist[index] || null;
        }

        function extractSEForSession(data, movie, item, playlistIndex) {
            var fallbackSeason = 0;

            if (data) {
                fallbackSeason = Number(data.season || data.season_number || data.s || 0);
            }

            if (!fallbackSeason && item) {
                fallbackSeason = Number(item.season || item.season_number || item.s || 0);
            }

            if (!fallbackSeason && Utils.getMediaKind(movie) === 'tv') fallbackSeason = 1;

            var se = Utils.extractSE(data || {}, {
                preferText: false,
                allowEpisodeOnly: Utils.isJapaneseSeries(movie),
                fallbackSeason: fallbackSeason
            });

            if (se.season && se.episode) return se;

            if (item) {
                se = Utils.extractSE(item, {
                    preferText: true,
                    allowEpisodeOnly: Utils.isJapaneseSeries(movie),
                    fallbackSeason: fallbackSeason || 1
                });

                if (se.season && se.episode) return se;
            }

            if (Utils.getMediaKind(movie) === 'tv' && Number(playlistIndex) >= 0) {
                return {
                    season: fallbackSeason || 1,
                    episode: Number(playlistIndex || 0) + 1,
                    source: 'playlist_index_fallback'
                };
            }

            return {
                season: 0,
                episode: 0,
                source: ''
            };
        }

        function createSid(hash, data, url) {
            var seed = [
                hash || '',
                Utils.streamIdentity(url || ''),
                data && (data.movie_id || data.tmdb_id || data.id || '') || '',
                data && (data.season || data.season_number || '') || '',
                data && (data.episode || data.episode_number || '') || ''
            ].join('|');

            var now = Utils.now();
            var cache = window.__CONTINUE_WATCH_DDD_SID_CACHE__;

            if (
                cache &&
                cache.seed === seed &&
                cache.sid &&
                now - Number(cache.ts || 0) >= 0 &&
                now - Number(cache.ts || 0) <= 2500
            ) {
                cache.ts = now;
                return cache.sid;
            }

            var sid = 'ddd_' + Lampa.Utils.hash(seed) + '_' + now + '_' + Math.floor(Math.random() * 100000);
            window.__CONTINUE_WATCH_DDD_SID_CACHE__ = { seed: seed, sid: sid, ts: now };
            return sid;
        }

        function buildParams(session) {
            var parsed = Utils.parseStreamUrl(session.url);
            var movie = session.movie || {};
            var item = session.currentItem || {};
            var image =
                Utils.extractImage(item) ||
                Utils.extractImage(session) ||
                Utils.extractImage(movie);

            var data = {
                url: Utils.stripFragment(session.url || ''),
                uri: Utils.stripFragment(session.url || ''),
                src: Utils.stripFragment(session.url || ''),
                title: session.title || item.title || Utils.getMovieTitle(movie),
                episode_title: item.title || session.episode_title || '',
                movie_id: movie.id || movie.movie_id || movie.tmdb_id || movie.tmdbId || '',
                tmdb_id: movie.id || movie.tmdb_id || movie.tmdbId || '',
                original_title: movie.original_title || '',
                original_name: movie.original_name || movie.name || '',
                name: movie.name || movie.title || '',
                media_type: Utils.getMediaKind(movie),
                season: Number(session.season || 0),
                episode: Number(session.episode || 0),
                playlist_index: Number(session.playlistIndex || 0),
                file_index: parsed ? parsed.file_index : Number(session.playlistIndex || 0),
                file_name: parsed ? parsed.file_name : (item.file_name || item.filename || ''),
                torrent_link: parsed ? parsed.torrent_link : '',
                playlist: session.playlist || [],
                sid: session.sid || ''
            };

            if (session.selectedAudioTrack) data.selected_audio_track = session.selectedAudioTrack;
            if (session.selectedAudioTrackId) data.selected_audio_track_id = session.selectedAudioTrackId;
            if (session.selectedAudioTrackIndex !== undefined && session.selectedAudioTrackIndex !== null && session.selectedAudioTrackIndex !== '') data.selected_audio_track_index = session.selectedAudioTrackIndex;
            if (session.selectedAudioTrackLanguage) data.selected_audio_track_language = session.selectedAudioTrackLanguage;
            if (session.selectedAudioTrackMime) data.selected_audio_track_mime = session.selectedAudioTrackMime;
            if (session.selectedAudioTrackChannels !== undefined && session.selectedAudioTrackChannels !== null && session.selectedAudioTrackChannels !== '') data.selected_audio_track_channels = session.selectedAudioTrackChannels;

            if (image) {
                Utils.copyImageFields(data, image);
            }

            return data;
        }

        function register(session) {
            if (!session) return null;

            currentSession = session;

            if (session.hash) {
                rememberHash(session.hash, session, {
                    index: Number(session.playlistIndex || 0),
                    item: session.currentItem || null,
                    season: Number(session.season || 0),
                    episode: Number(session.episode || 0),
                    source: 'current'
                });
            }

            if (session.playlist && session.playlist.length) {
                for (var i = 0; i < session.playlist.length; i++) {
                    var item = session.playlist[i];
                    var itemSE = extractSEForSession(item, session.movie, item, i);
                    var itemHash = StorageManager.generateTimelineHash(session.movie, itemSE.season, itemSE.episode);

                    if (itemHash) {
                        rememberHash(itemHash, session, {
                            index: i,
                            item: item,
                            season: Number(itemSE.season || 0),
                            episode: Number(itemSE.episode || 0),
                            source: itemSE.source || 'playlist'
                        });
                    }
                }
            }

            try {
                Lampa.Storage.set(StorageManager.getSessionStorageKey(), session);
            } catch (e) {}

            return session;
        }

        function buildFromPlayData(data, options) {
            options = options || {};
            data = data || {};

            var movie = options.movie || getMovieFromData(data);
            var url = Utils.stripFragment(options.url || data.url || data.uri || data.src || '');
            var playlist = normalizePlaylist(options.playlist || data.playlist || []);
            var playlistIndex = inferPlaylistIndex(data, playlist, url);
            var item = getItemAt(playlist, playlistIndex);

            if (item && item.url && !url) url = item.url;

            var se = extractSEForSession(data, movie, item, playlistIndex);

            var recentSid = '';
            var now = Utils.now();

            if (
                !options.sid &&
                options.source === 'player_patch' &&
                currentSession &&
                currentSession.sid &&
                now - Number(currentSession.createdAt || 0) >= 0 &&
                now - Number(currentSession.createdAt || 0) <= 2500 &&
                Utils.streamIdentity(currentSession.url || '') === Utils.streamIdentity(url || '') &&
                Number(currentSession.playlistIndex || 0) === Number(playlistIndex || 0)
            ) {
                recentSid = currentSession.sid;
                Utils.log('Reuse DDD SID for duplicate Player.play', recentSid);
            }

            var timelineHash = '';
            if (data.timeline && data.timeline.hash) timelineHash = data.timeline.hash;
            if (!timelineHash) timelineHash = StorageManager.generateTimelineHash(movie, se.season, se.episode);

            var session = {
                sid: options.sid || recentSid || createSid(timelineHash, data, url),
                source: options.source || '',
                movie: movie,
                url: url,
                initialUrl: url,
                title: data.title || (item && item.title) || Utils.getMovieTitle(movie),
                episode_title: (item && item.title) || data.episode_title || '',
                playlist: playlist,
                playlistIndex: playlistIndex,
                startIndex: playlistIndex,
                currentItem: item,
                season: se.season || 0,
                episode: se.episode || 0,
                seSource: se.source || '',
                hash: timelineHash,
                createdAt: recentSid ? Number(currentSession.createdAt || now) : now,
                updatedAt: now,
                lampaTime: Number(data.time || data.position || (data.timeline && data.timeline.time) || 0),
                lampaDuration: Number(data.duration || (data.timeline && data.timeline.duration) || 0),
                lampaPercent: Number(data.percent || (data.timeline && data.timeline.percent) || 0),
                selectedAudioTrack: firstDefined(data.selected_audio_track, data.selectedAudioTrack, data.ddd_audio_track, ''),
                selectedAudioTrackId: firstDefined(data.selected_audio_track_id, data.selectedAudioTrackId, data.ddd_audio_track_id, ''),
                selectedAudioTrackIndex: firstDefined(data.selected_audio_track_index, data.selectedAudioTrackIndex, data.ddd_audio_track_index, ''),
                selectedAudioTrackLanguage: firstDefined(data.selected_audio_track_language, data.selectedAudioTrackLanguage, data.ddd_audio_track_language, ''),
                selectedAudioTrackMime: firstDefined(data.selected_audio_track_mime, data.selectedAudioTrackMimeType, data.ddd_audio_track_mime, ''),
                selectedAudioTrackChannels: firstDefined(data.selected_audio_track_channels, data.selectedAudioTrackChannels, data.ddd_audio_track_channels, ''),
                lastRoad: null,
                params: null
            };

            var image =
                Utils.extractImage(data) ||
                Utils.extractImage(item) ||
                Utils.extractImage(movie);

            if (image) {
                Utils.copyImageFields(session, image);
            }

            session.params = buildParams(session);

            return register(session);
        }

        function updateByPlaylistIndex(index, payload) {
            if (!currentSession) return null;

            index = Number(index || 0);

            var item = getItemAt(currentSession.playlist, index);
            var url = payload && payload.uri ? Utils.stripFragment(payload.uri) : '';

            if (!item && currentSession.playlist && currentSession.playlist.length) {
                item = getItemAt(currentSession.playlist, index);
            }

            if (!url && item && item.url) url = item.url;
            if (!url) url = currentSession.url;

            var probeData = Utils.shallowClone(item || {});

            if (payload) {
                probeData.url = payload.uri || probeData.url || url;
                probeData.title = payload.title || probeData.title || '';

                if (payload.currentItem) {
                    probeData.currentItem = payload.currentItem;
                    probeData.filename = payload.currentItem.filename || probeData.filename;
                    probeData.file_name = payload.currentItem.filename || probeData.file_name;
                }
            }

            var se = extractSEForSession(probeData, currentSession.movie, item, index);
            var hash = StorageManager.generateTimelineHash(currentSession.movie, se.season, se.episode);
            var image =
                Utils.extractImage(item) ||
                Utils.extractImage(payload) ||
                Utils.extractImage(currentSession);

            currentSession.url = Utils.stripFragment(url);
            currentSession.playlistIndex = index;
            currentSession.currentItem = item;
            currentSession.title = (payload && payload.title) || (item && item.title) || currentSession.title;
            currentSession.episode_title = (item && item.title) || currentSession.episode_title || '';
            currentSession.season = se.season || currentSession.season || 0;
            currentSession.episode = se.episode || currentSession.episode || 0;
            currentSession.seSource = se.source || currentSession.seSource || '';
            currentSession.hash = hash || currentSession.hash;
            currentSession.updatedAt = Utils.now();

            if (image) {
                Utils.copyImageFields(currentSession, image);
            }

            currentSession.params = buildParams(currentSession);

            register(currentSession);

            return currentSession;
        }

        function updateByTimelineHash(hash, payload) {
            if (!hash) return currentSession;

            var meta = hashMetaByHash[String(hash)];

            if (!meta || !currentSession) {
                return sessionByHash[String(hash)] || currentSession;
            }

            var item = meta.item || getItemAt(currentSession.playlist, meta.index);
            var updatePayload = payload ? Utils.shallowClone(payload) : {};

            if (item) {
                updatePayload.uri = updatePayload.uri || item.url || item.uri || item.src || '';
                updatePayload.title = updatePayload.title || item.title || item.name || '';
                updatePayload.currentItem = updatePayload.currentItem || {
                    filename: item.filename || item.file_name || '',
                    title: item.title || item.name || '',
                    img: item.img || item.image || item.thumb || item.thumbnail || item.still_path || ''
                };
            }

            currentSession = updateByPlaylistIndex(meta.index, updatePayload) || currentSession;
            currentSession.hash = String(hash);
            currentSession.season = Number(meta.season || currentSession.season || 0);
            currentSession.episode = Number(meta.episode || currentSession.episode || 0);
            currentSession.currentItem = item || currentSession.currentItem;
            currentSession.playlistIndex = Number(meta.index || currentSession.playlistIndex || 0);
            currentSession.params = buildParams(currentSession);

            register(currentSession);

            return currentSession;
        }

        function updateRoad(road) {
            if (!currentSession) return;
            currentSession.lastRoad = road;
            currentSession.updatedAt = Utils.now();
        }

        function getCurrent() {
            return currentSession;
        }

        function getByHash(hash) {
            return sessionByHash[hash] || null;
        }

        return {
            buildFromPlayData: buildFromPlayData,
            updateByPlaylistIndex: updateByPlaylistIndex,
            buildParams: buildParams,
            updateRoad: updateRoad,
            updateByTimelineHash: updateByTimelineHash,
            hasHash: hasHash,
            getCurrent: getCurrent,
            getByHash: getByHash,
            register: register
        };
    })();

    // ============================================================
    // Core
    // ============================================================

    var Core = (function () {
        var activeSource = null;
        var lastDDDTime = 0;
        var lastSaveByHash = {};
        var lastStreamParamsHash = '';

        function canAcceptSource(event) {
            event = event || {};

            var source = typeof event === 'string' ? event : (event.source || 'unknown');
            var type = typeof event === 'string' ? '' : (event.type || '');

            if (source === 'ddd') {
                activeSource = 'ddd';
                lastDDDTime = Utils.now();
                return true;
            }

            // A new native playback session must immediately become authoritative,
            // even when it starts just after an external DDD player was closed.
            if (type === 'start') {
                activeSource = source;
                lastDDDTime = 0;
                return true;
            }

            if (activeSource === 'ddd') {
                if (Utils.now() - lastDDDTime < CONFIG.maxNativeAfterDDDSilenceMs) return false;
                activeSource = source;
                return true;
            }

            if (!activeSource) activeSource = source;

            return true;
        }

        function shouldSave(hash, event) {
            if (!hash) return false;

            var key = hash + ':' + (event.source || '') + ':' + (event.type || '');
            var current = Utils.now();
            var last = lastSaveByHash[key] || 0;

            if (event.force) {
                lastSaveByHash[key] = current;
                return true;
            }

            if (current - last >= 1000) {
                lastSaveByHash[key] = current;
                return true;
            }

            return false;
        }

        function calculatePercent(time, duration, percent) {
            time = Number(time || 0);
            duration = Number(duration || 0);
            percent = Number(percent || 0);

            if (!percent && duration > 0) percent = Math.round(time / duration * 100);

            return Utils.clamp(percent, 0, 100);
        }

        function enrichSessionFromEvent(session, event) {
            if (!session || !event) return session;

            if (event.hash && String(event.hash) !== String(session.hash || '') && SessionManager.hasHash(event.hash)) {
                session = SessionManager.updateByTimelineHash(event.hash, event.rawPayload || event) || session;
            }

            if (event.url) session.url = Utils.stripFragment(event.url);
            if (event.title) session.title = event.title;

            if (event.playlist_index !== undefined && event.playlist_index !== null) {
                SessionManager.updateByPlaylistIndex(event.playlist_index, event.rawPayload || event);
                session = SessionManager.getCurrent() || session;
            }

            if (event.season && event.episode) {
                session.season = Number(event.season || 0);
                session.episode = Number(event.episode || 0);
                session.hash = StorageManager.generateTimelineHash(session.movie, session.season, session.episode) || session.hash;
                session.params = SessionManager.buildParams(session);
                SessionManager.register(session);
            }

            return session;
        }

        function applyTrackSelectionParams(params, payload) {
            if (!params || !payload) return false;

            var trackType = String(payload.trackType || '').toLowerCase();
            if (trackType && trackType !== 'audio' && !payload.selectedAudioTrack) return false;

            var changed = false;

            function set(key, value) {
                if (value === undefined || value === null || value === '') return;
                if (params[key] !== value) {
                    params[key] = value;
                    changed = true;
                }
            }

            set('selected_audio_track', payload.selectedAudioTrack || payload.audioTrack || payload.label);
            set('selected_audio_track_id', payload.selectedAudioTrackId || payload.trackId);
            set(
                'selected_audio_track_index',
                payload.selectedAudioTrackIndex !== undefined ? payload.selectedAudioTrackIndex : payload.trackIndex
            );
            set('selected_audio_track_language', payload.selectedAudioTrackLanguage || payload.language);
            set('selected_audio_track_mime', payload.selectedAudioTrackMimeType || payload.sampleMimeType);
            set(
                'selected_audio_track_channels',
                payload.selectedAudioTrackChannels !== undefined ? payload.selectedAudioTrackChannels : payload.channelCount
            );

            return changed;
        }

        function applyTrackSelectionToSession(session, params) {
            if (!session || !params) return;

            session.selectedAudioTrack = params.selected_audio_track || session.selectedAudioTrack || '';
            session.selectedAudioTrackId = params.selected_audio_track_id || session.selectedAudioTrackId || '';
            session.selectedAudioTrackIndex = params.selected_audio_track_index !== undefined ? params.selected_audio_track_index : session.selectedAudioTrackIndex;
            session.selectedAudioTrackLanguage = params.selected_audio_track_language || session.selectedAudioTrackLanguage || '';
            session.selectedAudioTrackMime = params.selected_audio_track_mime || session.selectedAudioTrackMime || '';
            session.selectedAudioTrackChannels = params.selected_audio_track_channels !== undefined ? params.selected_audio_track_channels : session.selectedAudioTrackChannels;
        }

        function consume(event) {
            if (!event || !event.type) return;
            if (!canAcceptSource(event)) return;

            var session = event.session || SessionManager.getCurrent();
            if (!session) {
                if (DEBUG.enabled && event.source === 'ddd' && event.force) {
                    Utils.noty('DDD save skipped: no session ' + (event.rawType || event.type || ''), true, 0);
                }
                return;
            }

            session = enrichSessionFromEvent(session, event);

            var hash = event.hash || session.hash;
            if (!hash) {
                if (DEBUG.enabled && event.source === 'ddd' && event.force) {
                    Utils.noty(
                        'DDD save skipped: no hash S' + (session.season || 0) + 'E' + (session.episode || 0),
                        true,
                        0
                    );
                }
                return;
            }

            var time = Number(event.time || 0);
            var duration = Number(event.duration || 0);
            var percent = calculatePercent(time, duration, event.percent);

            if (event.type === 'ended') {
                percent = 100;
                if (!time && duration) time = duration;
            }

            var params = SessionManager.buildParams(session);

            // Playback position has one owner: Lampa.Timeline. Stream params
            // keep only the URL, playlist and selected tracks required to
            // reopen that native timeline entry.
            delete params.time;
            delete params.duration;
            delete params.percent;
            delete params.last_source;
            delete params.last_event_type;
            delete params.last_reason;

            var trackChanged = applyTrackSelectionParams(params, event.rawPayload || event);
            if (trackChanged) {
                applyTrackSelectionToSession(session, params);
                session.params = params;
                SessionManager.register(session);
                StorageManager.saveStreamParams(hash, params, true);
                lastStreamParamsHash = String(hash);

                if (event.rawType === 'track_selection_changed' || event.type === 'track_selection_changed') return;
            }

            if (event.type === 'start') {
                StorageManager.saveStreamParams(hash, params, true);
                lastStreamParamsHash = String(hash);
                return;
            }

            // Lampa switches playlist items inside the existing player and does
            // not call the exported Player.play again. Persist launch metadata
            // once for the new timeline hash so the card follows that episode.
            if (String(hash) !== lastStreamParamsHash) {
                StorageManager.saveStreamParams(hash, params, true);
                lastStreamParamsHash = String(hash);
            }

            if (!shouldSave(hash, event)) return;

            if (
                duration >= CONFIG.minDurationSeconds ||
                event.force ||
                event.type === 'ended' ||
                event.type === 'stop' ||
                event.type === 'error'
            ) {
                if (event.source === 'ddd' && CONFIG.updateLampaTimelineFromDDD) {
                    if (
                        time >= CONFIG.minSaveSeconds ||
                        percent >= CONFIG.finishPercent ||
                        event.force ||
                        event.type === 'ended'
                    ) {
                        StorageManager.updateTimeline(hash, time, duration, percent, 'ddd');
                    }
                }

                SessionManager.updateRoad({
                    hash: hash,
                    time: time,
                    duration: duration,
                    percent: percent,
                    source: event.source,
                    type: event.type
                });
            }
        }

        function getActiveSource() {
            return activeSource;
        }

        return {
            consume: consume,
            getActiveSource: getActiveSource
        };
    })();

    // ============================================================
    // DDDTransport
    // ============================================================

    var DDDTransport = (function () {
        var pollTimer = null;
        var activeSid = '';
        var lastTs = 0;
        var lastStateTs = 0;
        var lastProbeResult = null;
        var lastPingAt = 0;
        var lastGoodAt = 0;
        var lastEventsError = '';
        var lastStateError = '';
        var lastRemoteTimelinePostByHash = {};

        function baseUrl() {
            return CONFIG.dddHost.replace(/\/$/, '') + ':' + CONFIG.dddPort;
        }

        function baseUrls() {
            var urls = [];
            var primary = baseUrl();

            function add(url) {
                if (!url) return;
                if (urls.indexOf(url) === -1) urls.push(url);
            }

            add(primary);

            if (primary.indexOf('127.0.0.1') !== -1) {
                add(primary.replace('127.0.0.1', 'localhost'));
            } else if (primary.indexOf('localhost') !== -1) {
                add(primary.replace('localhost', '127.0.0.1'));
            }

            return urls;
        }

        function withToken(params) {
            params = params || {};
            if (CONFIG.dddToken) params.token = CONFIG.dddToken;
            return params;
        }

        function endpointFromBase(base, path, params) {
            params = withToken(params || {});
            var query = Utils.encodeParams(params);
            return base + path + (query ? '?' + query : '');
        }

        function endpointList(path, variants) {
            var result = [];
            var bases = baseUrls();

            variants = variants && variants.length ? variants : [{}];

            bases.forEach(function (base) {
                variants.forEach(function (params) {
                    result.push(endpointFromBase(base, path, params));
                });
            });

            return result;
        }

        function parseJsonMaybe(value) {
            if (value === null || value === undefined) return null;
            if (typeof value === 'object') return value;

            try {
                return JSON.parse(String(value));
            } catch (e) {
                return null;
            }
        }

        function fetchWithBrowserFetch(url, timeoutMs, call) {
            var finished = false;
            var timer = null;
            var controller = null;

            function done(err, json) {
                if (finished) return;
                finished = true;

                if (timer) clearTimeout(timer);

                call(err, json);
            }

            timer = setTimeout(function () {
                try {
                    if (controller) controller.abort();
                } catch (e) {}

                done(new Error('fetch timeout'), null);
            }, timeoutMs);

            try {
                if (window.AbortController) controller = new AbortController();
            } catch (e1) {}

            try {
                fetch(url, controller ? { signal: controller.signal } : {})
                    .then(function (res) {
                        if (!res || !res.ok) throw new Error('fetch HTTP ' + (res ? res.status : 0));
                        return res.json();
                    })
                    .then(function (json) {
                        done(null, json);
                    })
                    .catch(function (err) {
                        done(err || new Error('fetch failed'), null);
                    });
            } catch (e2) {
                done(e2, null);
            }
        }

        function fetchWithXhr(url, timeoutMs, call) {
            var xhr;

            try {
                xhr = new XMLHttpRequest();
                xhr.open('GET', url, true);
                xhr.timeout = timeoutMs;

                xhr.onreadystatechange = function () {
                    if (xhr.readyState !== 4) return;

                    if (xhr.status >= 200 && xhr.status < 300) {
                        var json = parseJsonMaybe(xhr.responseText);
                        if (!json) return call(new Error('xhr invalid json'), null);
                        return call(null, json);
                    }

                    call(new Error('xhr HTTP ' + xhr.status), null);
                };

                xhr.onerror = function () {
                    call(new Error('xhr network error'), null);
                };

                xhr.ontimeout = function () {
                    call(new Error('xhr timeout'), null);
                };

                xhr.send(null);
            } catch (e) {
                call(e, null);
            }
        }

        function fetchWithLampaNative(url, timeoutMs, call) {
            try {
                if (!Utils.isAndroidPlatform()) return call(new Error('native skipped: not android'), null);
                if (!Lampa.Android || !Lampa.Android.httpReq) return call(new Error('native skipped: Lampa.Android.httpReq missing'), null);

                Lampa.Android.httpReq({
                    url: url,
                    dataType: 'json',
                    timeout: timeoutMs,
                    attempts: 0
                }, {
                    complite: function (data) {
                        var json = parseJsonMaybe(data);

                        if (!json) return call(new Error('native invalid json'), null);

                        call(null, json);
                    },
                    error: function (err) {
                        call(new Error(
                            (err && (err.decode_error || err.responseText || err.message || err.status)) ||
                            'native http error'
                        ), null);
                    }
                });
            } catch (e) {
                call(e, null);
            }
        }

        function fetchJson(url, call) {
            var timeoutMs = CONFIG.dddFetchTimeoutMs;
            var errors = [];

            fetchWithBrowserFetch(url, timeoutMs, function (fetchErr, fetchJsonResult) {
                if (!fetchErr && fetchJsonResult) return call(null, fetchJsonResult);

                errors.push(fetchErr && fetchErr.message ? fetchErr.message : String(fetchErr || 'fetch failed'));

                fetchWithXhr(url, timeoutMs, function (xhrErr, xhrJsonResult) {
                    if (!xhrErr && xhrJsonResult) return call(null, xhrJsonResult);

                    errors.push(xhrErr && xhrErr.message ? xhrErr.message : String(xhrErr || 'xhr failed'));

                    fetchWithLampaNative(url, timeoutMs, function (nativeErr, nativeJsonResult) {
                        if (!nativeErr && nativeJsonResult) return call(null, nativeJsonResult);

                        errors.push(nativeErr && nativeErr.message ? nativeErr.message : String(nativeErr || 'native failed'));

                        call(new Error(errors.join(' | ')), null);
                    });
                });
            });
        }

        function postWithBrowserFetch(url, body, timeoutMs, call) {
            var finished = false;
            var timer = null;
            var controller = null;

            function done(err, json) {
                if (finished) return;
                finished = true;

                if (timer) clearTimeout(timer);

                call(err, json);
            }

            timer = setTimeout(function () {
                try {
                    if (controller) controller.abort();
                } catch (e) {}

                done(new Error('post fetch timeout'), null);
            }, timeoutMs);

            try {
                if (window.AbortController) controller = new AbortController();
            } catch (e1) {}

            try {
                fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json; charset=utf-8'
                    },
                    body: JSON.stringify(body || {}),
                    signal: controller ? controller.signal : undefined
                })
                    .then(function (res) {
                        if (!res || !res.ok) throw new Error('post fetch HTTP ' + (res ? res.status : 0));
                        return res.json();
                    })
                    .then(function (json) {
                        done(null, json);
                    })
                    .catch(function (err) {
                        done(err || new Error('post fetch failed'), null);
                    });
            } catch (e2) {
                done(e2, null);
            }
        }

        function postWithXhr(url, body, timeoutMs, call) {
            var xhr;

            try {
                xhr = new XMLHttpRequest();
                xhr.open('POST', url, true);
                xhr.timeout = timeoutMs;
                xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');

                xhr.onreadystatechange = function () {
                    if (xhr.readyState !== 4) return;

                    if (xhr.status >= 200 && xhr.status < 300) {
                        var json = parseJsonMaybe(xhr.responseText);
                        if (!json) return call(new Error('post xhr invalid json'), null);
                        return call(null, json);
                    }

                    call(new Error('post xhr HTTP ' + xhr.status), null);
                };

                xhr.onerror = function () {
                    call(new Error('post xhr network error'), null);
                };

                xhr.ontimeout = function () {
                    call(new Error('post xhr timeout'), null);
                };

                xhr.send(JSON.stringify(body || {}));
            } catch (e) {
                call(e, null);
            }
        }

        function postJson(url, body, call) {
            var timeoutMs = CONFIG.dddLaunchTimeoutMs || CONFIG.dddFetchTimeoutMs;
            var errors = [];

            postWithBrowserFetch(url, body, timeoutMs, function (fetchErr, fetchJsonResult) {
                if (!fetchErr && fetchJsonResult) return call(null, fetchJsonResult);

                errors.push(fetchErr && fetchErr.message ? fetchErr.message : String(fetchErr || 'post fetch failed'));

                postWithXhr(url, body, timeoutMs, function (xhrErr, xhrJsonResult) {
                    if (!xhrErr && xhrJsonResult) return call(null, xhrJsonResult);

                    errors.push(xhrErr && xhrErr.message ? xhrErr.message : String(xhrErr || 'post xhr failed'));

                    call(new Error(errors.join(' | ')), null);
                });
            });
        }

        function fetchFirstJson(urls, label, call) {
            var index = 0;
            var errors = [];

            function next() {
                if (index >= urls.length) {
                    return call(new Error(errors.join(' || ') || 'all requests failed'), null);
                }

                var url = urls[index++];

                fetchJson(url, function (err, json) {
                    if (!err && json) {
                        if (DEBUG.pollSuccess) Utils.log('DDD ' + label + ' ok', url);
                        lastGoodAt = Utils.now();

                        return call(null, json);
                    }

                    errors.push(url + ' => ' + (err && err.message ? err.message : err));
                    next();
                });
            }

            next();
        }

        function postFirstJson(urls, label, body, call) {
            var index = 0;
            var errors = [];

            function next() {
                if (index >= urls.length) {
                    return call(new Error(errors.join(' || ') || 'all post requests failed'), null);
                }

                var url = urls[index++];

                postJson(url, body, function (err, json) {
                    if (!err && json) {
                        if (DEBUG.pollSuccess) Utils.log('DDD ' + label + ' ok', url);
                        lastGoodAt = Utils.now();

                        return call(null, json);
                    }

                    errors.push(url + ' => ' + (err && err.message ? err.message : err));
                    next();
                });
            }

            next();
        }

        function canUse() {
            return Utils.shouldUseDDDLayer();
        }

        function shouldLaunchViaLocalBridge() {
            var platform = Utils.getPlatformKind();
            var player = Utils.getTorrentPlayerType();
            var external = Utils.isExternalTorrentPlayer();
            var androidPlatform = platform === 'android';
            var mpcLike = /mpc/i.test(player || '');
            var windowsUA = false;

            try {
                windowsUA = /windows|win32|win64/i.test(String(navigator.userAgent || ''));
            } catch (e) {}

            var result = !!CONFIG.dddPcBridgeLaunchEnabled && external && !androidPlatform;

            Utils.log(
                'DDD local bridge decision',
                'enabled=' + (!!CONFIG.dddPcBridgeLaunchEnabled),
                'platform=' + platform,
                'uaAndroid=' + Utils.isAndroidUserAgent(),
                'uaWindows=' + windowsUA,
                'player=' + player,
                'external=' + external,
                'mpcLike=' + mpcLike,
                'result=' + result
            );

            return result;
        }

        function getRemoteBaseUrl() {
            var configured = String(CONFIG.dddRemoteBaseUrl || '').trim();
            if (configured) return configured.replace(/\/+$/, '');

            try {
                if (window.location && /^https?:$/i.test(window.location.protocol || '')) {
                    return window.location.protocol + '//' + window.location.host;
                }
            } catch (e) {}

            return '';
        }

        function makeRemoteUrl(pathOrUrl) {
            pathOrUrl = String(pathOrUrl || '').trim();
            if (!pathOrUrl) return '';
            if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;

            var base = getRemoteBaseUrl();
            if (!base) return '';

            return base + '/' + pathOrUrl.replace(/^\/+/, '');
        }

        function storageGetValue(key) {
            try {
                if (Lampa.Storage && Lampa.Storage.get) {
                    return Lampa.Storage.get(key, '') || '';
                }
            } catch (e) {}

            try {
                return localStorage.getItem(key) || '';
            } catch (e) {}

            return '';
        }

        function storageSetValue(key, value) {
            try {
                if (Lampa.Storage && Lampa.Storage.set) {
                    Lampa.Storage.set(key, value);
                    return;
                }
            } catch (e) {}

            try {
                localStorage.setItem(key, value);
            } catch (e) {}
        }

        function getRemoteDeviceId() {
            var configured = String(CONFIG.dddRemoteDeviceId || '').trim();
            if (configured) return configured;

            var key = CONFIG.dddRemoteDeviceStorageKey || 'ddd_sync_device_id_v1';
            var id = '';

            // Device identity must stay local. Lampa.Storage can be account-synced,
            // which would make the phone and TV overwrite the same DDD record.
            try {
                id = localStorage.getItem(key) || '';
            } catch (e) {}

            if (id) return id;

            var seed = [
                getRemoteBaseUrl(),
                navigator && navigator.userAgent || '',
                Utils.now(),
                Math.random()
            ].join('|');

            try {
                id = 'lampa_' + Lampa.Utils.hash(seed);
            } catch (e) {
                id = 'lampa_' + Math.floor(Math.random() * 1000000000);
            }

            try {
                localStorage.setItem(key, id);
            } catch (e2) {}

            return id;
        }

        function itemTimelineHash(session, item, index) {
            session = session || {};
            item = item || {};

            var season = Number(item.season || item.season_number || item.s || session.season || 0);
            var episode = Number(item.episode || item.episode_number || item.e || 0);

            if (!episode && session.playlist && session.playlist.length && index !== undefined && index !== null) {
                episode = Number(index || 0) + 1;
            }

            try {
                return StorageManager.generateTimelineHash(session.movie || {}, season, episode) || session.hash || '';
            } catch (e) {
                return session.hash || '';
            }
        }

        function remoteContentKey(session, item, index, timelineHash, sourceKey, url) {
            session = session || {};
            item = item || {};

            var movie = session.movie || {};
            var movieId = movie.id || movie.movie_id || movie.tmdb_id || movie.tmdbId || '';
            var season = Number(item.season || item.season_number || item.s || session.season || 0);
            var episode = Number(item.episode || item.episode_number || item.e || 0);

            if (!episode && session.playlist && session.playlist.length && index !== undefined && index !== null) {
                episode = Number(index || 0) + 1;
            }

            if (movieId) {
                if (season > 0 && episode > 0) return 'tmdb:' + movieId + ':s' + season + ':e' + episode;
                return 'tmdb:' + movieId;
            }

            return timelineHash || sourceKey || Utils.stripFragment(url || '');
        }

        function msFromSeconds(value) {
            value = Number(value || 0);
            if (!value || isNaN(value) || value < 0) return 0;
            return Math.round(value * 1000);
        }

        function buildRemoteFragmentParams(url, session, item, index) {
            if (!CONFIG.dddRemoteEnabled) return {};

            session = session || {};
            item = item || {};

            var eventsUrl = makeRemoteUrl(CONFIG.dddRemoteEventsUrl || CONFIG.dddRemoteEventsPath || '/ddd-sync/v1/events');
            var latestUrl = makeRemoteUrl(CONFIG.dddRemoteLatestUrl || CONFIG.dddRemoteLatestPath || '/ddd-sync/v1/latest');
            var deviceId = getRemoteDeviceId();

            if (!eventsUrl || !deviceId) return {};

            var parsed = Utils.parseStreamUrl(url);
            var sourceKey = Utils.streamIdentity(Utils.stripDddQueryParams(url || ''));
            var timelineHash = itemTimelineHash(session, item, index);
            var contentKey = remoteContentKey(session, item, index, timelineHash, sourceKey, url);

            // Signed Lampac proxy URLs can be several kilobytes long. DDD Sync
            // identifies episodes by contentKey, so do not send that URL as the
            // compact source key. The original URI remains available separately.
            if (sourceKey && sourceKey.length > 256) {
                sourceKey = contentKey || timelineHash || '';
            }
            var title = item.title || item.name || session.episode_title || session.title || '';
            var filename = parsed ? parsed.file_name : (item.filename || item.file_name || '');
            if (!filename) filename = title;
            var activeIndex = Number(session.playlistIndex !== undefined ? session.playlistIndex : session.startIndex || 0);
            var isActiveItem = index === undefined || index === null || Number(index) === activeIndex;
            var itemTimeline = item.timeline && typeof item.timeline === 'object' ? item.timeline : null;

            if (!isActiveItem && !itemTimeline && timelineHash) {
                try {
                    if (Lampa.Timeline && Lampa.Timeline.view) itemTimeline = Lampa.Timeline.view(timelineHash);
                } catch (e) {}
            }

            var positionMs = msFromSeconds(isActiveItem ? session.lampaTime : itemTimeline && itemTimeline.time);
            var durationMs = msFromSeconds(isActiveItem ? session.lampaDuration : itemTimeline && itemTimeline.duration);
            var percent = Number(isActiveItem ? session.lampaPercent : itemTimeline && itemTimeline.percent || 0);

            var params = {
                ddd_remote_events_url: eventsUrl,
                ddd_remote_schema: 1,
                ddd_device_id: deviceId,
                ddd_content_key: contentKey,
                ddd_source_key: sourceKey,
                ddd_timeline_hash: timelineHash,
                ddd_source_kind: parsed ? 'torrserver' : 'url',
                ddd_title: title,
                ddd_filename: filename
            };

            if (latestUrl) params.ddd_remote_latest_url = latestUrl;
            if (positionMs > 0) params.ddd_lampa_position = positionMs;
            if (durationMs > 0) params.ddd_lampa_duration = durationMs;
            if (percent > 0) params.ddd_lampa_percent = Utils.clamp(percent, 0, 100);
            if (session.selectedAudioTrack) params.ddd_audio_track = session.selectedAudioTrack;
            if (session.selectedAudioTrackId) params.ddd_audio_track_id = session.selectedAudioTrackId;
            if (session.selectedAudioTrackIndex !== undefined && session.selectedAudioTrackIndex !== null && session.selectedAudioTrackIndex !== '') params.ddd_audio_track_index = session.selectedAudioTrackIndex;
            if (session.selectedAudioTrackLanguage) params.ddd_audio_track_language = session.selectedAudioTrackLanguage;
            if (session.selectedAudioTrackMime) params.ddd_audio_track_mime = session.selectedAudioTrackMime;
            if (session.selectedAudioTrackChannels !== undefined && session.selectedAudioTrackChannels !== null && session.selectedAudioTrackChannels !== '') params.ddd_audio_track_channels = session.selectedAudioTrackChannels;

            return params;
        }

        function compactNativeSyncItem(params, index) {
            params = params || {};

            return {
                index: Number(index || 0),
                contentKey: params.ddd_content_key || '',
                sourceKey: params.ddd_source_key || '',
                timelineHash: params.ddd_timeline_hash || '',
                sourceKind: params.ddd_source_kind || '',
                title: params.ddd_title || '',
                filename: params.ddd_filename || '',
                positionMs: Number(params.ddd_lampa_position || 0),
                durationMs: Number(params.ddd_lampa_duration || 0),
                percent: Number(params.ddd_lampa_percent || 0),
                audioTrack: params.ddd_audio_track || '',
                audioTrackId: params.ddd_audio_track_id || '',
                audioTrackIndex: params.ddd_audio_track_index,
                audioTrackLanguage: params.ddd_audio_track_language || '',
                audioTrackMime: params.ddd_audio_track_mime || '',
                audioTrackChannels: params.ddd_audio_track_channels
            };
        }

        function buildRemotePlaylistSnapshot(session) {
            session = session || {};

            var playlist = Array.isArray(session.playlist) ? session.playlist : [];
            var result = [];

            for (var index = 0; index < playlist.length && index < 200; index++) {
                var item = playlist[index] || {};
                var itemUrl = item.url || item.uri || item.src || '';
                if (!itemUrl) continue;

                var params = buildRemoteFragmentParams(itemUrl, session, item, index);
                var contentKeyMatch = String(params.ddd_content_key || '').match(/:s(\d+):e(\d+)$/i);
                var keySeason = contentKeyMatch ? Number(contentKeyMatch[1] || 0) : 0;
                var keyEpisode = contentKeyMatch ? Number(contentKeyMatch[2] || 0) : 0;

                result.push({
                    index: index,
                    contentKey: String(params.ddd_content_key || '').slice(0, 256),
                    sourceKey: String(params.ddd_source_key || '').slice(0, 256),
                    timelineHash: String(params.ddd_timeline_hash || '').slice(0, 256),
                    sourceKind: String(params.ddd_source_kind || '').slice(0, 256),
                    uri: Utils.stripFragment(Utils.stripDddQueryParams(itemUrl || '')).slice(0, 4096),
                    title: String(params.ddd_title || item.title || item.name || '').slice(0, 512),
                    filename: String(params.ddd_filename || item.filename || item.file_name || '').slice(0, 512),
                    season: Number(item.season || item.season_number || item.s || keySeason || 0),
                    episode: Number(item.episode || item.episode_number || item.e || keyEpisode || 0),
                    position: Number(params.ddd_lampa_position || 0),
                    duration: Number(params.ddd_lampa_duration || 0),
                    percent: Number(params.ddd_lampa_percent || 0)
                });
            }

            return result;
        }

        function applyNativeSyncHeader(data, session) {
            if (!Utils.isAndroidPlatform() || !CONFIG.dddRemoteEnabled) return data;
            if (!data || !session || !session.sid) return data;

            var activeIndex = Number(
                data.playlist_index !== undefined ? data.playlist_index :
                data.start_index !== undefined ? data.start_index :
                session.playlistIndex !== undefined ? session.playlistIndex :
                session.startIndex || 0
            );

            if (isNaN(activeIndex) || activeIndex < 0) activeIndex = 0;

            var activeItem = session.currentItem || data.currentItem || null;
            var activeUrl = data.url || data.uri || data.src || '';
            var activeParams = buildRemoteFragmentParams(
                activeUrl,
                session,
                activeItem || {},
                activeIndex
            );

            if (!activeParams.ddd_remote_events_url || !activeParams.ddd_device_id) return data;

            var items = [];
            var playlist = Array.isArray(data.playlist) ? data.playlist : [];

            if (playlist.length) {
                playlist.forEach(function (item, index) {
                    item = item || {};
                    var itemUrl = item.url || item.uri || item.src || '';
                    var itemParams = buildRemoteFragmentParams(itemUrl, session, item, index);
                    items.push(compactNativeSyncItem(itemParams, index));
                });
            } else {
                items.push(compactNativeSyncItem(activeParams, activeIndex));
            }

            var envelope = {
                version: 1,
                eventsUrl: activeParams.ddd_remote_events_url,
                latestUrl: activeParams.ddd_remote_latest_url || '',
                schema: Number(activeParams.ddd_remote_schema || 1),
                deviceId: activeParams.ddd_device_id,
                sessionId: session.sid,
                activeIndex: activeIndex,
                items: items
            };

            var headers = {};

            if (data.headers && typeof data.headers === 'object' && !Array.isArray(data.headers)) {
                Object.keys(data.headers).forEach(function (key) {
                    headers[key] = data.headers[key];
                });
            } else if (Array.isArray(data.headers)) {
                for (var i = 0; i + 1 < data.headers.length; i += 2) {
                    headers[data.headers[i]] = data.headers[i + 1];
                }
            }

            headers['X-Lampa-DDD-Sync'] = encodeURIComponent(JSON.stringify(envelope));
            data.headers = headers;

            return data;
        }

        function postTimelineProgress(session, hash, road, reason) {
            if (!CONFIG.dddRemoteEnabled || !session || !hash || !road) return false;

            var current = Utils.now();
            var previous = Number(lastRemoteTimelinePostByHash[hash] || 0);
            if (current - previous < 1000) return false;

            var item = session.currentItem || {};
            var index = Number(session.playlistIndex !== undefined ? session.playlistIndex : session.startIndex || 0);
            var playlist = Array.isArray(session.playlist) ? session.playlist : [];

            for (var i = 0; i < playlist.length; i++) {
                if (String(itemTimelineHash(session, playlist[i], i)) === String(hash)) {
                    item = playlist[i] || item;
                    index = i;
                    break;
                }
            }

            session.lampaTime = Number(road.time || 0);
            session.lampaDuration = Number(road.duration || 0);
            session.lampaPercent = Number(road.percent || 0);

            var url = item.url || item.uri || item.src || session.url || '';
            var params = buildRemoteFragmentParams(url, session, item, index);
            if (!params.ddd_remote_events_url || !params.ddd_device_id) return false;

            var body = {
                schema: 1,
                deviceId: params.ddd_device_id,
                events: [{
                    schema: 1,
                    type: 'position_tick',
                    client: 'lampa-native',
                    sessionId: session.sid || '',
                    ts: current,
                    context: {
                        contentKey: String(params.ddd_content_key || '').slice(0, 256),
                        sourceKey: String(params.ddd_source_key || '').slice(0, 256),
                        timelineHash: String(hash).slice(0, 256),
                        sourceKind: String(params.ddd_source_kind || '').slice(0, 256),
                        uri: Utils.stripFragment(url || '').slice(0, 4096),
                        title: String(params.ddd_title || session.title || '').slice(0, 512),
                        filename: String(params.ddd_filename || '').slice(0, 512),
                        playlist: buildRemotePlaylistSnapshot(session)
                    },
                    payload: {
                        position: msFromSeconds(road.time),
                        duration: msFromSeconds(road.duration),
                        percent: Utils.clamp(Number(road.percent || 0), 0, 100),
                        windowIndex: index,
                        playlistSize: playlist.length,
                        isPlaying: false,
                        reason: reason || 'lampa_timeline_update'
                    }
                }]
            };

            lastRemoteTimelinePostByHash[hash] = current;
            postJson(params.ddd_remote_events_url, body, function (err) {
                if (err) {
                    delete lastRemoteTimelinePostByHash[hash];
                    try { console.warn('[ContinueWatching DDD] timeline remote failed', hash, String(err.message || err)); } catch (e) {}
                    Utils.warn('DDD native timeline remote save failed', String(err.message || err));
                    return;
                }

                if (DDD_DEBUG || DDD_TRACE) {
                    try { console.warn('[ContinueWatching DDD] timeline remote saved', hash, Math.floor(Number(road.time || 0))); } catch (e) {}
                }
                Utils.log('DDD native timeline remote save ok', hash, Math.floor(Number(road.time || 0)));
            });

            return true;
        }

        function postTimelineByHash(hash, road, reason) {
            if (!CONFIG.dddRemoteEnabled || !hash || !road) return false;

            var session = SessionManager.getByHash(hash) || SessionManager.getCurrent();
            if (session && timelineSessionHashMatches(session, hash)) {
                return postTimelineProgress(session, hash, road, reason);
            }

            var current = Utils.now();
            var previous = Number(lastRemoteTimelinePostByHash[hash] || 0);
            if (current - previous < 1000) return false;

            var eventsUrl = makeRemoteUrl(CONFIG.dddRemoteEventsUrl || CONFIG.dddRemoteEventsPath || '/ddd-sync/v1/events');
            var deviceId = getRemoteDeviceId();
            if (!eventsUrl || !deviceId) return false;

            var timelineKey = 'timeline:' + String(hash);
            var body = {
                schema: 1,
                deviceId: deviceId,
                events: [{
                    schema: 1,
                    type: 'position_tick',
                    client: 'lampa-native',
                    sessionId: session && session.sid || '',
                    ts: current,
                    context: {
                        contentKey: timelineKey,
                        sourceKey: timelineKey,
                        timelineHash: String(hash),
                        sourceKind: 'lampa-timeline',
                        uri: '',
                        title: session && session.title || '',
                        filename: ''
                    },
                    payload: {
                        position: msFromSeconds(road.time),
                        duration: msFromSeconds(road.duration),
                        percent: Utils.clamp(Number(road.percent || 0), 0, 100),
                        windowIndex: session ? Number(session.playlistIndex || session.startIndex || 0) : 0,
                        playlistSize: session && Array.isArray(session.playlist) ? session.playlist.length : 0,
                        isPlaying: false,
                        reason: reason || 'lampa_timeline_update'
                    }
                }]
            };

            lastRemoteTimelinePostByHash[hash] = current;
            postJson(eventsUrl, body, function (err) {
                if (err) {
                    delete lastRemoteTimelinePostByHash[hash];
                    try { console.warn('[ContinueWatching DDD] timeline remote failed', hash, String(err.message || err)); } catch (e) {}
                    Utils.warn('DDD timeline hash remote save failed', String(err.message || err));
                    return;
                }

                if (DDD_DEBUG || DDD_TRACE) {
                    try { console.warn('[ContinueWatching DDD] timeline remote saved', hash, Math.floor(Number(road.time || 0))); } catch (e) {}
                }
                Utils.log('DDD timeline hash remote save ok', hash, Math.floor(Number(road.time || 0)));
            });

            return true;
        }

        function timelineSessionHashMatches(session, hash) {
            if (!session || !hash) return false;
            if (String(session.hash || '') === String(hash)) return true;

            var playlist = Array.isArray(session.playlist) ? session.playlist : [];
            for (var i = 0; i < playlist.length; i++) {
                if (String(itemTimelineHash(session, playlist[i], i)) === String(hash)) return true;
            }

            return false;
        }

        function fetchRemoteLatest(call) {
            if (!CONFIG.dddRemoteEnabled) return call(new Error('remote disabled'), null);

            var latestUrl = makeRemoteUrl(CONFIG.dddRemoteLatestUrl || CONFIG.dddRemoteLatestPath || '/ddd-sync/v1/latest');

            if (!latestUrl) return call(new Error('remote latest unavailable'), null);

            var query = Utils.encodeParams({
                since: 0,
                limit: 1000
            });
            var url = latestUrl + (latestUrl.indexOf('?') === -1 ? '?' : '&') + query;

            fetchJson(url, call);
        }

        function appendToUrl(url, sid, index, startIndex, session, item) {
            if (!url || typeof url !== 'string') return url;

            index = Number(index || 0);
            startIndex = Number(startIndex || 0);

            var params = {
                ddd_mode: CONFIG.dddMode || 'local',
                ddd_client: CONFIG.dddClient,
                ddd_sid: sid,
                ddd_port: CONFIG.dddPort,
                ddd_token: CONFIG.dddToken || sid,
                ddd_i: index,
                ddd_start: startIndex,
                ddd_playlist_size: session && Array.isArray(session.playlist)
                    ? session.playlist.length
                    : 0
            };

            var remoteParams = buildRemoteFragmentParams(url, session, item, index);
            Object.keys(remoteParams).forEach(function (key) {
                params[key] = remoteParams[key];
            });

            // A play object can be reused by Lampa. Keep exactly one bridge
            // session in its URL so the native player and event poller share a SID.
            var cleanUrl = Utils.stripDddQueryParams(Utils.stripFragment(url));
            var queryUrl = Utils.appendQueryParams(cleanUrl, params);

            // Android's native wrapper drops URI fragments while copying the
            // playlist into an Intent. Query metadata survives that boundary;
            // DDD2 removes it before opening the stream in Media3.
            return Utils.appendFragmentParams(queryUrl, params);
        }

        function applyBridgeExtras(data, session) {
            if (!data || !session || !session.sid) return data;

            data.bridge_enabled = true;
            data.bridge_session_id = session.sid;
            data.bridge_client = CONFIG.dddClient;
            data.bridge_mode = CONFIG.dddMode || 'local';
            data.bridge_emit_position = true;
            data.bridge_emit_user_actions = true;
            data.bridge_position_interval_ms = 1000;
            data.bridge_schema_version = 1;
            data.bridge_local_port = CONFIG.dddPort;

            data.bridge_local_token = CONFIG.dddToken || session.sid;

            data.ddd_sid = session.sid;
            data.ddd_mode = CONFIG.dddMode || 'local';
            data.ddd_port = CONFIG.dddPort;
            data.ddd_client = CONFIG.dddClient;
            data.ddd_token = CONFIG.dddToken || session.sid;
            data.ddd_i = Number(data.playlist_index || data.start_index || session.playlistIndex || session.startIndex || 0);
            data.ddd_start = Number(data.playlist_index || data.start_index || session.playlistIndex || session.startIndex || 0);

            return data;
        }

        function applyBridgeToPlaylist(data, session) {
            if (!data || !session || !session.sid) return data;
            if (!Array.isArray(data.playlist) || !data.playlist.length) return data;

            var startIndex = Number(
                data.start_index !== undefined ? data.start_index :
                data.playlist_index !== undefined ? data.playlist_index :
                session.playlistIndex !== undefined ? session.playlistIndex :
                session.startIndex !== undefined ? session.startIndex :
                0
            );

            if (isNaN(startIndex) || startIndex < 0) startIndex = 0;
            if (startIndex >= data.playlist.length) startIndex = data.playlist.length - 1;

            data.start_index = startIndex;
            data.playlist_index = startIndex;

            var patchedCount = 0;

            data.playlist.forEach(function (item, i) {
                if (!item || typeof item !== 'object') return;

                var url = item.url || item.uri || item.src || '';

                if (!url || typeof url !== 'string') return;
                if (!Utils.isRemoteMediaUrl(url)) return;

                var patched = appendToUrl(url, session.sid, i, startIndex, session, item);

                if (item.url !== undefined) item.url = patched;
                else if (item.uri !== undefined) item.uri = patched;
                else if (item.src !== undefined) item.src = patched;

                patchedCount++;
            });

            if (patchedCount) {
                Utils.log('DDD playlist bridge applied', 'sid=' + session.sid, 'start=' + startIndex, 'items=' + patchedCount);
                Utils.noty('DDD playlist bridge: start=' + startIndex + ' items=' + patchedCount, false, 2);
            }

            return data;
        }

        function launchViaLocalBridge(data, session, call, force) {
            if (!force && !shouldLaunchViaLocalBridge()) {
                return call(new Error('local bridge launch disabled'), null);
            }

            if (!data || !session || !session.sid) {
                return call(new Error('local bridge launch missing session'), null);
            }

            var payload = {
                version: PLUGIN_VERSION,
                source: 'lampa',
                session: session,
                data: data
            };

            var params = {
                sid: session.sid,
                token: CONFIG.dddToken || session.sid
            };

            fetchFirstJson(endpointList('/ping', [{}]), 'launch-ping', function (pingErr, pingJson) {
                if (
                    pingErr ||
                    !pingJson ||
                    pingJson.ok === false ||
                    pingJson.launch !== true
                ) {
                    return call(pingErr || new Error('local bridge does not advertise launch'), pingJson);
                }

                postFirstJson(endpointList('/launch', [params, { sid: session.sid }, {}]), 'launch', payload, function (err, json) {
                    if (err || !json || json.ok === false) {
                        return call(err || new Error(json && json.error || 'bad launch response'), json);
                    }

                    Utils.log('DDD local bridge launch ok', session.sid, json.service || '', json.sessionId || '');
                    call(null, json);
                });
            });
        }

        function launchWhenReady(data, session) {
            // AndroidJS.openPlayer already sends the complete native playlist.
            // A second bridge launch races the chooser and drops player-specific extras.
            return;
        }

        function activate(session) {
            if (!session || !session.sid) return;
            if (!canUse()) return;

            // MPV2 posts progress directly to /ddd-sync/v1/events. Polling the
            // native 127.0.0.1 bridge here only creates timeouts on browsers/TVs.
            if (Utils.isMpv2Player()) return;

            if (stopPreviousDDDTransport) {
                try {
                    stopPreviousDDDTransport();
                } catch (e) {}
            }

            activeSid = session.sid;
            lastTs = 0;
            lastStateTs = 0;
            lastPingAt = 0;
            lastGoodAt = 0;
            lastEventsError = '';
            lastStateError = '';

            Utils.log('DDD activate', activeSid, session.url || '');
            Utils.noty(
                'DDD activate ' + activeSid +
                ' hash=' + (session.hash || '-') +
                ' S' + (session.season || 0) + 'E' + (session.episode || 0),
                true,
                1
            );

            startPolling();
        }

        function normalizeBridgeEvent(event) {
            if (!event || typeof event !== 'object') return null;

            var payload = event.payload || {};
            var rawType = payload.type || event.type || '';
            var type = '';
            var time = 0;
            var duration = 0;
            var playlistIndex = payload.windowIndex;

            if (playlistIndex === undefined || playlistIndex === null) playlistIndex = payload.index;

            rawType = String(rawType)
                .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
                .replace(/[\s-]+/g, '_')
                .toLowerCase();

            if (rawType === 'session_started') type = 'start';
            else if (rawType === 'position_tick') type = 'time';
            else if (rawType === 'playback_state_changed') type = payload.isPlaying ? 'play' : 'pause';
            else if (rawType === 'seek_completed') type = 'time';
            else if (rawType === 'playlist_item_changed') type = 'playlist_item_changed';
            else if (rawType === 'before_playlist_item_changed') type = 'before_playlist_item_changed';
            else if (rawType === 'playback_ended') type = 'ended';
            else if (rawType === 'session_finished') type = 'stop';
            else if (rawType === 'error') type = 'error';
            else if (rawType === 'track_selection_changed') type = 'track_selection_changed';
            else return null;

            if (rawType === 'seek_completed') time = Utils.msToSeconds(payload.toPosition || payload.position || 0);
            else time = Utils.msToSeconds(payload.position || 0);

            duration = Utils.msToSeconds(payload.duration || 0);

            return {
                source: 'ddd',
                type: type,
                rawType: rawType,
                sid: event.sessionId || payload.sessionId || activeSid,
                ts: event.ts || payload.ts || Utils.now(),
                url: payload.uri || (payload.currentItem && (payload.currentItem.uri || payload.currentItem.url)) || '',
                title: payload.title || (payload.currentItem && payload.currentItem.title) || '',
                time: time,
                duration: duration,
                percent: duration ? Math.round(time / duration * 100) : 0,
                playlist_index: playlistIndex !== undefined && playlistIndex !== null ? Number(playlistIndex) : undefined,
                reason: payload.reason || payload.endBy || payload.end_by || '',
                currentItem: payload.currentItem || null,
                rawPayload: payload,
                force:
                    rawType === 'session_finished' ||
                    rawType === 'playback_ended' ||
                    rawType === 'error' ||
                    payload.reason === 'pause' ||
                    payload.reason === 'background' ||
                    payload.reason === 'destroy' ||
                    payload.reason === 'user_exit' ||
                    payload.reason === 'before_playlist_item_changed'
            };
        }

        function handleBridgeEvent(event) {
            var normalized = normalizeBridgeEvent(event);
            if (!normalized) return;

            if (
                DEBUG.enabled &&
                (normalized.rawType === 'session_finished' || normalized.rawType === 'seek_completed')
            ) {
                Utils.noty(
                    'DDD event ' + normalized.rawType + ' t=' + Math.floor(normalized.time || 0),
                    true,
                    0
                );
            }

            Utils.log('DDD event', normalized.rawType, 'idx=' + normalized.playlist_index, 't=' + normalized.time, normalized.title || '');

            if (normalized.playlist_index !== undefined && normalized.playlist_index !== null) {
                SessionManager.updateByPlaylistIndex(normalized.playlist_index, normalized.rawPayload || normalized);
            }

            normalized.session = SessionManager.getCurrent();

            Core.consume(normalized);
        }

        function eventParamVariants() {
            var limit = CONFIG.dddEventsLimit;
            var since = lastTs || 0;

            return [
                { sid: activeSid, token: CONFIG.dddToken || activeSid, since: since, limit: limit },
                { sid: activeSid, token: CONFIG.dddToken || activeSid, limit: limit },
                { sid: activeSid, token: CONFIG.dddToken || activeSid },
                { sessionId: activeSid, token: CONFIG.dddToken || activeSid, since: since, limit: limit },
                { session_id: activeSid, token: CONFIG.dddToken || activeSid, since: since, limit: limit },
                { sid: activeSid, since: since, limit: limit },
                { sid: activeSid, limit: limit },
                { sid: activeSid }
            ];
        }

        function stateParamVariants() {
            return [
                { sid: activeSid, token: CONFIG.dddToken || activeSid },
                { sessionId: activeSid, token: CONFIG.dddToken || activeSid },
                { session_id: activeSid, token: CONFIG.dddToken || activeSid },
                { sid: activeSid },
                { sessionId: activeSid },
                { session_id: activeSid },
                {}
            ];
        }

        function pollEvents() {
            if (!activeSid) return;

            fetchFirstJson(endpointList('/events', eventParamVariants()), 'events', function (err, json) {
                if (err || !json || json.ok === false || !Array.isArray(json.events)) {
                    lastEventsError = err && err.message ? err.message : (json ? 'bad events response' : 'empty events response');
                    if (DEBUG.pollFail) Utils.warn('DDD events poll failed', lastEventsError);
                    return;
                }

                if (DEBUG.pollSuccess) Utils.noty('DDD events: ' + json.events.length, false, 3);

                json.events.sort(function (a, b) {
                    return Number(a.ts || 0) - Number(b.ts || 0);
                });

                json.events.forEach(function (event) {
                    if (event && event.ts) lastTs = Math.max(lastTs, Number(event.ts || 0));
                    handleBridgeEvent(event);
                });
            });
        }

        function pollState() {
            if (!activeSid) return;

            fetchFirstJson(endpointList('/state', stateParamVariants()), 'state', function (err, json) {
                if (err || !json || json.ok === false || !json.state) {
                    lastStateError = err && err.message ? err.message : (json ? 'bad state response' : 'empty state response');
                    if (DEBUG.pollFail) Utils.warn('DDD state poll failed', lastStateError);
                    return;
                }

                if (DEBUG.pollSuccess) Utils.noty('DDD state: ok', false, 3);

                var event = json.state.lastEvent || json.state.event || null;

                if (!event) return;

                if (event.ts && event.ts <= lastStateTs) return;
                if (event.ts) lastStateTs = Math.max(lastStateTs, Number(event.ts || 0));

                handleBridgeEvent(event);
            });
        }

        function pollPing(force) {
            var current = Utils.now();

            if (!force && current - lastPingAt < 5000) return;

            lastPingAt = current;

            fetchFirstJson(endpointList('/ping', [{}]), 'ping', function (err, json) {
                lastProbeResult = {
                    ok: !err && !!json && json.ok !== false,
                    error: err ? String(err.message || err) : '',
                    json: json || null,
                    time: Utils.now()
                };

                if (DEBUG.pollSuccess || force) {
                    Utils.noty(lastProbeResult.ok ? 'DDD ping: ok' : 'DDD ping: fail ' + lastProbeResult.error, true, lastProbeResult.ok ? 2 : 0);
                }
            });
        }

        function pollCycle() {
            if (!activeSid) return;

            pollPing(false);
            pollState();
            pollEvents();
        }

        function startPolling() {
            if (pollTimer) clearInterval(pollTimer);

            pollCycle();

            pollTimer = setInterval(function () {
                pollCycle();
            }, CONFIG.dddPollIntervalMs);
        }

        function stopPolling() {
            if (pollTimer) clearInterval(pollTimer);

            pollTimer = null;
            activeSid = '';
            lastTs = 0;
            lastStateTs = 0;

            Utils.log('DDD polling stopped');
        }

        function probe(force) {
            pollPing(!!force);
        }

        function getStatus() {
            return {
                activeSid: activeSid,
                lastTs: lastTs,
                lastStateTs: lastStateTs,
                lastProbeResult: lastProbeResult,
                lastEventsError: lastEventsError,
                lastStateError: lastStateError,
                lastGoodAt: lastGoodAt,
                canUse: canUse(),
                baseUrl: baseUrl(),
                baseUrls: baseUrls()
            };
        }

        return {
            canUse: canUse,
            shouldLaunchViaLocalBridge: shouldLaunchViaLocalBridge,
            appendToUrl: appendToUrl,
            applyBridgeExtras: applyBridgeExtras,
            applyNativeSyncHeader: applyNativeSyncHeader,
            applyBridgeToPlaylist: applyBridgeToPlaylist,
            postTimelineProgress: postTimelineProgress,
            postTimelineByHash: postTimelineByHash,
            launchViaLocalBridge: launchViaLocalBridge,
            launchWhenReady: launchWhenReady,
            fetchRemoteLatest: fetchRemoteLatest,
            activate: activate,
            stopPolling: stopPolling,
            probe: probe,
            getStatus: getStatus
        };
    })();

    // ============================================================
    // NativeTimelineSync
    // ============================================================

    var NativeTimelineSync = (function () {
        var installed = false;
        var inFlight = false;
        var waiters = [];
        var cachedItems = [];
        var cachedAt = 0;
        var appliedRemoteAtByHash = {};
        var localClockByHash = {};
        var suppressUntilByHash = {};
        var focusTimer = null;
        var initialSyncComplete = false;
        var CACHE_MS = 1500;

        function recordHash(record) {
            return String(record && record.timelineHash || '');
        }

        function parseContentKey(value) {
            var match = String(value || '').match(/^tmdb:([^:]+)(?::s(\d+):e(\d+))?$/i);

            return {
                movieId: match ? String(match[1] || '') : '',
                season: match ? Number(match[2] || 0) : 0,
                episode: match ? Number(match[3] || 0) : 0
            };
        }

        function hasPosition(record) {
            if (!record || typeof record !== 'object') return false;

            var position = Number(record.position || 0);
            var duration = Number(record.duration || 0);
            var reason = String(record.reason || record.eventType || '').toLowerCase();

            if (position <= 0 && duration <= 0 && /session_started|lampa_launch|state_ready/.test(reason)) {
                return false;
            }

            return Object.prototype.hasOwnProperty.call(record, 'position') || !!record.finished;
        }

        function beginExternalApply(hash, eventTimestamp) {
            hash = String(hash || '');
            if (!hash) return;

            suppressUntilByHash[hash] = Utils.now() + 2000;
            localClockByHash[hash] = Math.max(
                Number(localClockByHash[hash] || 0),
                Number(eventTimestamp || Utils.now())
            );
        }

        function isExternalApply(hash) {
            hash = String(hash || '');
            var until = Number(suppressUntilByHash[hash] || 0);

            if (until > Utils.now()) return true;
            if (until) delete suppressUntilByHash[hash];

            return false;
        }

        function noteLocal(hash) {
            hash = String(hash || '');
            if (!hash || !initialSyncComplete) return;
            localClockByHash[hash] = Utils.now();
        }

        function applyRecord(record, force) {
            var hash = recordHash(record);
            var updatedAt = Number(record && record.updatedAt || 0);

            if (!hash || !updatedAt || !hasPosition(record)) return false;
            if (!force && updatedAt <= Number(appliedRemoteAtByHash[hash] || 0)) return false;
            if (!force && updatedAt < Number(localClockByHash[hash] || 0)) return false;
            if (!Lampa.Timeline || !Lampa.Timeline.update || !Lampa.Timeline.view) return false;

            var current = Lampa.Timeline.view(hash) || {};
            var time = Utils.msToSeconds(record.position || 0);
            var duration = Utils.msToSeconds(record.duration || 0) || Number(current.duration || 0);
            var percent = duration > 0 ? Math.round(time / duration * 100) : Number(current.percent || 0);

            if (record.finished) {
                percent = 100;
                if (duration > 0) time = duration;
            }

            percent = Utils.clamp(percent, 0, 100);

            if (
                Math.abs(Number(current.time || 0) - time) < 0.5 &&
                Math.abs(Number(current.duration || 0) - duration) < 0.5 &&
                Number(current.percent || 0) === percent
            ) {
                appliedRemoteAtByHash[hash] = Math.max(
                    Number(appliedRemoteAtByHash[hash] || 0),
                    updatedAt
                );
                return false;
            }

            beginExternalApply(hash, updatedAt);

            try {
                Lampa.Timeline.update({
                    hash: hash,
                    time: time,
                    duration: duration,
                    percent: percent,
                    profile: Number(current.profile || 0),
                    received: true
                });
            } catch (e) {
                delete suppressUntilByHash[hash];
                Utils.error('Native timeline remote apply failed', e);
                return false;
            }

            appliedRemoteAtByHash[hash] = updatedAt;
            return true;
        }

        function newestByTimeline(items) {
            var newest = {};

            (items || []).forEach(function (record) {
                var hash = recordHash(record);
                if (!hash || !hasPosition(record)) return;

                if (!newest[hash] || Number(record.updatedAt || 0) > Number(newest[hash].updatedAt || 0)) {
                    newest[hash] = record;
                }
            });

            return newest;
        }

        function findLatestForMovie(movie, items) {
            if (!movie) return null;

            var movieId = String(movie.id || movie.movie_id || movie.tmdb_id || movie.tmdbId || '');
            if (!movieId) return null;

            var latest = null;

            (items || []).forEach(function (record) {
                var parsed = parseContentKey(record && record.contentKey);
                if (!parsed.movieId || parsed.movieId !== movieId || !parsed.season || !parsed.episode) return;
                if (!hasPosition(record)) return;

                if (!latest || Number(record.updatedAt || 0) > Number(latest.record.updatedAt || 0)) {
                    latest = { record: record, parsed: parsed };
                }
            });

            return latest;
        }

        function updateNativeLastWatched(movie, items) {
            if (!movie || !Lampa.Storage || !Lampa.Storage.get || !Lampa.Storage.set) return;

            var latest = findLatestForMovie(movie, items);
            if (!latest) return;

            var original = movie.number_of_seasons
                ? (movie.original_name || movie.original_title || '')
                : (movie.original_title || movie.original_name || '');
            if (!original || !Lampa.Utils || !Lampa.Utils.hash) return;

            var key = Lampa.Utils.hash(original);
            var watched = Lampa.Storage.get('online_watched_last', {});
            if (!watched || typeof watched !== 'object' || Array.isArray(watched)) watched = {};
            if (!watched[key] || typeof watched[key] !== 'object') watched[key] = {};

            watched[key].season = latest.parsed.season;
            watched[key].episode = latest.parsed.episode;
            Lampa.Storage.set('online_watched_last', watched);
        }

        function getLatestForMovie(movie) {
            return findLatestForMovie(movie, cachedItems);
        }

        function applyItems(items, movie, force) {
            var newest = newestByTimeline(items);
            var applied = 0;

            Object.keys(newest).forEach(function (hash) {
                if (applyRecord(newest[hash], force)) applied++;
            });

            updateNativeLastWatched(movie, items);
            return applied;
        }

        function finishFetch(err, json) {
            var callbacks = waiters.slice(0);
            waiters = [];
            inFlight = false;

            if (!err && json && Array.isArray(json.items)) {
                cachedItems = json.items;
                cachedAt = Utils.now();
            }

            // Lampa can emit Timeline.update while restoring its local state.
            // Those boot events must not outrank the server state merely because
            // this device opened the page a moment later.
            initialSyncComplete = true;

            callbacks.forEach(function (entry) {
                var applied = err ? 0 : applyItems(cachedItems, entry.movie, entry.force);
                try { entry.call(err, cachedItems, applied); } catch (e) {}
            });
        }

        function refresh(movie, call, force) {
            call = typeof call === 'function' ? call : function () {};

            if (!force && cachedAt && Utils.now() - cachedAt < CACHE_MS) {
                return call(null, cachedItems, applyItems(cachedItems, movie, false));
            }

            waiters.push({ movie: movie || null, call: call, force: !!force });
            if (inFlight) return;

            inFlight = true;
            DDDTransport.fetchRemoteLatest(finishFetch);
        }

        function scheduleRefresh() {
            clearTimeout(focusTimer);
            focusTimer = setTimeout(function () {
                refresh(Utils.getActivityMovie(), function () {}, false);
            }, 250);
        }

        function init() {
            if (installed) return;
            installed = true;

            try {
                window.addEventListener('focus', scheduleRefresh, false);
                document.addEventListener('visibilitychange', function () {
                    if (!document.hidden) scheduleRefresh();
                }, false);
            } catch (e) {}

            setTimeout(function () {
                refresh(Utils.getActivityMovie(), function () {}, false);
            }, 0);
        }

        function getStatus() {
            return {
                installed: installed,
                cachedItems: cachedItems.length,
                cachedAt: cachedAt,
                inFlight: inFlight,
                initialSyncComplete: initialSyncComplete
            };
        }

        return {
            init: init,
            refresh: refresh,
            applyItems: applyItems,
            applyRecord: applyRecord,
            getLatestForMovie: getLatestForMovie,
            beginExternalApply: beginExternalApply,
            isExternalApply: isExternalApply,
            noteLocal: noteLocal,
            getStatus: getStatus
        };
    })();

    // ============================================================
    // CardWatchedRepair
    // ============================================================

    var CardWatchedRepair = (function () {
        function movieId(movie) {
            return String(movie && (movie.id || movie.movie_id || movie.tmdb_id || movie.tmdbId) || '');
        }

        function recordTimeline(record, movie, season, episode) {
            var hash = String(record && record.timelineHash || '');

            if (!hash) hash = StorageManager.generateTimelineHash(movie, season, episode);
            if (!hash || !Lampa.Timeline || !Lampa.Timeline.view) return null;

            return Lampa.Timeline.view(hash);
        }

        function episodeRows(movie, latest) {
            var record = latest.record || {};
            var season = Number(latest.parsed && latest.parsed.season || 0);
            var episode = Number(latest.parsed && latest.parsed.episode || 0);
            var hash = String(record.timelineHash || StorageManager.generateTimelineHash(movie, season, episode) || '');
            var stored = hash ? StorageManager.getParams()[hash] : null;
            var source = Array.isArray(record.playlist) && record.playlist.length
                ? record.playlist
                : (stored && Array.isArray(stored.playlist) ? stored.playlist : []);
            var rows = [];
            var seen = {};

            function add(rowSeason, rowEpisode, title, current) {
                rowSeason = Number(rowSeason || 0);
                rowEpisode = Number(rowEpisode || 0);

                if (rowSeason !== season || rowEpisode < episode || !rowEpisode) return;

                var key = rowSeason + ':' + rowEpisode;
                if (seen[key]) return;
                seen[key] = true;

                rows.push({
                    season: rowSeason,
                    episode: rowEpisode,
                    title: String(title || ''),
                    current: !!current
                });
            }

            add(
                season,
                episode,
                stored && stored.episode_title || record.title || record.filename || '',
                true
            );

            source.forEach(function (item) {
                item = item || {};

                add(
                    item.season || item.season_number || item.s,
                    item.episode || item.episode_number || item.e,
                    item.title || item.name || '',
                    Number(item.season || item.season_number || item.s || 0) === season &&
                        Number(item.episode || item.episode_number || item.e || 0) === episode
                );
            });

            rows.sort(function (a, b) {
                return a.episode - b.episode;
            });

            return rows.slice(0, 5);
        }

        function render(card, movie, latest) {
            if (!card || !movie || !latest || !card.classList.contains('focus')) return;

            var record = latest.record || {};
            var season = Number(latest.parsed && latest.parsed.season || 0);
            var episode = Number(latest.parsed && latest.parsed.episode || 0);
            var signature = [
                movieId(movie),
                season,
                episode,
                Number(record.updatedAt || 0),
                Number(record.position || 0)
            ].join(':');
            var existing = card.querySelector('.card-watched[data-cwu-timeline="' + signature + '"]');

            if (existing) {
                Array.prototype.slice.call(card.querySelectorAll('.card-watched')).forEach(function (node) {
                    if (node !== existing) node.remove();
                });
                return;
            }

            var view = card.querySelector('.card__view');
            if (!view) return;

            var rows = episodeRows(movie, latest);
            if (!rows.length) return;

            var wrap = document.createElement('div');
            var inner = document.createElement('div');
            var body = document.createElement('div');

            wrap.className = 'card-watched';
            wrap.setAttribute('data-cwu-timeline', signature);
            inner.className = 'card-watched__inner';
            body.className = 'card-watched__body';
            inner.appendChild(body);
            wrap.appendChild(inner);

            rows.forEach(function (row) {
                var item = document.createElement('div');
                var label = document.createElement('span');
                var title = row.title;

                if (!title && Lampa.Lang && Lampa.Lang.translate) {
                    title = Lampa.Lang.translate('full_episode') + ' ' + row.episode;
                }

                item.className = 'card-watched__item';
                label.innerText = row.episode + ' - ' + title;
                item.appendChild(label);

                if (row.current) {
                    var timeline = recordTimeline(record, movie, row.season, row.episode);

                    if (timeline && Lampa.Timeline && Lampa.Timeline.render) {
                        var rendered = Lampa.Timeline.render(timeline);
                        var line = rendered && rendered[0] ? rendered[0] : rendered;
                        if (line && line.nodeType) item.appendChild(line);
                    }
                }

                body.appendChild(item);
            });

            Array.prototype.slice.call(card.querySelectorAll('.card-watched')).forEach(function (node) {
                node.remove();
            });

            view.insertBefore(wrap, view.firstChild);
        }

        function repair(card) {
            if (!card || !card.classList || !card.classList.contains('focus')) return;

            var movie = card.card_data;
            if (!movie || !movie.original_name || !movieId(movie)) return;

            var latest = NativeTimelineSync.getLatestForMovie(movie);

            if (latest) {
                render(card, movie, latest);
                return;
            }

            NativeTimelineSync.refresh(movie, function (err) {
                if (err || !card.isConnected || !card.classList.contains('focus')) return;
                render(card, movie, NativeTimelineSync.getLatestForMovie(movie));
            }, false);
        }

        function scan() {
            try {
                Array.prototype.slice.call(document.querySelectorAll('.card.focus')).forEach(repair);
            } catch (e) {
                Utils.error('Card timeline repair failed', e);
            }
        }

        return {
            scan: scan
        };
    })();

    // ============================================================
    // LampaNativeTransport
    // ============================================================

    var LampaNativeTransport = (function () {
        var installed = false;
        var timelineListenerInstalled = false;
        var stateListenerInstalled = false;
        var lastTimelineHash = '';
        var lastSavedTimelineAtByHash = {};
        var lastBridgeLaunchSid = '';
        var lastBridgeLaunchAt = 0;

        function getDataFromEvent(event) {
            if (!event) return null;
            if (event.data) return event.data;
            return event;
        }

        function handlePlayerCreate(event) {
            if (!CONFIG.nativePlayerEventsEnabled) return;

            var data = getDataFromEvent(event);

            if (!data || !data.url) return;

            var session = SessionManager.getCurrent();

            if (!session || Utils.streamIdentity(session.url) !== Utils.streamIdentity(data.url)) {
                var options = { source: 'lampa' };

                if (session) {
                    if ((!data.playlist || !data.playlist.length) && session.playlist && session.playlist.length) {
                        options.playlist = session.playlist;
                    }

                    if (!data.card && !data.movie && !data.card_data && !data.data && session.movie) {
                        options.movie = session.movie;
                    }
                }

                session = SessionManager.buildFromPlayData(data, options);
            }

            if (session) {
                Core.consume({
                    source: 'lampa',
                    type: 'start',
                    session: session,
                    hash: session.hash,
                    url: session.url,
                    title: session.title,
                    force: true
                });

                maybeRelaunchViaLocalBridge(data, session, 'player_' + (event && event.type || 'create'));
            }
        }

        function clonePlaylist(playlist) {
            if (!Array.isArray(playlist)) return [];

            return playlist.map(function (item) {
                return Utils.shallowClone(item || {});
            });
        }

        function maybeRelaunchViaLocalBridge(data, session, reason) {
            if (!CONFIG.dddPcBridgeLaunchEnabled) return;
            if (!DDDTransport.canUse()) return;
            if (!session || !session.sid) return;
            if (!Utils.isStreamUrl(session.url || (data && data.url))) return;
            if (!session.playlist || session.playlist.length <= 1) return;

            var now = Utils.now();

            if (lastBridgeLaunchSid === session.sid && now - lastBridgeLaunchAt < 10000) {
                return;
            }

            lastBridgeLaunchSid = session.sid;
            lastBridgeLaunchAt = now;

            var launchData = Utils.shallowClone(data || {});
            var playlistIndex = Number(session.playlistIndex || session.startIndex || launchData.playlist_index || launchData.start_index || 0);

            if (isNaN(playlistIndex) || playlistIndex < 0) playlistIndex = 0;
            if (playlistIndex >= session.playlist.length) playlistIndex = session.playlist.length - 1;

            launchData.url = session.url || launchData.url || launchData.uri || launchData.src || '';
            launchData.uri = launchData.url;
            launchData.src = launchData.url;
            launchData.title = session.title || launchData.title || '';
            launchData.playlist = clonePlaylist(session.playlist);
            launchData.playlist_index = playlistIndex;
            launchData.start_index = playlistIndex;
            launchData.currentItem = session.currentItem || launchData.playlist[playlistIndex] || null;

            try {
                DDDTransport.applyBridgeExtras(launchData, session);
                DDDTransport.applyBridgeToPlaylist(launchData, session);
                launchData.url = DDDTransport.appendToUrl(
                    launchData.url,
                    session.sid,
                    playlistIndex,
                    playlistIndex,
                    session,
                    launchData.currentItem
                );
                launchData.uri = launchData.url;
                launchData.src = launchData.url;
                DDDTransport.activate(session);
            } catch (e) {
                try {
                    console.warn('[ContinueWatching DDD] native bridge relaunch prepare failed', e);
                } catch (ce) {}
            }

            try {
                console.log(
                    '[ContinueWatching DDD] native bridge relaunch attempt',
                    reason || '',
                    session.sid,
                    'items=' + launchData.playlist.length,
                    'index=' + playlistIndex
                );
            } catch (e2) {}

            DDDTransport.launchViaLocalBridge(launchData, session, function (err, json) {
                if (!err && json && json.ok !== false) {
                    try {
                        console.log('[ContinueWatching DDD] native bridge relaunch ok', session.sid, json.sessionId || '');
                    } catch (e3) {}
                    return;
                }

                try {
                    console.warn('[ContinueWatching DDD] native bridge relaunch failed', err && err.message ? err.message : err);
                } catch (e4) {}
            }, true);
        }

        function handlePlayerDestroy() {
            if (!CONFIG.nativePlayerEventsEnabled) return;

            var session = SessionManager.getCurrent();

            if (!session || !session.lastRoad) return;

            Core.consume({
                source: 'lampa',
                type: 'stop',
                session: session,
                hash: session.lastRoad.hash || session.hash,
                time: session.lastRoad.time || 0,
                duration: session.lastRoad.duration || 0,
                percent: session.lastRoad.percent || 0,
                force: true,
                reason: 'destroy'
            });
        }

        function timelineBelongsToSession(hash, session) {
            if (!hash || !session) return false;
            if (String(hash) === String(session.hash)) return true;
            if (SessionManager.getByHash(hash)) return true;

            return false;
        }

        function handleTimelineUpdate(event) {
            if (window.__CONTINUE_WATCH_DDD_LAYER_V3_VERSION__ !== PLUGIN_VERSION) return;
            if (!CONFIG.nativeTimelineEnabled) return;

            var data = event && event.data ? event.data : event;

            if (!data || !data.hash || !data.road) return;

            var hash = data.hash;
            var road = data.road || {};

            if (NativeTimelineSync.isExternalApply(hash)) {
                if (DDD_DEBUG || DDD_TRACE) {
                    try { console.warn('[ContinueWatching DDD] native timeline received', hash, Math.floor(Number(road.time || 0))); } catch (e0) {}
                }
                return;
            }

            NativeTimelineSync.noteLocal(hash);
            if (DDD_DEBUG || DDD_TRACE) {
                try { console.warn('[ContinueWatching DDD] timeline update', hash, Math.floor(Number(road.time || 0))); } catch (e) {}
            }
            // DDD2 publishes its own authoritative position ticks and final exit
            // event. Lampa receives a slightly older callback after Android
            // returns from DDD2; reposting it would roll server progress back.
            if (!(Utils.isAndroidPlatform() && Utils.isMpv2Player())) {
                DDDTransport.postTimelineByHash(hash, road, 'lampa_timeline_update');
            } else {
                if (DDD_DEBUG || DDD_TRACE) {
                    try { console.warn('[ContinueWatching DDD] timeline remote skipped for DDD2', hash); } catch (e2) {}
                }
            }
            var session = SessionManager.getCurrent();

            if (session && String(hash) !== String(session.hash || '') && SessionManager.hasHash(hash)) {
                session = SessionManager.updateByTimelineHash(hash, {
                    time: road.time,
                    duration: road.duration,
                    percent: road.percent,
                    reason: 'timeline_hash_switch'
                }) || session;
            }

            if (!session) session = SessionManager.getByHash(hash);

            if (!timelineBelongsToSession(hash, session)) {
                return;
            }

            lastTimelineHash = hash;

            if (CONFIG.saveNativeTimelineToCustomStorage) {
                Core.consume({
                    source: 'lampa',
                    type: 'time',
                    session: session,
                    hash: hash,
                    time: Number(road.time || 0),
                    duration: Number(road.duration || 0),
                    percent: Number(road.percent || 0),
                    force: false,
                    reason: 'timeline_update'
                });
            }

        }

        function handleStateChanged(event) {
            if (timelineListenerInstalled) return;
            if (!event || event.target !== 'timeline' || event.reason !== 'update') return;
            handleTimelineUpdate(event);
        }

        function installPlayerListeners() {
            if (!Lampa.Player || !Lampa.Player.listener || !Lampa.Player.listener.follow) return;

            try {
                Lampa.Player.listener.follow('create', handlePlayerCreate);
                Lampa.Player.listener.follow('start', handlePlayerCreate);
                Lampa.Player.listener.follow('ready', handlePlayerCreate);
                Lampa.Player.listener.follow('destroy', handlePlayerDestroy);
            } catch (e) {
                Utils.error('Native player listener failed', e);
            }
        }

        function installTimelineListener() {
            if (!timelineListenerInstalled && Lampa.Timeline && Lampa.Timeline.listener && Lampa.Timeline.listener.follow) {
                try {
                    Lampa.Timeline.listener.follow('update', handleTimelineUpdate);
                    timelineListenerInstalled = true;
                } catch (e) {
                    Utils.error('Native timeline listener failed', e);
                }
            }

            // Older Lampa builds without Timeline.listener use the global
            // state event. Never subscribe to both: they describe one update.
            if (!timelineListenerInstalled && !stateListenerInstalled && Lampa.Listener && Lampa.Listener.follow) {
                try {
                    Lampa.Listener.follow('state:changed', handleStateChanged);
                    stateListenerInstalled = true;
                } catch (e) {
                    Utils.error('Native state listener failed', e);
                }
            }
        }

        function init() {
            if (installed) return;

            installed = true;

            installPlayerListeners();
            installTimelineListener();
            setTimeout(installTimelineListener, 500);
            setTimeout(installTimelineListener, 1500);
            setTimeout(installTimelineListener, 4000);
        }

        function getStatus() {
            return {
                installed: installed,
                timelineListenerInstalled: timelineListenerInstalled,
                stateListenerInstalled: stateListenerInstalled,
                lastTimelineHash: lastTimelineHash
            };
        }

        return {
            init: init,
            getStatus: getStatus
        };
    })();

    // ============================================================
    // PlayerManager
    // ============================================================

    var PlayerManager = (function () {
        var patched = false;
        var androidPatched = false;

        function syncPlaylistTimelinesFromLampa(data, session) {
            if (!data || !session || !session.movie) return;
            if (!Lampa.Timeline || !Lampa.Timeline.view) return;

            var fallbackSeason = Number(session.season || data.season || 0);
            var isSeries = Utils.getMediaKind(session.movie) === 'tv';
            var lists = [];

            if (Array.isArray(data.playlist) && data.playlist.length) lists.push(data.playlist);
            if (
                Array.isArray(session.playlist) &&
                session.playlist.length &&
                session.playlist !== data.playlist
            ) {
                lists.push(session.playlist);
            }

            lists.forEach(function (playlist) {
                playlist.forEach(function (item, index) {
                if (!item || typeof item !== 'object') return;

                var se = Utils.extractSE(item, {
                    allowEpisodeOnly: true,
                    fallbackSeason: fallbackSeason
                });

                var season = Number(se.season || item.season || item.season_number || fallbackSeason || 0);
                var episode = Number(se.episode || item.episode || item.episode_number || 0);

                if (!episode && isSeries && fallbackSeason) episode = index + 1;
                if (!season || !episode) return;

                var hash = StorageManager.generateTimelineHash(session.movie, season, episode);
                if (!hash) return;

                var nativeTimeline = null;

                try {
                    nativeTimeline = Lampa.Timeline.view(hash);
                } catch (e) {}

                var timeline = Utils.shallowClone(nativeTimeline || item.timeline || {});
                timeline.hash = hash;

                item.season = season;
                item.episode = episode;
                item.timeline = timeline;
                });
            });
        }

        function playlistItemIndexForData(playlist, data) {
            if (!Array.isArray(playlist) || !playlist.length || !data) return -1;

            var url = Utils.stripFragment(data.url || data.uri || data.src || '');
            var identity = Utils.streamIdentity(url);
            var hash = data.timeline && data.timeline.hash ? String(data.timeline.hash) : '';

            for (var index = 0; index < playlist.length; index++) {
                var item = playlist[index] || {};
                var itemUrl = Utils.stripFragment(item.url || item.uri || item.src || '');
                var itemHash = item.timeline && item.timeline.hash ? String(item.timeline.hash) : '';

                if (hash && itemHash && hash === itemHash) return index;
                if (url && itemUrl === url) return index;
                if (identity && Utils.streamIdentity(itemUrl) === identity) return index;
            }

            return -1;
        }

        function inheritPlaylistContext(data, previousSession) {
            if (!data || !previousSession) return;

            if (!data.card && !data.movie && previousSession.movie) {
                data.card = previousSession.movie;
                data.movie = previousSession.movie;
            }

            if (
                (!Array.isArray(data.playlist) || !data.playlist.length) &&
                Array.isArray(previousSession.playlist) &&
                previousSession.playlist.length
            ) {
                data.playlist = previousSession.playlist.map(function (item) {
                    return Utils.shallowClone(item || {});
                });
            }

            if (!Array.isArray(data.playlist) || !data.playlist.length) return;

            var index = playlistItemIndexForData(data.playlist, data);
            if (index < 0) return;

            data.playlist_index = index;
            data.start_index = index;
            data.currentItem = data.playlist[index] || data.currentItem || null;
        }

        function checkpointOutgoingSession(session) {
            if (!session || !session.hash) return;

            var road = null;

            try {
                road = Lampa.Timeline && Lampa.Timeline.view
                    ? Lampa.Timeline.view(session.hash)
                    : null;
            } catch (e) {}

            if (!road) road = session.lastRoad || null;
            if (!road) return;

            Core.consume({
                source: 'lampa',
                type: 'stop',
                session: session,
                hash: session.hash,
                time: Number(road.time || 0),
                duration: Number(road.duration || 0),
                percent: Number(road.percent || 0),
                force: true,
                reason: 'before_player_switch'
            });
        }

        function applyMergedParamsToSession(session, params) {
            if (!session || !params) return session;

            session.remoteTimelineMerged = true;

            if (params.time !== undefined && params.time !== null && params.time !== '') {
                session.lampaTime = Number(params.time || 0);
            }

            if (params.duration !== undefined && params.duration !== null && params.duration !== '') {
                session.lampaDuration = Number(params.duration || 0);
            }

            if (params.percent !== undefined && params.percent !== null && params.percent !== '') {
                session.lampaPercent = Number(params.percent || 0);
            }

            if (params.selected_audio_track) session.selectedAudioTrack = params.selected_audio_track;
            if (params.selected_audio_track_id) session.selectedAudioTrackId = params.selected_audio_track_id;

            if (
                params.selected_audio_track_index !== undefined &&
                params.selected_audio_track_index !== null &&
                params.selected_audio_track_index !== ''
            ) {
                session.selectedAudioTrackIndex = params.selected_audio_track_index;
            }

            if (params.selected_audio_track_language) session.selectedAudioTrackLanguage = params.selected_audio_track_language;
            if (params.selected_audio_track_mime) session.selectedAudioTrackMime = params.selected_audio_track_mime;

            if (
                params.selected_audio_track_channels !== undefined &&
                params.selected_audio_track_channels !== null &&
                params.selected_audio_track_channels !== ''
            ) {
                session.selectedAudioTrackChannels = params.selected_audio_track_channels;
            }

            session.params = SessionManager.buildParams(session);
            return session;
        }

        function applyDddTransportToPlayData(data, session) {
            if (!data || !session) return;

            // MainActivity ignores the incoming JSON playlist when from_state
            // is true and reuses its previously persisted native state. That
            // stale state has no DDD URL metadata, so DDD2 cannot synchronize.
            // The canonical position is already merged into Lampa Timeline
            // below; force Android to persist the freshly patched playlist.
            if (Utils.isAndroidPlatform()) data.from_state = false;

            // Every playlist item needs the canonical Lampa timeline, including
            // its handler. Otherwise switching episodes starts at zero and the
            // new episode is not written back to the same Lampa history.
            syncPlaylistTimelinesFromLampa(data, session);

            function applySessionTimeline(target) {
                if (!target || typeof target !== 'object') return;

                var timeline = target.timeline;
                if (!timeline || typeof timeline !== 'object') {
                    timeline = {};
                    target.timeline = timeline;
                }

                if (session.hash && !timeline.hash) timeline.hash = session.hash;
                if (session.remoteTimelineMerged) timeline.__ddd_remote_merged = true;

                if (isFinite(Number(session.lampaTime))) {
                    timeline.time = Number(session.lampaTime);
                    target.time = Number(session.lampaTime);
                }

                if (isFinite(Number(session.lampaDuration))) {
                    timeline.duration = Number(session.lampaDuration);
                    target.duration = Number(session.lampaDuration);
                }

                if (isFinite(Number(session.lampaPercent))) {
                    timeline.percent = Number(session.lampaPercent);
                    target.percent = Number(session.lampaPercent);
                }
            }

            applySessionTimeline(data);

            if (Array.isArray(data.playlist) && data.playlist.length) {
                var activeIndex = Number(
                    data.playlist_index !== undefined ? data.playlist_index :
                    data.start_index !== undefined ? data.start_index :
                    session.playlistIndex !== undefined ? session.playlistIndex :
                    session.startIndex || 0
                );

                if (isNaN(activeIndex) || activeIndex < 0) activeIndex = 0;
                if (activeIndex >= data.playlist.length) activeIndex = data.playlist.length - 1;
                applySessionTimeline(data.playlist[activeIndex]);
            }

            DDDTransport.applyBridgeExtras(data, session);
            DDDTransport.applyNativeSyncHeader(data, session);
            DDDTransport.applyBridgeToPlaylist(data, session);

            data.url = DDDTransport.appendToUrl(
                data.url,
                session.sid,
                data.playlist_index || session.playlistIndex || 0,
                data.start_index || session.startIndex || 0,
                session,
                session.currentItem || data.currentItem || null
            );

            session.url = Utils.stripDddQueryParams(Utils.stripFragment(data.url));
            session.params = SessionManager.buildParams(session);
            SessionManager.register(session);

            DDDTransport.activate(session);

            Utils.log(
                'DDD transport selected',
                session.sid,
                data.url,
                'audio=' + (session.selectedAudioTrack || ''),
                'audioId=' + (session.selectedAudioTrackId || ''),
                'audioIndex=' + (
                    session.selectedAudioTrackIndex !== undefined &&
                    session.selectedAudioTrackIndex !== null
                        ? session.selectedAudioTrackIndex
                        : ''
                )
            );
        }

        function stripBridgeFragmentsForFallback(data) {
            if (!data || typeof data !== 'object') return data;

            ['url', 'uri', 'src'].forEach(function (key) {
                if (typeof data[key] === 'string') {
                    data[key] = Utils.stripFragment(data[key]);
                }
            });

            if (Array.isArray(data.playlist)) {
                data.playlist.forEach(function (item) {
                    if (!item || typeof item !== 'object') return;

                    ['url', 'uri', 'src'].forEach(function (key) {
                        if (typeof item[key] === 'string') {
                            item[key] = Utils.stripFragment(item[key]);
                        }
                    });
                });
            }

            return data;
        }

        function applyNativeTimelineToLaunch(session, data) {
            if (!session || !data || !session.hash) return session;
            if (!Lampa.Timeline || !Lampa.Timeline.view) return session;

            var timeline = Lampa.Timeline.view(session.hash);
            if (!timeline) return session;

            data.timeline = timeline;
            data.time = Number(timeline.time || 0);
            data.position = data.time > 0 ? data.time : -1;
            data.duration = Number(timeline.duration || 0);
            data.percent = Number(timeline.percent || 0);

            session.lampaTime = data.time;
            session.lampaDuration = data.duration;
            session.lampaPercent = data.percent;
            session.remoteTimelineMerged = true;

            if (Array.isArray(data.playlist) && data.playlist.length) {
                var index = Number(
                    data.playlist_index !== undefined ? data.playlist_index :
                    data.start_index !== undefined ? data.start_index :
                    session.playlistIndex !== undefined ? session.playlistIndex :
                    session.startIndex || 0
                );

                if (isNaN(index) || index < 0) index = 0;
                if (index >= data.playlist.length) index = data.playlist.length - 1;
                if (data.playlist[index]) data.playlist[index].timeline = timeline;
            }

            return session;
        }

        function mergeRemoteLatestBeforePlayerPatch(session, data, call) {
            NativeTimelineSync.refresh(session && session.movie, function (err, items) {
                try {
                    if (!err && Array.isArray(items) && session && session.movie) {
                        var matcher = findRemoteRecordForLaunch(session.movie, session.params || data || {});
                        var record = matcher(items);

                        if (record) {
                            NativeTimelineSync.applyRecord(record, true);
                        }

                        if (record && hasRemoteAudio(record)) {
                            var audio = copyRemoteAudioToParams({}, record);
                            Object.keys(audio).forEach(function (key) {
                                data[key] = audio[key];
                            });
                            applyMergedParamsToSession(session, audio);
                        }
                    }

                    applyNativeTimelineToLaunch(session, data);
                } catch (e) {
                    Utils.error('Native timeline launch merge failed', e);
                }

                call(session);
            }, false);
        }

        function patchAndroidOpenPlayer() {
            if (androidPatched) return;
            if (!Lampa.Android || typeof Lampa.Android.openPlayer !== 'function') return;

            if (Lampa.Android.openPlayer.__continueWatchDddFinalPatched) {
                androidPatched = true;
                return;
            }

            var originalAndroidOpenPlayer = Lampa.Android.openPlayer;
            var restoreNativePlaylistTimer = null;

            function forceNativePlaylistForLaunch(data) {
                if (!data || !Array.isArray(data.playlist) || data.playlist.length < 2) return;
                if (typeof AndroidJS === 'undefined' || typeof AndroidJS.storageChange !== 'function') return;

                var wasEnabled = true;

                try {
                    wasEnabled = !!(Lampa.Storage && Lampa.Storage.field && Lampa.Storage.field('playlist_next'));
                } catch (e) {}

                if (wasEnabled) return;

                try {
                    AndroidJS.storageChange(JSON.stringify({
                        name: 'playlist_next',
                        value: 'true'
                    }));

                    clearTimeout(restoreNativePlaylistTimer);
                    restoreNativePlaylistTimer = setTimeout(function () {
                        try {
                            AndroidJS.storageChange(JSON.stringify({
                                name: 'playlist_next',
                                value: 'false'
                            }));
                        } catch (e) {}
                    }, 2000);
                } catch (e) {
                    Utils.error('DDD Android playlist enable failed', e);
                }
            }

            function patchedAndroidOpenPlayer(link, data) {
                try {
                    data = data && typeof data === 'object' ? data : {};

                    var mediaUrl = data.url || link || '';

                    if (DDDTransport.canUse() && Utils.isRemoteMediaUrl(mediaUrl)) {
                        var session = SessionManager.getCurrent();

                        if (!session || !session.sid) {
                            session = SessionManager.buildFromPlayData(data, {
                                source: 'android_open_player'
                            });
                        }

                        if (session && session.sid) {
                            data.url = mediaUrl;
                            applyDddTransportToPlayData(data, session);

                            // Android receives the URL both as a standalone
                            // argument and inside JSON. Patch both at the final
                            // JS/native boundary so its playlist keeps DDD sync.
                            link = data.url;

                            Utils.log(
                                'DDD Android boundary patched',
                                session.sid,
                                'playlist=' + (Array.isArray(data.playlist) ? data.playlist.length : 0),
                                link
                            );
                        }
                    }

                    // Lampa Android collapses the JSON playlist to one item when
                    // its auto-next preference is off. Enable native conversion
                    // only for this launch, then restore the user's preference.
                    forceNativePlaylistForLaunch(data);
                } catch (e) {
                    Utils.error('DDD Android boundary patch failed', e);
                }

                return originalAndroidOpenPlayer.call(this, link, data);
            }

            patchedAndroidOpenPlayer.__continueWatchDddFinalPatched = true;
            patchedAndroidOpenPlayer.__continueWatchDddOriginal = originalAndroidOpenPlayer;
            Lampa.Android.openPlayer = patchedAndroidOpenPlayer;
            androidPatched = true;
        }

        function patchPlayer() {
            patchAndroidOpenPlayer();

            if (patched) return;
            if (!Lampa.Player || !Lampa.Player.play) return;

            if (Lampa.Player.__continueWatchUniversalPatched) {
                patched = true;
                return;
            }

            var originalPlay = Lampa.Player.play;

            Lampa.Player.play = function (data) {
                var self = this;
                var playArgs = arguments;

                try {
                    data = data || {};

                    var previousSession = SessionManager.getCurrent();
                    checkpointOutgoingSession(previousSession);
                    inheritPlaylistContext(data, previousSession);

                    var session = SessionManager.buildFromPlayData(data, { source: 'player_patch' });

                    if (session) {
                        syncPlaylistTimelinesFromLampa(data, session);

                        Core.consume({
                            source: 'lampa',
                            type: 'start',
                            session: session,
                            hash: session.hash,
                            url: session.url,
                            title: session.title,
                            force: true
                        });

                        if (DDDTransport.canUse() && Utils.isRemoteMediaUrl(data.url)) {
                            mergeRemoteLatestBeforePlayerPatch(session, data, function (mergedSession) {
                                var activeSession = mergedSession || session;

                                try {
                                    applyDddTransportToPlayData(data, activeSession);
                                } catch (e) {
                                    Utils.error('DDD player patch remote merge failed', e);
                                }

                                if (DDDTransport.shouldLaunchViaLocalBridge()) {
                                    DDDTransport.launchViaLocalBridge(data, activeSession, function (launchErr, launchJson) {
                                        if (!launchErr && launchJson && launchJson.ok !== false) {
                                            Utils.log('DDD local bridge handled playback', activeSession.sid);
                                            return;
                                        }

                                        Utils.warn('DDD local bridge launch failed, fallback to Lampa player', launchErr && launchErr.message ? launchErr.message : launchErr);
                                        DDDTransport.launchWhenReady(data, activeSession);
                                        stripBridgeFragmentsForFallback(data);
                                        return originalPlay.apply(self, playArgs);
                                    });

                                    return;
                                }

                                var nativeResult = originalPlay.apply(self, playArgs);

                                DDDTransport.launchWhenReady(data, activeSession);

                                return nativeResult;
                            });

                            return;
                        } else {
                            Utils.log('Lampa native transport selected', Utils.getPlatformKind(), Utils.getTorrentPlayerType());

                            // Lampa restarts the inner player with the selected
                            // playlist item. Re-read that item's own Timeline at
                            // this final boundary: otherwise the just-destroyed
                            // episode's currentTime can become the resume point
                            // (and then the saved position) of the next episode.
                            mergeRemoteLatestBeforePlayerPatch(session, data, function (mergedSession) {
                                var activeSession = mergedSession || session;

                                try {
                                    syncPlaylistTimelinesFromLampa(data, activeSession);
                                    applyNativeTimelineToLaunch(activeSession, data);
                                } catch (e) {
                                    Utils.error('Native player timeline bind failed', e);
                                }

                                return originalPlay.apply(self, playArgs);
                            });

                            return;
                        }
                    }
                } catch (e) {
                    Utils.error('Player patch failed', e);
                }

                return originalPlay.apply(this, arguments);
            };

            Lampa.Player.__continueWatchUniversalPatched = true;
            patched = true;
        }

        function makeLaunchLockKey(movie, params) {
            var movieKey = '';

            try {
                movieKey = StorageManager.getMovieKey(movie) || '';
            } catch (e) {}

            return [
                movieKey,
                params && params.torrent_link || '',
                params && params.url || '',
                params && params.file_index !== undefined ? params.file_index : '',
                params && params.playlist_index !== undefined ? params.playlist_index : '',
                params && params.season || 0,
                params && params.episode || 0
            ].join('|');
        }

        function acquireLaunchLock(movie, params) {
            var current = Utils.now();
            var key = makeLaunchLockKey(movie, params);
            var lock = window.__CONTINUE_WATCH_UNIVERSAL_LAUNCH_LOCK__;

            if (!lock || typeof lock !== 'object') {
                lock = { key: '', ts: 0 };
                window.__CONTINUE_WATCH_UNIVERSAL_LAUNCH_LOCK__ = lock;
            }

            if (lock.key === key && current - Number(lock.ts || 0) < CONFIG.launchLockMs) {
                Utils.log('Duplicate continue launch suppressed', key);
                return false;
            }

            lock.key = key;
            lock.ts = current;

            return true;
        }

        function rebuildPlaylistForLaunch(params) {
            if (!Array.isArray(params.playlist)) return null;

            return params.playlist.map(function (item, itemIndex) {
                var clone = Utils.shallowClone(item || {});
                var itemParams = Utils.shallowClone(clone);

                itemParams.playlist = params.playlist;
                itemParams.playlist_index = itemIndex;

                if (clone.url) {
                    if (Utils.isStreamUrl(clone.url)) {
                        clone.url = StorageManager.rebuildStreamUrl(clone.url);
                    } else if (Utils.isEphemeralProxyUrl(clone.url)) {
                        var recovered = StorageManager.recoverStreamParams(itemParams);
                        clone.url = recovered ? StorageManager.buildStreamUrl(recovered) : '';
                    } else {
                        clone.url = Utils.normalizePlaybackUrl(clone.url);
                    }
                }

                if (clone.uri && !clone.url) {
                    if (!Utils.isEphemeralProxyUrl(clone.uri)) {
                        clone.url = Utils.normalizePlaybackUrl(clone.uri);
                    }
                }

                if (clone.src && !clone.url) {
                    if (!Utils.isEphemeralProxyUrl(clone.src)) {
                        clone.url = Utils.normalizePlaybackUrl(clone.src);
                    }
                }

                if (!clone.url) {
                    var fallback = StorageManager.recoverStreamParams(itemParams);
                    if (fallback) clone.url = StorageManager.buildStreamUrl(fallback) || '';
                }

                if (clone.url) {
                    clone.uri = clone.url;
                    clone.src = clone.url;
                }

                var image = Utils.extractImage(item) || Utils.extractImage(clone);

                if (image) {
                    Utils.copyImageFields(clone, image);
                }

                return clone;
            });
        }

        function parseRemoteContentKey(value) {
            var result = { movieId: '', season: 0, episode: 0 };
            var match = String(value || '').match(/^tmdb:([^:]+)(?::s(\d+):e(\d+))?$/i);

            if (!match) return result;

            result.movieId = match[1] || '';
            result.season = Number(match[2] || 0);
            result.episode = Number(match[3] || 0);

            return result;
        }

        function buildMovieTimelineMap(movie) {
            var map = {};
            var seasons = movie && Array.isArray(movie.seasons) ? movie.seasons : [];
            var maxSeason = Number(movie && (movie.number_of_seasons || movie.season_count) || 0);
            var defaultEpisodeCount = Number(movie && (movie.episode_count || movie.number_of_episodes) || 0);

            if (!maxSeason && seasons.length) {
                seasons.forEach(function (season) {
                    maxSeason = Math.max(maxSeason, Number(season && (season.season_number || season.number) || 0));
                });
            }

            if (!maxSeason) maxSeason = Utils.getMediaKind(movie) === 'tv' ? 20 : 0;
            maxSeason = Math.min(Math.max(maxSeason, 0), 50);
            defaultEpisodeCount = Math.min(Math.max(defaultEpisodeCount, 0), 200);

            if (!maxSeason) {
                var movieHash = StorageManager.generateTimelineHash(movie, 0, 0);
                if (movieHash) map[String(movieHash)] = { season: 0, episode: 0, hash: String(movieHash) };
                return map;
            }

            for (var seasonNumber = 1; seasonNumber <= maxSeason; seasonNumber++) {
                var seasonInfo = null;

                for (var i = 0; i < seasons.length; i++) {
                    if (Number(seasons[i] && (seasons[i].season_number || seasons[i].number) || 0) === seasonNumber) {
                        seasonInfo = seasons[i];
                        break;
                    }
                }

                var episodeCount = Number(seasonInfo && (seasonInfo.episode_count || seasonInfo.number_of_episodes) || 0);
                if (!episodeCount) episodeCount = defaultEpisodeCount;
                if (!episodeCount) episodeCount = 120;
                episodeCount = Math.min(Math.max(episodeCount, 1), 200);

                for (var episodeNumber = 1; episodeNumber <= episodeCount; episodeNumber++) {
                    var hash = StorageManager.generateTimelineHash(movie, seasonNumber, episodeNumber);
                    if (hash) {
                        map[String(hash)] = {
                            season: seasonNumber,
                            episode: episodeNumber,
                            hash: String(hash)
                        };
                    }
                }
            }

            return map;
        }

        function findRemoteRecordForMovie(movie, params) {
            return function (items) {
                if (!movie || !Array.isArray(items) || !items.length) return null;

                var movieId = String(movie.id || movie.movie_id || movie.tmdb_id || movie.tmdbId || '');
                var timelineMap = buildMovieTimelineMap(movie);
                var matches = [];
                var directMatcher = params ? findRemoteRecordForLaunch(movie, params) : null;
                var directRecord = directMatcher ? directMatcher(items) : null;

                items.forEach(function (item) {
                    if (!item || typeof item !== 'object') return;

                    var parsedKey = parseRemoteContentKey(item.contentKey);
                    var timelineKey = String(item.timelineHash || item.contentKey || '');
                    var mapped = timelineMap[timelineKey] || null;
                    var sameMovieId = !!(movieId && parsedKey.movieId && movieId === String(parsedKey.movieId));

                    if (!sameMovieId && !mapped && item !== directRecord) return;

                    var season = Number(parsedKey.season || mapped && mapped.season || 0);
                    var episode = Number(parsedKey.episode || mapped && mapped.episode || 0);
                    var hash = String(item.timelineHash || mapped && mapped.hash || '');
                    var position = Number(item.position || 0);
                    var duration = Number(item.duration || 0);
                    var reason = String(item.reason || '').toLowerCase();
                    var launchOnly = position <= 0 && duration <= 0 && /session_started|lampa_launch|state_ready/.test(reason);

                    matches.push({
                        record: item,
                        season: season,
                        episode: episode,
                        hash: hash,
                        updatedAt: Number(item.updatedAt || 0),
                        meaningful: !launchOnly
                    });
                });

                if (!matches.length) return null;

                var meaningful = matches.filter(function (item) { return item.meaningful; });
                var pool = meaningful.length ? meaningful : matches;

                pool.sort(function (a, b) { return b.updatedAt - a.updatedAt; });

                var selected = pool[0] || null;

                if (selected) {
                    for (var playlistRecordIndex = 0; playlistRecordIndex < matches.length; playlistRecordIndex++) {
                        var playlistRecord = matches[playlistRecordIndex];

                        if (
                            playlistRecord &&
                            playlistRecord.record &&
                            Array.isArray(playlistRecord.record.playlist) &&
                            playlistRecord.record.playlist.length > 1 &&
                            (
                                !selected.playlistRecord ||
                                Number(playlistRecord.updatedAt || 0) > Number(selected.playlistRecord.updatedAt || 0)
                            )
                        ) {
                            selected.playlistRecord = playlistRecord.record;
                        }
                    }
                }

                return selected;
            };
        }

        function rebuildRemotePlaylist(record) {
            var source = record && Array.isArray(record.playlist) ? record.playlist : [];
            var playlist = [];

            source.forEach(function (item, fallbackIndex) {
                item = item || {};

                var uri = Utils.normalizePlaybackUrl(item.uri || item.url || item.src || '');
                if (!uri) return;

                var parsed = Utils.parseStreamUrl(uri);
                var parsedKey = parseRemoteContentKey(item.contentKey || '');
                var hash = String(item.timelineHash || '');
                var timeline = null;

                try {
                    if (hash && Lampa.Timeline && Lampa.Timeline.view) timeline = Lampa.Timeline.view(hash);
                } catch (e) {}

                if (!timeline || !Number(timeline.time || 0)) {
                    timeline = {
                        hash: hash,
                        time: Math.max(0, Number(item.position || 0) / 1000),
                        duration: Math.max(0, Number(item.duration || 0) / 1000),
                        percent: Utils.clamp(Number(item.percent || 0), 0, 100)
                    };
                }

                playlist.push({
                    url: uri,
                    uri: uri,
                    src: uri,
                    title: item.title || item.filename || '',
                    name: item.title || item.filename || '',
                    filename: item.filename || parsed && parsed.file_name || '',
                    file_name: item.filename || parsed && parsed.file_name || '',
                    index: Number(item.index !== undefined ? item.index : fallbackIndex),
                    season: Number(item.season || parsedKey.season || 0),
                    episode: Number(item.episode || parsedKey.episode || 0),
                    timeline: timeline
                });
            });

            playlist.sort(function (a, b) {
                return Number(a.index || 0) - Number(b.index || 0);
            });

            return playlist;
        }

        function remoteRecordToParams(movie, currentParams, match) {
            if (!match || !match.record) return currentParams;

            var record = match.record;
            var hash = match.hash || String(record.timelineHash || '');
            var stored = hash ? StorageManager.getParams()[hash] : null;
            var base = Utils.shallowClone(stored && StorageManager.recordHasLaunchableUrl(stored) ? stored : (currentParams || {}));
            var remotePlaylist = rebuildRemotePlaylist(record);

            // A native Android player can report only its active item. Keep the
            // newest complete playlist from another client and merge the active
            // episode into it instead of collapsing the series to one file.
            if (!remotePlaylist.length && match.playlistRecord) {
                remotePlaylist = rebuildRemotePlaylist(match.playlistRecord);
            }
            var uri = Utils.normalizePlaybackUrl(record.uri || record.url || record.src || '');
            var parsed = Utils.parseStreamUrl(uri);

            if (remotePlaylist.length) base.playlist = remotePlaylist;

            if (uri) {
                base.url = uri;
                base.uri = uri;
                base.src = uri;
            }

            if (parsed) {
                base.file_name = parsed.file_name;
                base.torrent_link = parsed.torrent_link;
                base.file_index = parsed.file_index;
            }

            base.movie_id = movie.id || movie.movie_id || movie.tmdb_id || movie.tmdbId || base.movie_id || '';
            base.tmdb_id = movie.id || movie.tmdb_id || movie.tmdbId || base.tmdb_id || base.movie_id || '';
            base.original_title = movie.original_title || base.original_title || '';
            base.original_name = movie.original_name || movie.name || base.original_name || '';
            base.media_type = Utils.getMediaKind(movie);
            base.season = Number(match.season || base.season || 0);
            base.episode = Number(match.episode || base.episode || 0);
            base.playlist_index = Number(record.windowIndex !== undefined ? record.windowIndex : (base.playlist_index || base.file_index || 0));
            base.episode_title = record.title || base.episode_title || '';
            base.title = record.title || base.title || Utils.getMovieTitle(movie);

            base = applyRemoteRecordToParams(base, record);

            if (uri && base.season > 0 && base.episode > 0) {
                var playlist = Array.isArray(base.playlist) ? base.playlist.slice(0) : [];
                var matchingIndex = -1;

                for (var playlistIndex = 0; playlistIndex < playlist.length; playlistIndex++) {
                    var candidate = playlist[playlistIndex] || {};
                    var candidateSeason = Number(candidate.season || candidate.season_number || candidate.s || 0);
                    var candidateEpisode = Number(candidate.episode || candidate.episode_number || candidate.e || 0);

                    if (candidateSeason === base.season && candidateEpisode === base.episode) {
                        matchingIndex = playlistIndex;
                        break;
                    }
                }

                var activeRemoteItem = matchingIndex >= 0
                    ? Utils.shallowClone(playlist[matchingIndex] || {})
                    : {};

                activeRemoteItem.url = uri;
                activeRemoteItem.uri = uri;
                activeRemoteItem.src = uri;
                activeRemoteItem.title = record.title || base.episode_title || base.title || '';
                activeRemoteItem.name = activeRemoteItem.name || activeRemoteItem.title;
                activeRemoteItem.season = base.season;
                activeRemoteItem.episode = base.episode;
                activeRemoteItem.timeline = Lampa.Timeline && Lampa.Timeline.view
                    ? Lampa.Timeline.view(hash)
                    : { hash: hash, time: 0, duration: 0, percent: 0 };

                if (matchingIndex >= 0) {
                    playlist[matchingIndex] = activeRemoteItem;
                    base.playlist = playlist;
                    base.playlist_index = matchingIndex;
                } else {
                    // A playlist cached on another device can point at another
                    // season. Prefer one exact, playable episode over attaching
                    // the remote URL to an unrelated local playlist item.
                    base.playlist = [activeRemoteItem];
                    base.playlist_index = 0;
                }
            }

            // Lampac /proxy/*.m3u8 links are signed, short-lived manifests.
            // Recover the original TorrServer stream from neighbouring playlist
            // entries instead of persisting and replaying an expired proxy URL.
            if (Utils.isEphemeralProxyUrl(base.url || base.uri || base.src || '')) {
                var recoveredStream = StorageManager.recoverStreamParams(base);
                var recoveredUrl = recoveredStream ? StorageManager.buildStreamUrl(recoveredStream) : '';

                if (recoveredUrl) {
                    base.url = recoveredUrl;
                    base.uri = recoveredUrl;
                    base.src = recoveredUrl;
                    base.file_name = recoveredStream.file_name;
                    base.torrent_link = recoveredStream.torrent_link;
                    base.file_index = recoveredStream.file_index;

                    if (Array.isArray(base.playlist) && base.playlist.length) {
                        var recoveredIndex = Number(base.playlist_index || 0);
                        if (recoveredIndex >= 0 && recoveredIndex < base.playlist.length) {
                            var recoveredItem = Utils.shallowClone(base.playlist[recoveredIndex] || {});
                            recoveredItem.url = recoveredUrl;
                            recoveredItem.uri = recoveredUrl;
                            recoveredItem.src = recoveredUrl;
                            recoveredItem.file_name = recoveredStream.file_name;
                            recoveredItem.filename = recoveredStream.file_name;
                            base.playlist[recoveredIndex] = recoveredItem;
                        }
                    }
                }
            }

            base.timestamp = Number(record.updatedAt || base.timestamp || Utils.now());

            return base;
        }

        function findRemoteRecordForLaunch(movie, params) {
            return function (items) {
                if (!Array.isArray(items) || !items.length) return null;

                params = params || {};
                var season = Number(params.season || 0);
                var episode = Number(params.episode || 0);
                var timelineHash = StorageManager.generateTimelineHash(movie, season, episode);
                var launchUrl = StorageManager.buildLaunchUrl(params) || params.url || params.uri || params.src || '';
                var sourceKey = Utils.streamIdentity(launchUrl || '');

                var best = null;
                var bestTs = 0;

                items.forEach(function (item) {
                    if (!item || typeof item !== 'object') return;

                    var sameTimeline = timelineHash && (
                        String(item.timelineHash || '') === String(timelineHash) ||
                        String(item.contentKey || '') === String(timelineHash)
                    );
                    var sameSource = sourceKey && (
                        String(item.sourceKey || '') === String(sourceKey) ||
                        Utils.streamIdentity(item.uri || item.url || item.src || '') === sourceKey
                    );

                    if (!sameTimeline && !sameSource) return;

                    var ts = Number(item.updatedAt || 0);
                    if (!best || ts >= bestTs) {
                        best = item;
                        bestTs = ts;
                    }
                });

                return best;
            };
        }

        function applyRemoteRecordToParams(params, record) {
            var merged = Utils.shallowClone(params || {});
            if (!record || typeof record !== 'object') return merged;

            // Remote progress is imported into Lampa.Timeline by
            // NativeTimelineSync. This object is launch metadata only.
            delete merged.time;
            delete merged.duration;
            delete merged.percent;
            delete merged.position;
            delete merged.last_source;
            delete merged.last_reason;
            delete merged.last_event_type;

            function copy(toKey, value) {
                if (value === undefined || value === null || value === '') return;
                merged[toKey] = value;
            }

            copy('selected_audio_track', record.selectedAudioTrack);
            copy('selected_audio_track_id', record.selectedAudioTrackId);
            copy('selected_audio_track_index', record.selectedAudioTrackIndex);
            copy('selected_audio_track_language', record.selectedAudioTrackLanguage);
            copy('selected_audio_track_mime', record.selectedAudioTrackMimeType);
            copy('selected_audio_track_channels', record.selectedAudioTrackChannels);

            if (record.updatedAt) merged.timestamp = Number(record.updatedAt);

            return merged;
        }

        function hasAudioParams(params) {
            return !!(
                params &&
                (
                    params.selected_audio_track ||
                    params.selected_audio_track_id ||
                    params.selected_audio_track_index !== undefined && params.selected_audio_track_index !== null && params.selected_audio_track_index !== ''
                )
            );
        }

        function hasRemoteAudio(record) {
            return !!(
                record &&
                (
                    record.selectedAudioTrack ||
                    record.selectedAudioTrackId ||
                    record.selectedAudioTrackIndex !== undefined && record.selectedAudioTrackIndex !== null && record.selectedAudioTrackIndex !== ''
                )
            );
        }

        function copyRemoteAudioToParams(params, record) {
            var merged = Utils.shallowClone(params || {});
            if (!hasRemoteAudio(record)) return merged;

            function copy(toKey, value) {
                if (value === undefined || value === null || value === '') return;
                merged[toKey] = value;
            }

            copy('selected_audio_track', record.selectedAudioTrack);
            copy('selected_audio_track_id', record.selectedAudioTrackId);
            copy('selected_audio_track_index', record.selectedAudioTrackIndex);
            copy('selected_audio_track_language', record.selectedAudioTrackLanguage);
            copy('selected_audio_track_mime', record.selectedAudioTrackMimeType);
            copy('selected_audio_track_channels', record.selectedAudioTrackChannels);

            return merged;
        }

        function findRemoteAudioRecordForLaunch(params) {
            return function (items) {
                if (!Array.isArray(items) || !items.length) return null;

                params = params || {};
                var launchUrl = StorageManager.buildLaunchUrl(params) || params.url || params.uri || params.src || '';
                var parsed = Utils.parseStreamUrl(launchUrl);
                var torrentLink = params.torrent_link || (parsed && parsed.torrent_link) || '';
                var best = null;
                var bestTs = 0;

                if (!torrentLink) return null;

                items.forEach(function (item) {
                    if (!hasRemoteAudio(item)) return;

                    var sourceKey = String(item.sourceKey || '');
                    var uri = String(item.uri || item.url || item.src || '');
                    var sameTorrent =
                        sourceKey.indexOf(torrentLink + '|') === 0 ||
                        uri.indexOf('link=' + torrentLink) !== -1 ||
                        uri.indexOf('hash=' + torrentLink) !== -1;

                    if (!sameTorrent) return;

                    var ts = Number(item.updatedAt || 0);
                    if (!best || ts >= bestTs) {
                        best = item;
                        bestTs = ts;
                    }
                });

                return best;
            };
        }

        function mergeRemoteLatestBeforeLaunch(movie, params, call) {
            NativeTimelineSync.refresh(movie, function (err, items) {
                try {
                    if (err || !Array.isArray(items)) {
                        if (err) Utils.warn('DDD remote latest skipped', err.message || err);
                        return call(params);
                    }

                    var localTimestamp = Number(params && params.timestamp || 0);
                    var movieMatch = findRemoteRecordForMovie(movie, params)(items);
                    if (
                        movieMatch &&
                        localTimestamp &&
                        Number(movieMatch.record && movieMatch.record.updatedAt || 0) <= localTimestamp
                    ) {
                        movieMatch = null;
                    }

                    var matcher = findRemoteRecordForLaunch(movie, params);
                    var record = movieMatch && movieMatch.record ? movieMatch.record : matcher(items);
                    if (
                        record &&
                        localTimestamp &&
                        Number(record.updatedAt || 0) <= localTimestamp
                    ) {
                        record = null;
                    }

                    var merged = movieMatch
                        ? remoteRecordToParams(movie, params, movieMatch)
                        : (record ? applyRemoteRecordToParams(params, record) : Utils.shallowClone(params || {}));
                    var audioRecord = null;

                    if (!hasAudioParams(merged)) {
                        audioRecord = findRemoteAudioRecordForLaunch(merged)(items);

                        if (audioRecord) {
                            merged = copyRemoteAudioToParams(merged, audioRecord);
                        }
                    }

                    if (!record && !audioRecord) return call(params);

                    if (record) {
                        NativeTimelineSync.applyRecord(record, true);
                    }

                    var hash = movieMatch && movieMatch.hash
                        ? movieMatch.hash
                        : StorageManager.generateTimelineHash(movie, Number(merged.season || 0), Number(merged.episode || 0));

                    if (hash) {
                        var saveMerged = Utils.shallowClone(merged || {});
                        delete saveMerged.timestamp;
                        StorageManager.saveStreamParams(hash, saveMerged, false);
                    }

                    Utils.log(
                        'DDD remote latest merged before launch',
                        hash,
                        record ? record.updatedAt : '',
                        'S' + Number(merged.season || 0) + 'E' + Number(merged.episode || 0),
                        merged.selected_audio_track || '',
                        audioRecord ? 'audioFallback=' + (audioRecord.contentKey || audioRecord.sourceKey || '') : ''
                    );
                    call(merged);
                } catch (mergeError) {
                    Utils.error('DDD remote latest merge failed', mergeError);
                    call(params);
                }
            }, false);
        }

        function launchFromContinue(movie, params) {
            if (!movie || !params) return;
            if (!acquireLaunchLock(movie, params)) return;

            mergeRemoteLatestBeforeLaunch(movie, params, function (mergedParams) {
                doLaunchFromContinue(movie, mergedParams || params);
            });
        }

        function doLaunchFromContinue(movie, params) {
            var url = StorageManager.buildLaunchUrl(params);

            if (!url) {
                Utils.error('Missing launch url', params);

                try {
                    Lampa.Noty.show('Не удалось восстановить ссылку просмотра');
                } catch (e) {}

                return;
            }

            var season = Number(params.season || 0);
            var episode = Number(params.episode || 0);
            var hash = StorageManager.generateTimelineHash(movie, season, episode);
            var timeline = hash && Lampa.Timeline && Lampa.Timeline.view ? Lampa.Timeline.view(hash) : null;
            var resumeTime = Number(timeline && timeline.time || 0);
            var resumeDuration = Number(timeline && timeline.duration || 0);
            var resumePercent = Number(timeline && timeline.percent || 0);

            if (!resumePercent && resumeTime > 0 && resumeDuration > 0) {
                resumePercent = Math.round(resumeTime / resumeDuration * 100);
            }

            resumePercent = Utils.clamp(resumePercent, 0, 100);

            if (!timeline) timeline = {};

            timeline.hash = hash;
            timeline.time = resumeTime;
            timeline.duration = resumeDuration;
            timeline.percent = resumePercent;

            var playlist = rebuildPlaylistForLaunch(params);

            var playlistIndex = Number(
                params.playlist_index !== undefined && params.playlist_index !== null
                    ? params.playlist_index
                    : params.start_index !== undefined && params.start_index !== null
                        ? params.start_index
                        : 0
            );

            if (playlist && playlist.length) {
                if (isNaN(playlistIndex) || playlistIndex < 0) playlistIndex = 0;
                if (playlistIndex >= playlist.length) playlistIndex = playlist.length - 1;
            }

            var activeItem = playlist && playlist.length ? playlist[playlistIndex] : null;
            var activeImage =
                Utils.extractImage(activeItem) ||
                Utils.extractImage(params) ||
                Utils.extractImage(movie);

            var data = {
                url: url,
                uri: url,
                src: url,
                title: params.episode_title || params.title || Utils.getMovieTitle(movie),
                card: movie,
                movie: movie,
                timeline: timeline,
                time: resumeTime,
                position: resumeTime > 0 ? resumeTime : -1,
                duration: resumeDuration,
                percent: resumePercent,
                playlist: playlist,
                playlist_index: playlistIndex,
                start_index: playlistIndex,
                season: season,
                episode: episode,
                torrent_hash: params.torrent_link || '',
                selected_audio_track: params.selected_audio_track || '',
                selected_audio_track_id: params.selected_audio_track_id || '',
                selected_audio_track_index: params.selected_audio_track_index,
                selected_audio_track_language: params.selected_audio_track_language || '',
                selected_audio_track_mime: params.selected_audio_track_mime || '',
                selected_audio_track_channels: params.selected_audio_track_channels,
                continue_watch_universal: true
            };

            if (activeItem) {
                data.currentItem = activeItem;
            }

            if (activeImage) {
                Utils.copyImageFields(data, activeImage);
            }

            // The remote refresh above updates every native Lampa timeline.
            // Rebind the rebuilt playlist to those canonical entries as well;
            // otherwise only the initially opened episode gets the remote
            // position and in-player episode switches reuse stale snapshots.
            syncPlaylistTimelinesFromLampa(data, {
                movie: movie,
                season: season,
                playlist: playlist
            });

            try {
                Lampa.Player.play(data);
            } catch (e) {
                Utils.error('Launch from continue failed', e);
            }
        }

        return {
            patchPlayer: patchPlayer,
            patchAndroidOpenPlayer: patchAndroidOpenPlayer,
            launchFromContinue: launchFromContinue,
            refreshRemote: mergeRemoteLatestBeforeLaunch
        };
    })();

    // ============================================================
    // UIManager
    // ============================================================

    var UIManager = (function () {
        var installed = false;
        var cardObserver = null;
        var cardScanTimer = null;
        var cardScanQueued = false;
        var lastRemoteRefreshToken = '';
        var controllerRefreshTimer = null;

        function rememberUiStatus(phase, movie, params, details) {
            try {
                localStorage.setItem('continue_watch_ui_status', JSON.stringify({
                    version: PLUGIN_VERSION,
                    phase: phase,
                    profileId: StorageManager.getProfileId(),
                    storageKey: StorageManager.getStorageKey(),
                    movieId: movie && (movie.id || movie.movie_id || movie.tmdb_id || movie.tmdbId || ''),
                    title: movie ? Utils.getMovieTitle(movie) : '',
                    originalTitle: movie && (movie.original_title || movie.original_name || ''),
                    paramsFound: !!params,
                    paramsTitle: params && params.title || '',
                    paramsSeason: Number(params && params.season || 0),
                    paramsEpisode: Number(params && params.episode || 0),
                    paramsPlaylistSize: params && Array.isArray(params.playlist) ? params.playlist.length : 0,
                    storedItems: Object.keys(StorageManager.getParams() || {}).length,
                    details: details || '',
                    timestamp: Date.now()
                }));
            } catch (e) {}
        }

        function removeContinueButtons(render) {
            try {
                render.find('.button--continue-watch-ddd').remove();
                render.find('.button--continue-watch-ddd-debug').remove();
            } catch (e) {}
        }

        function escapeHtml(value) {
            return String(value || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function getTimelineView(hash) {
            try {
                if (hash && Lampa.Timeline && Lampa.Timeline.view) {
                    return Lampa.Timeline.view(hash);
                }
            } catch (e) {}

            return null;
        }

        function getContinueRoad(movie, params) {
            params = params || {};

            var road = {
                time: 0,
                duration: 0,
                percent: 0
            };

            try {
                var hash = StorageManager.generateTimelineHash(
                    movie,
                    Number(params.season || 0),
                    Number(params.episode || 0)
                );

                var timeline = getTimelineView(hash);

                if (timeline) {
                    road.time = Number(timeline.time || 0);
                    road.duration = Number(timeline.duration || 0);
                    road.percent = Number(timeline.percent || 0);
                }
            } catch (e) {}

            if (!road.percent && road.time && road.duration) {
                road.percent = Math.round((road.time / road.duration) * 100);
            }

            road.percent = Utils.clamp(road.percent, 0, 100);

            return road;
        }

        function hasContinueHistory(movie, params) {
            if (!movie || !params || !StorageManager.recordHasLaunchableUrl(params)) return false;

            var road = getContinueRoad(movie, params);

            return Number(road.time || 0) > 0 || Number(road.percent || 0) > 0;
        }

        function formatContinueSubtitle(params, road) {
            if (!params) return '';

            var parts = [];
            var season = Number(params.season || 0);
            var episode = Number(params.episode || 0);
            var isTv = params.media_type === 'tv' || season || episode;

            if (isTv && season && episode) {
                parts.push('S' + season + 'E' + episode);
            } else if (isTv && episode) {
                parts.push('E' + episode);
            }

            road = road || {};

            if (road.time) {
                parts.push(Utils.formatSeconds(road.time));
            }

            return parts.join(' / ');
        }

        function getActiveMovieFromCard() {
            try {
                var activity = Lampa.Activity && Lampa.Activity.active ? Lampa.Activity.active() : null;

                if (activity && activity.movie) return activity.movie;
                if (activity && activity.card) return activity.card;
                if (activity && activity.params && activity.params.movie) return activity.params.movie;
            } catch (e) {}

            return null;
        }

        function launchFromButton(button, movie) {
            var now = Date.now();
            var lastLaunchAt = Number(button.data('continueWatchUniversalLaunchAt') || 0);

            if (now - lastLaunchAt < 900) return false;

            button.data('continueWatchUniversalLaunchAt', now);

            var activeMovie = movie || getActiveMovieFromCard();
            var params = activeMovie ? StorageManager.getLastStreamParams(activeMovie) : null;

            if (!activeMovie || !params) {
                try {
                    Lampa.Noty.show('Нет истории просмотров');
                } catch (e) {}

                return false;
            }

            PlayerManager.launchFromContinue(activeMovie, params);

            return false;
        }

        function bindLaunch(button, movie) {
            function launch() {
                return launchFromButton(button, movie);
            }

            button
                .off('click.continueWatchUniversalLaunch')
                .off('hover:enter.continueWatchUniversalLaunch')
                .on('click.continueWatchUniversalLaunch', launch)
                .on('hover:enter.continueWatchUniversalLaunch', launch);
        }

        function createButton(movie, params) {
            var road = getContinueRoad(movie, params);
            var subtitle = formatContinueSubtitle(params, road);
            var dash = (road.percent * 65.97 / 100).toFixed(2);
            var movieKey = '';
            var mobileClass = Utils.isAndroidPlatform() ? ' continue-watch-ddd-mobile' : '';
            var stateKey = [
                Number(params && params.timestamp || 0),
                Number(road.time || 0),
                Number(road.duration || 0),
                Number(road.percent || 0),
                Number(params && params.season || 0),
                Number(params && params.episode || 0)
            ].join(':');

            try {
                movieKey = StorageManager.getMovieKey(movie) || '';
            } catch (e) {}

            var html =
                '<div class="full-start__button selector view--continue-watch button--continue-watch button--continue-watch-ddd continue-watch-ddd-source' + mobileClass + '" ' +
                    'data-cwu-movie-key="' + escapeHtml(movieKey) + '" ' +
                    'data-cwu-state="' + escapeHtml(stateKey) + '" ' +
                    'data-cwu-subtitle="' + escapeHtml(subtitle) + '">' +
                    '<svg class="continue-watch-ddd-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">' +
                        '<circle cx="12" cy="12" r="10.5" stroke="currentColor" stroke-width="1.7" fill="none" opacity="0.22"></circle>' +
                        '<circle class="continue-watch-ddd-progress" cx="12" cy="12" r="10.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-dasharray="' + dash + ' 65.97" transform="rotate(-90 12 12)"></circle>' +
                        '<path d="M9 7.7v8.6c0 .55.6.89 1.08.6l6.62-4.3a.72.72 0 0 0 0-1.2l-6.62-4.3A.7.7 0 0 0 9 7.7z" fill="currentColor"></path>' +
                    '</svg>' +
                    '<span>\u041f\u0440\u043e\u0434\u043e\u043b\u0436\u0438\u0442\u044c</span>' +
                '</div>';

            var button = $(html);

            try {
                button.data('continueWatchUniversalMovie', movie);
            } catch (e) {}

            bindLaunch(button, movie);

            return button;
        }

        function updateButton(button, movie, params) {
            if (!button || !button.length) return;

            var road = getContinueRoad(movie, params);
            var subtitle = formatContinueSubtitle(params, road);
            var dash = (road.percent * 65.97 / 100).toFixed(2);
            var movieKey = '';
            var stateKey = [
                Number(params && params.timestamp || 0),
                Number(road.time || 0),
                Number(road.duration || 0),
                Number(road.percent || 0),
                Number(params && params.season || 0),
                Number(params && params.episode || 0)
            ].join(':');

            try {
                movieKey = StorageManager.getMovieKey(movie) || '';
            } catch (e) {}

            button
                .removeAttr('data-buttons-plugin-id')
                .removeClass('button-mode-1 button-mode-2 button-mode-3 animate-trigger-enter')
                .toggleClass('continue-watch-ddd-mobile', Utils.isAndroidPlatform())
                .attr('data-cwu-movie-key', movieKey)
                .attr('data-cwu-state', stateKey)
                .attr('data-cwu-subtitle', subtitle)
                .data('continueWatchUniversalMovie', movie);

            button.find('.continue-watch-ddd-progress')
                .attr('stroke-dasharray', dash + ' 65.97');

            bindLaunch(button, movie);
        }

        function getWatchContainer(render) {
            var container = render.find('.full-start-new__buttons').first();

            if (container.length) return container;

            container = render.find('.buttons--container').first();

            if (container.length) return container;

            container = $('<div class="full-start-new__buttons"></div>');
            render.append(container);

            return container;
        }

        function insertIntoWatchContainer(render, button) {
            var container = getWatchContainer(render);

            container.find('> .button--continue-watch-ddd').remove();

            var torrentButton = container.find('> .view--torrent').first();
            var trailerButton = container.find('> .view--trailer').first();

            if (torrentButton.length) {
                torrentButton.before(button);
            } else if (trailerButton.length) {
                trailerButton.before(button);
            } else {
                container.prepend(button);
            }

            try {
                render.find('.button--play').removeClass('hide');
            } catch (e) {}
        }

        function pinVisibleContinueButtons(render) {
            var scope = render && render.find ? render : $(document);

            scope.find('.button--continue-watch-ddd, .continue-watch-ddd-source, [data-buttons-plugin-id="continue_watch_universal"]')
                .each(function () {
                    var button = $(this);

                    if (this.offsetParent === null) return;

                    var container = button.closest('.full-start-new__buttons, .buttons--container');
                    if (!container.length) return;

                    var torrentButton = container.children('.view--torrent').first();

                    if (torrentButton.length) {
                        if (button.next()[0] !== torrentButton[0]) button.insertBefore(torrentButton);
                    } else if (container.children().first()[0] !== button[0]) {
                        container.prepend(button);
                    }
                });
        }

        function ensureStandaloneContinueButton(render, movie, params) {
            // Older builds created a second button when the card row was briefly hidden
            // during controller changes. Keep only the native card-row button.
            render.find('.continue-watch-ddd-standalone').remove();
        }

        function injectButtonCompatStyles() {
            try {
                var css =
                    '.button--continue-watch-ddd .continue-watch-ddd-icon{' +
                        'display:block!important;' +
                        'width:1.5em!important;' +
                        'height:1.5em!important;' +
                        'min-width:1.5em!important;' +
                        'min-height:1.5em!important;' +
                        'flex:0 0 1.5em!important;' +
                    '}' +

                    '.button--continue-watch-ddd{' +
                        'opacity:1!important;' +
                        'order:-300;' +
                        'box-sizing:border-box!important;' +
                        'display:flex!important;' +
                        'align-items:center!important;' +
                        'justify-content:flex-start!important;' +
                        'width:9.5em!important;' +
                        'min-width:9.5em!important;' +
                        'max-width:9.5em!important;' +
                        'overflow:hidden!important;' +
                        'transform:none!important;' +
                        'animation:none!important;' +
                        'transition:background-color .12s ease,color .12s ease!important;' +
                    '}' +

                    '.full-start-new__buttons > .view--online{' +
                        'order:-200;' +
                    '}' +

                    '.full-start-new__buttons > .button--play{' +
                        'order:-100;' +
                    '}' +

                    '.button--continue-watch-ddd.focus,' +
                    '.button--continue-watch-ddd.hover,' +
                    '.button--continue-watch-ddd:hover{' +
                        'background-color:#fff;' +
                        'color:#000;' +
                        'transform:none!important;' +
                        'animation:none!important;' +
                    '}' +

                    '.continue-watch-ddd-standalone{' +
                        'display:inline-flex!important;' +
                        'align-items:center;' +
                        'gap:.55em;' +
                        'padding:.58em 1em;' +
                        'margin:0 0 .75em 0;' +
                        'border-radius:.3em;' +
                        'background:rgba(0,0,0,.42);' +
                        'cursor:pointer;' +
                    '}' +

                    '.continue-watch-ddd-standalone.focus,' +
                    '.continue-watch-ddd-standalone:hover{' +
                        'background:#fff;' +
                        'color:#000;' +
                    '}' +

                    '.button--continue-watch-ddd span{' +
                        'display:inline-block!important;' +
                        'margin-left:.75em!important;' +
                        'margin-top:-.2em!important;' +
                        'white-space:nowrap;' +
                    '}' +
                    '.button--continue-watch-ddd:after{' +
                        'content:none!important;' +
                        'display:none!important;' +
                    '}' +

                    '.button--continue-watch-ddd.animate-trigger-enter{' +
                        'transform:none!important;' +
                        'animation:none!important;' +
                    '}' +

                    'body.touch-device .button--continue-watch-ddd{' +
                        'width:3.5em!important;' +
                        'min-width:3.5em!important;' +
                        'max-width:3.5em!important;' +
                        'height:3.5em!important;' +
                        'min-height:3.5em!important;' +
                        'padding:0!important;' +
                        'margin-left:0!important;' +
                        'margin-right:.45em!important;' +
                        'gap:0!important;' +
                        'justify-content:center!important;' +
                        'overflow:visible!important;' +
                        'background-color:rgba(0,0,0,.3)!important;' +
                        'color:#fff!important;' +
                        'transform:none!important;' +
                        'animation:none!important;' +
                        'transition:none!important;' +
                    '}' +

                    '.button--continue-watch-ddd.continue-watch-ddd-mobile,' +
                    '.button--continue-watch-ddd.continue-watch-ddd-mobile.focus,' +
                    '.button--continue-watch-ddd.continue-watch-ddd-mobile.hover,' +
                    '.button--continue-watch-ddd.continue-watch-ddd-mobile:hover,' +
                    '.button--continue-watch-ddd.continue-watch-ddd-mobile:active{' +
                        'width:3.5em!important;' +
                        'min-width:3.5em!important;' +
                        'max-width:3.5em!important;' +
                        'height:3.5em!important;' +
                        'min-height:3.5em!important;' +
                        'padding:0!important;' +
                        'margin-left:0!important;' +
                        'margin-right:.45em!important;' +
                        'gap:0!important;' +
                        'justify-content:center!important;' +
                        'overflow:visible!important;' +
                        'background-color:rgba(0,0,0,.3)!important;' +
                        'color:#fff!important;' +
                        'transform:none!important;' +
                        'animation:none!important;' +
                        'transition:none!important;' +
                    '}' +

                    '.button--continue-watch-ddd.continue-watch-ddd-mobile span,' +
                    '.button--continue-watch-ddd.continue-watch-ddd-mobile.focus span,' +
                    '.button--continue-watch-ddd.continue-watch-ddd-mobile.hover span,' +
                    '.button--continue-watch-ddd.continue-watch-ddd-mobile:hover span,' +
                    '.button--continue-watch-ddd.continue-watch-ddd-mobile:active span{' +
                        'display:none!important;' +
                    '}' +

                    'body.touch-device .button--continue-watch-ddd span,' +
                    'body.touch-device .button--continue-watch-ddd.focus span,' +
                    'body.touch-device .button--continue-watch-ddd.hover span,' +
                    'body.touch-device .button--continue-watch-ddd:hover span{' +
                        'display:none!important;' +
                    '}' +

                    'body.touch-device .button--continue-watch-ddd.focus,' +
                    'body.touch-device .button--continue-watch-ddd.hover,' +
                    'body.touch-device .button--continue-watch-ddd:hover,' +
                    'body.touch-device .button--continue-watch-ddd:active{' +
                        'background-color:rgba(0,0,0,.3)!important;' +
                        'color:#fff!important;' +
                        'transform:none!important;' +
                        'animation:none!important;' +
                    '}' +

                    '@media(max-width:767px){' +
                        '.button--continue-watch-ddd,' +
                        '.button--continue-watch-ddd.focus,' +
                        '.button--continue-watch-ddd.hover,' +
                        '.button--continue-watch-ddd:hover,' +
                        '.button--continue-watch-ddd:active{' +
                            'width:3.5em!important;' +
                            'min-width:3.5em!important;' +
                            'max-width:3.5em!important;' +
                            'height:3.5em!important;' +
                            'min-height:3.5em!important;' +
                            'padding:0!important;' +
                            'margin-left:0!important;' +
                            'margin-right:.45em!important;' +
                            'gap:0!important;' +
                            'justify-content:center!important;' +
                            'overflow:visible!important;' +
                            'background-color:rgba(0,0,0,.3)!important;' +
                            'color:#fff!important;' +
                            'transform:none!important;' +
                            'animation:none!important;' +
                            'transition:none!important;' +
                        '}' +
                        '.button--continue-watch-ddd span,' +
                        '.button--continue-watch-ddd.focus span,' +
                        '.button--continue-watch-ddd.hover span,' +
                        '.button--continue-watch-ddd:hover span,' +
                        '.button--continue-watch-ddd:active span{' +
                            'display:none!important;' +
                        '}' +
                    '}';

                var style = document.getElementById('continue-watch-universal-source-button-style');

                if (!style) {
                    style = document.createElement('style');
                    style.id = 'continue-watch-universal-source-button-style';
                    style.type = 'text/css';
                    document.head.appendChild(style);
                }

                style.textContent = css;
            } catch (e) {}
        }
        function createStatusButton(movie) {
            var html =
                '<div class="full-start__button selector button--continue-watch-ddd-debug">' +
                    '<span>CW статус</span>' +
                '</div>';

            var button = $(html);

            button.off('hover:enter.continueWatchUniversalDebug').on('hover:enter.continueWatchUniversalDebug', function () {
                var params = StorageManager.getLastStreamParams(movie);
                var ddd = DDDTransport.getStatus();
                var nativeStatus = LampaNativeTransport.getStatus();
                var session = SessionManager.getCurrent();

                Utils.noty(
                    'platform=' + Utils.getPlatformKind() +
                    ' player=' + Utils.getTorrentPlayerType() +
                    ' source=' + Core.getActiveSource() +
                    ' ddd=' + (ddd.canUse ? 'yes' : 'no'),
                    true,
                    0
                );

                setTimeout(function () {
                    Utils.noty(
                        'hist=' + (params ? 'S' + (params.season || 0) + 'E' + (params.episode || 0) : 'none') +
                        ' sess=' + (session ? session.sid : 'none') +
                        ' tl=' + (nativeStatus.lastTimelineHash || '-'),
                        true,
                        0
                    );
                }, 700);

                try {
                    DDDTransport.probe(true);
                } catch (e) {}
            });

            return button;
        }

        function getEventMovie(event) {
            var active = null;
            var activity = null;

            try {
                active = Lampa.Activity && Lampa.Activity.active ? Lampa.Activity.active() : null;
            } catch (e) {}

            activity = event && event.object && event.object.activity
                ? event.object.activity
                : active;

            return (
                (event && event.data && event.data.movie) ||
                (activity && activity.movie) ||
                (activity && activity.card) ||
                (activity && activity.params && activity.params.movie) ||
                (active && active.movie) ||
                (active && active.card) ||
                (active && active.params && active.params.movie) ||
                getActiveMovieFromCard() ||
                Utils.getActivityMovie()
            );
        }

        function getEventRender(event) {
            var render = event && event.body && event.body.find ? event.body : null;

            if (render && render.find('.full-start-new__buttons').length && render[0] && render[0].offsetParent !== null) {
                return render;
            }

            try {
                var roots = $('.full-start-new').filter(function () {
                    return this.offsetParent !== null;
                });

                if (roots && roots.length) return roots.last();
            } catch (e) {}

            return render;
        }

        function renderCardButtons(render, movie, refreshRemote) {
            if (!render || !render.find || !movie) return;

            Utils.rememberActivityMovie(movie);

            var params = StorageManager.getLastStreamParams(movie);
            rememberUiStatus('render', movie, params, 'refreshRemote=' + (!!refreshRemote));

            function renderButtons(currentParams) {
                render.find('.continue-watch-ddd-standalone').remove();

                var debugButton = render.find('.button--continue-watch-ddd-debug').first();
                var existing = render.find('.button--continue-watch-ddd');

                if (existing.length > 1) {
                    existing.slice(1).remove();
                    existing = existing.first();
                }

                if (!currentParams || !hasContinueHistory(movie, currentParams)) {
                    rememberUiStatus(
                        currentParams ? 'no-timeline' : 'no-params',
                        movie,
                        currentParams,
                        'renderButtons'
                    );

                    if (existing.length) {
                        existing.remove();
                        render.removeData('cwu-controller-button');
                        render.removeAttr('data-cwu-initial-focus-done');

                        try {
                            var current = Lampa.Controller && Lampa.Controller.enabled
                                ? Lampa.Controller.enabled()
                                : null;

                            if (current && current.name === 'full_start' && Lampa.Controller.collectionSet) {
                                var target = render.find('.full-start-new__buttons .selector').filter(function () {
                                    return this.offsetParent !== null;
                                }).first();

                                Lampa.Controller.collectionSet(render);

                                if (current.controller && current.controller.link && target.length) {
                                    current.controller.link.last = target[0];
                                }

                                if (target.length && Lampa.Controller.collectionFocus) {
                                    Lampa.Controller.collectionFocus(target[0], render);
                                }
                            }
                        } catch (removeError) {
                            Utils.error('Card controller cleanup failed', removeError);
                        }
                    }

                    if (DEBUG.enabled && DEBUG.statusButton && DEBUG.noty && !debugButton.length) {
                        getWatchContainer(render).prepend(createStatusButton(movie));
                    }
                    return;
                }

                existing = existing.first();
                var road = getContinueRoad(movie, currentParams);
                var stateKey = [
                    Number(currentParams.timestamp || 0),
                    Number(road.time || 0),
                    Number(road.duration || 0),
                    Number(road.percent || 0),
                    Number(currentParams.season || 0),
                    Number(currentParams.episode || 0)
                ].join(':');

                if (!existing.length) {
                    insertIntoWatchContainer(render, createButton(movie, currentParams));
                } else if (String(existing.attr('data-cwu-state') || '') !== stateKey) {
                    updateButton(existing, movie, currentParams);
                }

                rememberUiStatus(
                    'button-rendered',
                    movie,
                    currentParams,
                    'visible=' + render.find('.button--continue-watch-ddd').length
                );

                render.find('.button--continue-watch-ddd').each(function () {
                    bindLaunch($(this), movie);
                });

                refreshCardController(render);

                setTimeout(function () {
                    refreshCardController(render);
                }, 350);

                if (DEBUG.enabled && DEBUG.statusButton && DEBUG.noty && !debugButton.length) {
                    debugButton = createStatusButton(movie);
                    getWatchContainer(render).find('> .button--continue-watch-ddd').after(debugButton);
                }
            }

            renderButtons(params);

            if (refreshRemote) {
                PlayerManager.refreshRemote(movie, params, renderButtons);
            }
        }

        function scheduleCardRender(event, delay, refreshRemote) {
            setTimeout(function () {
                try {
                    var movie = getEventMovie(event);
                    var render = getEventRender(event);

                    if (movie) Utils.rememberActivityMovie(movie);
                    renderCardButtons(render, movie, refreshRemote);
                } catch (e) {
                    Utils.error('Button render failed', e);
                }
            }, Number(delay || 0));
        }

        function scanActiveCard() {
            cardScanQueued = false;

            CardWatchedRepair.scan();

            try {
                var movie = getEventMovie(null);
                var render = getEventRender(null);

                if (!movie || !render) {
                    rememberUiStatus('scan-missing-context', movie, null, 'render=' + (!!render));
                    return;
                }

                var params = StorageManager.getLastStreamParams(movie);
                var movieKey = StorageManager.getMovieKey(movie) || Utils.getMovieTitle(movie) || 'movie';
                var refreshToken = movieKey + ':' + Number(params && params.timestamp || 0);
                var refreshRemote = refreshToken !== lastRemoteRefreshToken;

                if (refreshRemote) lastRemoteRefreshToken = refreshToken;

                renderCardButtons(render, movie, refreshRemote);
            } catch (e) {
                Utils.error('Card observer failed', e);
            }
        }

        function queueCardScan() {
            if (cardScanQueued) return;
            cardScanQueued = true;
            setTimeout(scanActiveCard, 120);
        }

        function refreshCardController(render) {
            function appendButton() {
                try {
                    var current = Lampa.Controller && Lampa.Controller.enabled
                        ? Lampa.Controller.enabled()
                        : null;
                    var buttons = typeof $ === 'function' && render && render.find
                        ? render.find('.button--continue-watch-ddd').filter(function () {
                            return this.offsetParent !== null;
                        })
                        : null;

                    if (current && current.name === 'full_start' && buttons && buttons.length) {
                        var firstButton = buttons.first();
                        var focusDone = render && render.attr
                            ? render.attr('data-cwu-initial-focus-done') === '1'
                            : true;
                        var controllerLink = current.controller && current.controller.link
                            ? current.controller.link
                            : null;
                        var target = !focusDone
                            ? firstButton[0]
                            : (controllerLink && controllerLink.last);

                        if (!target || target.offsetParent === null || !render[0].contains(target)) {
                            target = firstButton[0];
                        }

                        firstButton
                            .off('.continueWatchUniversalFocus')
                            .on('hover:focus.continueWatchUniversalFocus hover:enter.continueWatchUniversalFocus hover:hover.continueWatchUniversalFocus hover:touch.continueWatchUniversalFocus', function () {
                                try {
                                    var live = Lampa.Controller && Lampa.Controller.enabled
                                        ? Lampa.Controller.enabled()
                                        : null;

                                    if (live && live.name === 'full_start' && live.controller && live.controller.link) {
                                        live.controller.link.last = this;
                                    }
                                } catch (e) {}
                            });

                        var registeredButton = render && render.data
                            ? render.data('cwu-controller-button')
                            : null;
                        var collectionChanged = registeredButton !== firstButton[0];

                        if (collectionChanged) {
                            if (Lampa.Controller.collectionSet) {
                                Lampa.Controller.collectionSet(render);
                            } else if (Lampa.Controller.collectionAppend) {
                                Lampa.Controller.collectionAppend(buttons);
                            }

                            if (render && render.data) {
                                render.data('cwu-controller-button', firstButton[0]);
                            }

                            if (controllerLink) controllerLink.last = target;

                            if (!focusDone && render && render.attr) {
                                render.attr('data-cwu-initial-focus-done', '1');
                            }

                            if (Lampa.Controller.collectionFocus) {
                                Lampa.Controller.collectionFocus(target, render);
                            }
                        }
                    }
                } catch (e) {
                    Utils.error('Card controller refresh failed', e);
                }
            }

            appendButton();
            clearTimeout(controllerRefreshTimer);
            controllerRefreshTimer = setTimeout(appendButton, 300);
        }

        function install() {
            if (installed) return;

            installed = true;

            injectButtonCompatStyles();

            $(document)
                .off(
                    'click.continueWatchUniversalDelegate',
                    '.button--continue-watch-ddd, .continue-watch-ddd-source, [data-buttons-plugin-id="continue_watch_universal"]'
                )
                .on(
                    'click.continueWatchUniversalDelegate',
                    '.button--continue-watch-ddd, .continue-watch-ddd-source, [data-buttons-plugin-id="continue_watch_universal"]',
                    function (event) {
                        if (event) {
                            event.preventDefault();
                            event.stopPropagation();
                        }

                        return launchFromButton($(this), null);
                    }
                );

            Lampa.Listener.follow('full', function (event) {
                if (!event) return;

                var movie = getEventMovie(event);
                if (movie) Utils.rememberActivityMovie(movie);

                if (event.type !== 'start' && event.type !== 'build' && event.type !== 'complite') return;

                if (event.type === 'start') {
                    try {
                        var render = getEventRender(event);

                        if (render && render.removeData) {
                            render.removeData('cwu-controller-button');
                            render.removeAttr('data-cwu-initial-focus-done');
                        }
                    } catch (e) {}
                }

                scheduleCardRender(event, 0, event.type === 'complite');
                scheduleCardRender(event, 250, false);
                scheduleCardRender(event, 1000, false);
            });

            try {
                if (window.MutationObserver && document.body) {
                    cardObserver = new MutationObserver(queueCardScan);
                    cardObserver.observe(document.body, { childList: true, subtree: true });
                }
            } catch (e) {}

            cardScanTimer = setInterval(scanActiveCard, 1200);
            setTimeout(scanActiveCard, 250);
        }

        return {
            install: install,
            removeContinueButtons: removeContinueButtons
        };
    })();

    // ============================================================
    // TransportManager
    // ============================================================

    var TransportManager = (function () {
        function init() {
            LampaNativeTransport.init();

            Utils.log(
                'Transport init',
                'platform=' + Utils.getPlatformKind(),
                'player_torrent=' + Utils.getTorrentPlayerType(),
                'ddd=' + (DDDTransport.canUse() ? 'enabled' : 'disabled')
            );
        }

        return {
            init: init
        };
    })();

    // ============================================================
    // Public debug API
    // ============================================================

    function exposeApi() {
        if (!DEBUG.exposeApi) return;

        window.ContinueWatchUniversal = {
            version: PLUGIN_VERSION,
            config: CONFIG,
            debug: DEBUG,
            utils: {
                platform: Utils.getPlatformKind,
                player: Utils.getTorrentPlayerType,
                shouldUseDDD: Utils.shouldUseDDDLayer,
                parseStreamUrl: Utils.parseStreamUrl
            },
            storage: {
                get: StorageManager.getParams,
                last: StorageManager.getLastStreamParams,
                cleanup: StorageManager.cleanupOld
            },
            session: {
                current: SessionManager.getCurrent
            },
            ddd: {
                status: DDDTransport.getStatus,
                probe: DDDTransport.probe,
                stop: DDDTransport.stopPolling
            },
            native: {
                status: LampaNativeTransport.getStatus,
                sync: NativeTimelineSync.getStatus,
                refresh: NativeTimelineSync.refresh
            },
            ui: {
                remove: UIManager.removeContinueButtons
            }
        };

        window.ContinueWatchDDD = window.ContinueWatchUniversal;
    }

    // ============================================================
    // Init
    // ============================================================

    var initStarted = false;

    function init() {
        if (initStarted) return;
        initStarted = true;

        try {
            Utils.noty('CW active ' + PLUGIN_VERSION, true, 0);
            Utils.log('Init', PLUGIN_VERSION);

            StorageManager.ensureSync();
            StorageManager.cleanupProgressCopies();
            TransportManager.init();
            NativeTimelineSync.init();
            PlayerManager.patchPlayer();
            setTimeout(PlayerManager.patchAndroidOpenPlayer, 500);
            setTimeout(PlayerManager.patchAndroidOpenPlayer, 1500);
            UIManager.install();
            exposeApi();

            setTimeout(function () {
                StorageManager.cleanupOld();
            }, 10000);

            window.__CONTINUE_WATCH_DDD_LAYER_V3_READY__ = true;
            window.__CONTINUE_WATCH_DDD_LAYER_V3_LOADING__ = false;
            window.__CONTINUE_WATCH_DDD_LAYER_V3_VERSION__ = PLUGIN_VERSION;
            window.__CONTINUE_WATCH_TRANSPORT_NEUTRAL_READY__ = true;
            rememberBootStatus('ready', 'init completed');
        } catch (e) {
            initStarted = false;
            window.__CONTINUE_WATCH_DDD_LAYER_V3_READY__ = false;
            window.__CONTINUE_WATCH_DDD_LAYER_V3_LOADING__ = false;
            window.__CONTINUE_WATCH_DDD_LAYER_V3_VERSION__ = PLUGIN_VERSION + ':init-error';
            rememberBootStatus('init-error', String(e && e.message ? e.message : e));

            Utils.error('Init failed', e);

            try {
                if (Lampa.Noty && Lampa.Noty.show) {
                    Lampa.Noty.show('ContinueWatch init error: ' + String(e && e.message ? e.message : e).slice(0, 120));
                }
            } catch (ee) {}
        }
    }

    if (window.appready) {
        init();
    } else {
        Lampa.Listener.follow('app', function (event) {
            if (event && event.type === 'ready') {
                StorageManager.setAccountReady(true);
                init();
            }
        });

        // External plugin caches can finish after the one-shot app:ready event.
        // A delayed guarded init keeps the UI layer deterministic in that case.
        setTimeout(init, 1200);
        setTimeout(init, 4000);
    }
})();
