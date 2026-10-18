/* Lampac Personal Recommendations 1.0.1-cubfix | MIT | uses current profile history */
(function (root, factory) {
    'use strict';
    var engine = factory();
    if (typeof module === 'object' && module.exports) module.exports = engine;
    else root.LampacRecommendationEngine = engine;
}(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    var DAY = 86400000;
    var MAX_ID = 9007199254740991;
    var CATEGORIES = ['history', 'viewed', 'like', 'book', 'thrown'];
    var WEIGHTS = { history: 1, viewed: 2.2, like: 5, book: 0.7, thrown: -3.5 };
    // Источники, чьи id уже равны id TMDB. Проверено на библиотеке сервера:
    // 253 из 253 cub-карточек с imdb_id дают тот же числовой id, что find по imdb_id.
    var TMDB_ID_SOURCES = { 'tmdb': 1, 'cub': 1, 'cub.red': 1 };
    var own = Object.prototype.hasOwnProperty;

    function has(object, name) { return !!object && own.call(object, name); }
    function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
    function finite(value) { return typeof value === 'number' && isFinite(value); }
    function number(value, fallback, min, max) {
        var parsed = typeof value === 'string' && value.replace(/\s/g, '') !== '' ? Number(value) : value;
        return finite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
    }
    function identifier(value) {
        if (typeof value === 'string' && !/^\d+$/.test(value)) return 0;
        var parsed = typeof value === 'string' ? Number(value) : value;
        return finite(parsed) && parsed > 0 && parsed <= MAX_ID && Math.floor(parsed) === parsed ? parsed : 0;
    }
    function text(value, limit) {
        return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/^\s+|\s+$/g, '').slice(0, limit || 1000) : '';
    }
    function date(value) {
        var clean = text(value, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return '';
        var year = Number(clean.slice(0, 4));
        var month = Number(clean.slice(5, 7));
        var day = Number(clean.slice(8, 10));
        var parsed = new Date(Date.UTC(year, month - 1, day));
        return year >= 1900 && parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? clean : '';
    }
    function compareKey(a, b) {
        var ak = a.key || key(a);
        var bk = b.key || key(b);
        var at = ak.split(':');
        var bt = bk.split(':');
        if (at[0] !== bt[0]) return at[0] < bt[0] ? -1 : 1;
        return Number(at[1]) - Number(bt[1]);
    }
    function sourceKey(value) {
        if (typeof value !== 'string' || !/^(movie|tv):\d+$/.test(value)) return '';
        var parts = value.split(':');
        var id = identifier(parts[1]);
        return id ? parts[0] + ':' + id : '';
    }
    function sources(values) {
        if (!Array.isArray(values)) return [];
        var result = [];
        var seen = {};
        values.slice(0, 64).forEach(function (value) {
            if (!object(value)) return;
            var seedKey = sourceKey(value.seed_key || value.key);
            var kind = text(value.kind, 32) || (seedKey ? 'recommendations' : 'trending');
            if (['recommendations', 'similar', 'trending', 'genre'].indexOf(kind) === -1) return;
            if ((kind === 'recommendations' || kind === 'similar') && !seedKey) return;
            var normalized = { seed_key: seedKey, seed_title: text(value.seed_title || value.title, 300), kind: kind };
            if (finite(value.weight)) normalized.weight = number(value.weight, 0, 0, 10);
            var identity = seedKey + ':' + kind;
            if (has(seen, identity)) {
                var prior = result[seen[identity]];
                if ((normalized.weight || 0) > (prior.weight || 0)) prior.weight = normalized.weight;
                if (normalized.seed_title && (!prior.seed_title || normalized.seed_title < prior.seed_title)) prior.seed_title = normalized.seed_title;
            } else {
                seen[identity] = result.length;
                result.push(normalized);
            }
        });
        return result.sort(function (a, b) {
            var ak = a.seed_key + ':' + a.kind;
            var bk = b.seed_key + ':' + b.kind;
            return ak < bk ? -1 : ak > bk ? 1 : 0;
        });
    }

    function normalizeCard(card) {
        if (!object(card)) return null;
        var explicit = identifier(card.tmdb_id);
        var origin = text(card.source, 64).toLowerCase();
        if (origin && origin !== 'tmdb' && !explicit && !has(TMDB_ID_SOURCES, origin)) return null;
        var id = explicit || identifier(card.id);
        if (!id) return null;
        var type = text(card.media_type || card.type, 16).toLowerCase();
        if (type && type !== 'movie' && type !== 'tv') return null;
        if (!type) type = card.first_air_date || (!card.title && card.name) ? 'tv' : card.title ? 'movie' : '';
        if (!type) return null;
        var normalized = {
            id: id,
            tmdb_id: id,
            media_type: type,
            source: 'tmdb',
            adult: card.adult === true || card.adult === 'true' || card.adult === 1 || card.adult === '1',
            genre_ids: [],
            vote_average: number(card.vote_average, 0, 0, 10),
            vote_count: Math.floor(number(card.vote_count, 0, 0, 100000000)),
            popularity: number(card.popularity, 0, 0, 1000000)
        };
        ['title', 'name', 'original_title', 'original_name', 'poster_path', 'backdrop_path', 'original_language'].forEach(function (field) {
            var clean = text(card[field], field.indexOf('_path') !== -1 ? 1000 : 300);
            if (clean) normalized[field] = clean;
        });
        normalized[type === 'movie' ? 'title' : 'name'] = normalized[type === 'movie' ? 'title' : 'name'] || normalized.title || normalized.name || 'Без названия';
        var overview = text(card.overview, 10000);
        if (overview) normalized.overview = overview;
        ['release_date', 'first_air_date'].forEach(function (field) {
            var clean = date(card[field]);
            if (clean) normalized[field] = clean;
        });
        var genreSeen = {};
        var genreValues = Array.isArray(card.genre_ids) ? card.genre_ids : [];
        genreValues.slice(0, 50).forEach(function (value) {
            var genre = identifier(value);
            if (genre && !has(genreSeen, genre)) {
                genreSeen[genre] = true;
                normalized.genre_ids.push(genre);
            }
        });
        if (Array.isArray(card.genres)) {
            normalized.genres = [];
            var namedSeen = {};
            card.genres.slice(0, 50).forEach(function (value) {
                if (!object(value)) return;
                var genre = identifier(value.id);
                if (!genre) return;
                if (!has(genreSeen, genre)) {
                    genreSeen[genre] = true;
                    normalized.genre_ids.push(genre);
                }
                if (!has(namedSeen, genre)) {
                    namedSeen[genre] = true;
                    normalized.genres.push({ id: genre, name: text(value.name, 120) });
                }
            });
        }
        if (Array.isArray(card.recommendation_sources)) normalized.recommendation_sources = sources(card.recommendation_sources);
        return normalized;
    }

    function key(card) {
        var normalized = normalizeCard(card);
        return normalized ? normalized.media_type + ':' + normalized.id : '';
    }
    function isAnime(card) {
        var normalized = normalizeCard(card);
        return !!normalized && normalized.genre_ids.indexOf(16) !== -1 && (normalized.original_language || '').toLowerCase() === 'ja';
    }
    function clock(options) {
        return finite(options.now) && options.now >= 0 ? options.now : new Date().getTime();
    }
    function timestamp(card) {
        var fields = ['at', 'time', 'timestamp', 'added_at', 'added', 'watched_at', 'last_seen', 'updated_at', 'created_at', 'date'];
        var i;
        for (i = 0; i < fields.length; i++) {
            var value = card[fields[i]];
            var parsed = typeof value === 'string' ? Number(value) : value;
            if (!finite(parsed) && typeof value === 'string') parsed = Date.parse(value);
            if (finite(parsed) && parsed > 0) return parsed < 100000000000 ? parsed * 1000 : parsed;
        }
        return 0;
    }
    function recency(at, now, floor) {
        if (!at) return 1;
        var age = Math.max(0, now - at) / DAY;
        return floor + (1 - floor) * Math.pow(0.5, age / 90);
    }
    function orderRecency(index, floor) {
        // Favorite keeps newest entries first but strips activity timestamps.
        // Preserve that ordering as confidence without inventing a watched date.
        return floor + (1 - floor) / (1 + index / 20);
    }
    function release(card) {
        var value = card.media_type === 'tv' ? card.first_air_date : card.release_date;
        return value ? Date.parse(value + 'T00:00:00Z') : 0;
    }

    function buildProfile(favorites, feedback, options) {
        favorites = object(favorites) ? favorites : {};
        feedback = object(feedback) ? feedback : {};
        options = object(options) ? options : {};
        var now = clock(options);
        var records = {};
        var stats = { history: 0, viewed: 0, like: 0, book: 0, thrown: 0, feedback: 0, positive: 0, negative: 0 };
        var excluded = {};
        function record(card, normalized) {
            var identity = normalized.media_type + ':' + normalized.id;
            if (!has(records, identity)) records[identity] = { key: identity, card: normalized, positive: 0, negative: 0, kind: '', at: 0, historyAt: -1, historyIndex: Infinity };
            return records[identity];
        }
        CATEGORIES.forEach(function (category) {
            if (!Array.isArray(favorites[category])) return;
            var categorySeen = {};
            favorites[category].forEach(function (raw, index) {
                var card = normalizeCard(raw);
                if (!card) return;
                var current = record(raw, card);
                if (has(categorySeen, current.key)) return;
                categorySeen[current.key] = true;
                stats[category]++;
                var at = timestamp(raw);
                var floor = category === 'like' || category === 'thrown' ? 0.6 : 0.15;
                var weight = WEIGHTS[category] * (at ? recency(at, now, floor) : orderRecency(index, floor));
                if (category === 'history') {
                    current.historyAt = Math.max(current.historyAt, at);
                    current.historyIndex = Math.min(current.historyIndex, index);
                }
                if (category === 'history' || category === 'viewed' || category === 'thrown') excluded[current.key] = true;
                if (weight < 0) current.negative = Math.min(current.negative, weight);
                else if (weight > current.positive) {
                    current.positive = weight;
                    current.kind = category;
                    current.at = at;
                    current.card = card;
                }
            });
        });
        Object.keys(feedback).sort().forEach(function (identity) {
            var value = feedback[identity];
            if (!object(value) || ['like', 'hide', 'seen'].indexOf(value.action) === -1) return;
            var card = normalizeCard(value.card);
            if (!card || key(card) !== identity) return;
            var current = record(value.card, card);
            var at = timestamp({ at: value.at });
            stats.feedback++;
            current.card = card;
            current.kind = 'feedback:' + value.action;
            current.at = at;
            if (value.action === 'hide') {
                current.positive = 0;
                current.negative = -4 * recency(at, now, 0.6);
                excluded[identity] = true;
            } else if (value.action === 'like') {
                current.positive = 6 * recency(at, now, 0.6);
            } else {
                current.positive = 1.8 * recency(at, now, 0.15);
                excluded[identity] = true;
            }
        });
        var signals = [];
        var positiveGenres = {};
        var negativeGenres = {};
        var possibleSeeds = [];
        Object.keys(records).sort().forEach(function (identity) {
            var current = records[identity];
            var weight = current.negative < 0 ? current.negative : current.positive;
            if (!weight) return;
            var kind = current.negative < 0 && current.kind !== 'feedback:hide' ? 'thrown' : current.kind;
            signals.push({ key: identity, card: normalizeCard(current.card), kind: kind, weight: weight, at: current.at });
            if (weight > 0) stats.positive++;
            else stats.negative++;
            current.card.genre_ids.forEach(function (genre) {
                var target = weight > 0 ? positiveGenres : negativeGenres;
                target[genre] = (target[genre] || 0) + Math.abs(weight) / Math.sqrt(Math.max(1, current.card.genre_ids.length));
            });
            if (weight > 0 && !current.card.adult && (!release(current.card) || release(current.card) <= now)) possibleSeeds.push(current);
        });
        var genres = {};
        Object.keys(positiveGenres).concat(Object.keys(negativeGenres)).forEach(function (genre) {
            var positive = positiveGenres[genre] || 0;
            var negative = negativeGenres[genre] || 0;
            // Each genre has its own confidence denominator: many unrelated
            // positive genres cannot dilute an isolated negative preference.
            genres[genre] = (positive - negative) / (6 + positive + negative);
        });
        possibleSeeds.sort(function (a, b) { return b.positive - a.positive || b.at - a.at || compareKey(a, b); });
        var maxSeeds = Math.floor(number(options.maxSeeds, 8, 0, 8));
        var selected = possibleSeeds.slice(0, maxSeeds);
        var historySeeds = possibleSeeds.filter(function (seed) { return seed.historyAt >= 0; });
        historySeeds.sort(function (a, b) {
            if (a.historyAt > 0 && b.historyAt > 0 && a.historyAt !== b.historyAt) return b.historyAt - a.historyAt;
            return a.historyIndex - b.historyIndex || b.positive - a.positive || compareKey(a, b);
        });
        if (maxSeeds > 1 && historySeeds.length && !selected.some(function (seed) { return seed.historyAt >= 0; })) {
            selected[selected.length - 1] = historySeeds[0];
        }
        selected.sort(function (a, b) { return b.positive - a.positive || b.at - a.at || compareKey(a, b); });
        var seeds = selected.map(function (seed) {
            var card = normalizeCard(seed.card);
            card.key = seed.key;
            card.weight = seed.positive;
            return card;
        });
        return { signals: signals, seeds: seeds, genres: genres, excluded: excluded, stats: stats };
    }

    function candidateScore(card, profile, seedMap, now, options) {
        var relevance = 0;
        var topSource = null;
        var sourceValues = [];
        (card.recommendation_sources || []).forEach(function (source) {
            var seed = seedMap[source.seed_key];
            if (!seed || (source.kind !== 'recommendations' && source.kind !== 'similar')) return;
            var value = (source.kind === 'similar' ? 2.2 : 3) * Math.min(1.2, seed.weight / 5);
            sourceValues.push(value);
            if (!topSource || value > topSource.value || (value === topSource.value && source.seed_key < topSource.key)) {
                topSource = { key: source.seed_key, title: seed.title || seed.name || source.seed_title, value: value };
            }
        });
        sourceValues.sort(function (a, b) { return b - a; });
        sourceValues.forEach(function (value, index) { relevance += value * (index === 0 ? 1 : 0.35); });
        relevance = Math.min(5, relevance);
        var preference = 0;
        card.genre_ids.forEach(function (genre) { preference += number(profile.genres[genre], 0, -1, 1); });
        preference /= Math.sqrt(Math.max(1, card.genre_ids.length));
        preference = Math.max(-1.5, Math.min(1.5, preference));
        var prior = number(options.ratingPrior, 6.5, 0, 10);
        var priorVotes = number(options.ratingPriorVotes, 100, 1, 100000);
        var rating = (card.vote_average * card.vote_count + prior * priorVotes) / (card.vote_count + priorVotes);
        var released = release(card);
        var fresh = released ? Math.pow(0.5, Math.max(0, now - released) / (DAY * 730)) : 0;
        var reason;
        if (topSource) reason = 'Похоже на «' + topSource.title + '»';
        else if (!profile.stats.positive) reason = 'Популярно сейчас — начальная подборка';
        else if (preference > 0) reason = 'По вашим любимым жанрам';
        else reason = 'Высокая оценка зрителей';
        return { card: card, key: card.media_type + ':' + card.id, score: relevance + 2 * preference + rating / 5 + fresh * 0.6 + Math.min(0.2, Math.log(1 + card.popularity) / 50), seed: topSource ? topSource.key : '', reason: reason };
    }

    function rank(candidates, profile, options) {
        options = object(options) ? options : {};
        if (!Array.isArray(candidates)) return [];
        profile = object(profile) ? profile : buildProfile({}, {}, options);
        var safeProfile = {
            genres: object(profile.genres) ? profile.genres : {},
            excluded: object(profile.excluded) ? profile.excluded : {},
            stats: object(profile.stats) ? profile.stats : { positive: 0 }
        };
        var now = clock(options);
        var unique = {};
        candidates.forEach(function (value) {
            var card = normalizeCard(value);
            if (!card || card.adult || (release(card) && release(card) > now)) return;
            var identity = card.media_type + ':' + card.id;
            if (has(safeProfile.excluded, identity) && safeProfile.excluded[identity]) return;
            if (options.mediaType === 'anime') {
                if (!isAnime(card)) return;
            } else if (options.mediaType && options.mediaType !== 'all' && card.media_type !== options.mediaType) return;
            if (!has(unique, identity)) unique[identity] = card;
            else {
                var prior = unique[identity];
                var combined = sources((prior.recommendation_sources || []).concat(card.recommendation_sources || []));
                // Pick the better-supported metadata independently of input order.
                var choose = card.vote_count > prior.vote_count || (card.vote_count === prior.vote_count && JSON.stringify(card) < JSON.stringify(prior));
                if (choose) unique[identity] = card;
                unique[identity].recommendation_sources = combined;
            }
        });
        var seedMap = {};
        (Array.isArray(profile.seeds) ? profile.seeds : []).forEach(function (seed) {
            var identity = key(seed);
            if (identity) seedMap[identity] = { weight: number(seed.weight, 0, 0, 10), title: text(seed.title || seed.name, 300) };
        });
        var remaining = Object.keys(unique).map(function (identity) { return candidateScore(unique[identity], safeProfile, seedMap, now, options); });
        var genreCounts = {};
        var seedCounts = {};
        var result = [];
        var limit = Math.floor(number(options.limit, 60, 0, 500));
        var diversity = number(options.diversityFactor, 1, 0, 3);
        while (remaining.length && result.length < limit) {
            var best = -1;
            var bestScore = -Infinity;
            remaining.forEach(function (entry, index) {
                var repeated = 0;
                entry.card.genre_ids.forEach(function (genre) { repeated += genreCounts[genre] || 0; });
                repeated /= Math.max(1, entry.card.genre_ids.length);
                var adjusted = entry.score - diversity * (repeated * 0.65 + (seedCounts[entry.seed] || 0) * 0.7);
                if (adjusted > bestScore || (adjusted === bestScore && (best === -1 || compareKey(entry, remaining[best]) < 0))) {
                    best = index;
                    bestScore = adjusted;
                }
            });
            var selected = remaining.splice(best, 1)[0];
            selected.card.recommendation_reason = selected.reason;
            selected.card.recommendation_score = Math.round(bestScore * 1000000) / 1000000;
            result.push(selected.card);
            selected.card.genre_ids.forEach(function (genre) { genreCounts[genre] = (genreCounts[genre] || 0) + 1; });
            if (selected.seed) seedCounts[selected.seed] = (seedCounts[selected.seed] || 0) + 1;
        }
        return result;
    }

    return { normalizeCard: normalizeCard, key: key, isAnime:isAnime, buildProfile: buildProfile, rank: rank };
}));
;
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(root);
    else root.LampacRecommendationData = factory(root);
}(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this, function (root) {
    'use strict';

    var categories = ['history', 'viewed', 'like', 'book', 'thrown'];
    var cacheTtl = 30 * 60 * 1000;
    var candidateLimit = 500;
    var feedbackLimit = 300;
    // Сколько карточек за одну загрузку дотягиваем до TMDB через find по imdb_id
    // (сопоставление чужих источников и добор жанров для карточек CUB).
    var LOOKUP_LIMIT = 24;
    var genreIds = {
        movie: [28,12,16,35,80,99,18,10751,14,36,27,10402,9648,10749,878,10770,53,10752,37],
        tv: [10759,16,35,80,99,18,10751,10762,9648,10763,10764,10765,10766,10767,10768,37]
    };

    function object(value) {
        return value && typeof value === 'object' && !Array.isArray(value);
    }

    function clone(value) {
        try { return JSON.parse(JSON.stringify(value)); }
        catch (ignore) { return null; }
    }

    function storageGet(lampa, key, fallback) {
        var value;
        try {
            if (lampa.Storage && typeof lampa.Storage.get === 'function') value = lampa.Storage.get(key, fallback);
            else if (lampa.Storage && typeof lampa.Storage.field === 'function') value = lampa.Storage.field(key);
        } catch (ignore) {}
        if (typeof value === 'string' && /^[\[{]/.test(value)) {
            try { value = JSON.parse(value); } catch (ignoreParse) {}
        }
        return value === undefined || value === null ? fallback : value;
    }

    function readFavorites(lampa) {
        var favorite = lampa && lampa.Favorite;
        var result = {};
        var all = null;
        var i;
        if (favorite && typeof favorite.all === 'function') {
            try { all = favorite.all(); } catch (ignoreAll) {}
        }
        for (i = 0; i < categories.length; i++) {
            var type = categories[i];
            var list = null;
            if (favorite && typeof favorite.get === 'function') {
                try { list = favorite.get({type: type}); } catch (ignoreGet) {}
            }
            if (!Array.isArray(list) && object(all)) list = all[type];
            result[type] = Array.isArray(list) ? list.filter(function (card) { return object(card); }).slice() : [];
        }
        return result;
    }

    function syncRuntime(lampa) {
        return lampa.LampacSync || root.LampacSync;
    }

    function callSync(sync, name, fallback) {
        try { return sync && typeof sync[name] === 'function' ? sync[name]() : fallback; }
        catch (ignore) { return fallback; }
    }

    function hash(text, initial) {
        var value = initial;
        for (var i = 0; i < text.length; i++) {
            value ^= text.charCodeAt(i);
            value += (value << 1) + (value << 4) + (value << 7) + (value << 8) + (value << 24);
        }
        return ('00000000' + (value >>> 0).toString(16)).slice(-8);
    }

    function owner(lampa) {
        lampa = lampa || {};
        var sync = syncRuntime(lampa);
        var ready = !sync || callSync(sync, 'ready', false);
        var identity = [];
        var profile;
        if (sync && ready) {
            identity.push(storageGet(lampa, 'lampac_sync_owner_v1', ''));
            identity.push(callSync(sync, 'uid', ''));
            identity.push(callSync(sync, 'profile', ''));
        }
        identity.push(storageGet(lampa, 'lampac_unic_id', ''));
        identity.push(storageGet(lampa, 'unic_id', ''));
        identity.push(storageGet(lampa, 'account_email', ''));
        identity.push(storageGet(lampa, 'lampac_profile_id', ''));
        profile = storageGet(lampa, 'account', {});
        identity.push(object(profile) ? profile.id || profile.email || '' : profile);
        identity.push(object(profile) && object(profile.profile) ? profile.profile.id || '' : '');
        profile = storageGet(lampa, 'profile', {});
        identity.push(object(profile) ? profile.id || profile.name || '' : profile);
        identity.push(ready ? 'ready' : 'sync-pending');
        var text = JSON.stringify(identity);
        return 'owner-' + hash(text, 2166136261) + hash(text, 3335557771);
    }

    function create(lampa, engine, options) {
        options = options || {};
        lampa = lampa || {};
        var now = options.now || function () { return new Date().getTime(); };
        var timers = options.timers || root;
        var setTimer = options.setTimeout || function (fn, delay) { return timers.setTimeout(fn, delay); };
        var clearTimer = options.clearTimeout || function (id) { timers.clearTimeout(id); };
        var timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 8000;
        var memory = {};
        var invalidated = {};
        var active = null;
        var disposed = false;

        function state() {
            var sync = syncRuntime(lampa);
            return {owner: owner(lampa), ready: !sync || !!callSync(sync, 'ready', false), epoch: callSync(sync, 'epoch', 0)};
        }

        function sameState(expected) {
            var current = state();
            return current.ready && current.owner === expected.owner && current.epoch === expected.epoch;
        }

        function get(key) {
            var stored = storageGet(lampa, key, null);
            return stored === null ? memory[key] : stored;
        }

        function put(key, value) {
            var copy = clone(value);
            memory[key] = copy;
            try { if (lampa.Storage && typeof lampa.Storage.set === 'function') lampa.Storage.set(key, copy); }
            catch (ignore) {}
        }

        function feedbackKey(identity) { return 'lampac_recommendation_feedback_' + identity; }
        function cacheKey(identity) { return 'lampac_recommendation_candidates_' + identity; }
        function resolutionKey(identity) { return 'lampac_recommendation_resolved_' + identity; }

        function imdb(card) {
            return card && typeof card.imdb_id === 'string' && /^tt\d+$/.test(card.imdb_id) ? card.imdb_id : '';
        }

        function resolutions(identity) {
            var saved = get(resolutionKey(identity));
            var result = {};
            if (!object(saved)) return result;
            Object.keys(saved).slice(0, 100).forEach(function (key) {
                var card = /^tt\d+$/.test(key) && saved[key] && engine.normalizeCard(saved[key].card);
                if (card) result[key] = {card:card, at:Number(saved[key].at) || 0};
            });
            return result;
        }

        function resolvedFavorites(favorites, mapped) {
            var result = {};
            categories.forEach(function (category) {
                result[category] = favorites[category].map(function (original) {
                    var entry = mapped[imdb(original)];
                    if (!entry) return original;
                    var normalized = engine.normalizeCard(original);
                    if (normalized && normalized.genre_ids.length) return original;
                    var copy = {};
                    Object.keys(original).forEach(function (field) { copy[field] = original[field]; });
                    if (!normalized) {
                        Object.keys(entry.card).forEach(function (field) { copy[field] = entry.card[field]; });
                        return copy;
                    }
                    // Карточка уже опознана: дополняем только недостающие поля,
                    // идентичность (id/тип) не трогаем.
                    if ((!copy.genre_ids || !copy.genre_ids.length) && entry.card.genre_ids && entry.card.genre_ids.length)
                        copy.genre_ids = entry.card.genre_ids.slice();
                    return copy;
                });
            });
            return result;
        }

        function profileFor(identity) {
            var favorites = resolvedFavorites(readFavorites(lampa), resolutions(identity));
            var profile = engine.buildProfile(favorites, readFeedback(identity), {now:now()});
            var unsupported = {};
            categories.forEach(function (category) {
                favorites[category].forEach(function (card) {
                    if (!engine.normalizeCard(card)) unsupported[String(card.source || '') + ':' + String(card.media_type || card.type || '') + ':' + String(card.id || imdb(card))] = true;
                });
            });
            profile.stats.unsupported = Object.keys(unsupported).length;
            return profile;
        }

        function topGenres(profile) {
            return Object.keys(profile.genres || {}).filter(function (genre) { return /^\d+$/.test(genre) && profile.genres[genre] > 0; }).sort(function (a, b) { return profile.genres[b] - profile.genres[a] || Number(a) - Number(b); }).slice(0, 2);
        }

        function fingerprint(profile) {
            return JSON.stringify({poolVersion:2, seeds:(profile.seeds || []).map(function (seed) { return seed.key || engine.key(seed); }).sort(), genres:topGenres(profile).sort()});
        }

        function lookupJobs(favorites, mapped) {
            var result = [];
            var seen = {};
            ['like','history','viewed','book'].forEach(function (category) {
                var ordered = favorites[category].slice();
                ordered.sort(function (a, b) {
                    function at(card) {
                        var value = card.at || card.time || card.timestamp || card.added_at || 0;
                        var numeric = Number(value);
                        if (!isFinite(numeric) && typeof value === 'string') numeric = Date.parse(value);
                        if (!isFinite(numeric) || numeric <= 0) return 0;
                        return numeric < 100000000000 ? numeric * 1000 : numeric;
                    }
                    return at(b) - at(a);
                });
                ordered.forEach(function (card) {
                    var identifier = imdb(card);
                    if (result.length === LOOKUP_LIMIT || !identifier || seen[identifier] || mapped[identifier]) return;
                    var normalized = engine.normalizeCard(card);
                    // Жанры нужны для жанрового профиля, а карточки CUB приходят без genre_ids.
                    if (normalized && normalized.genre_ids.length) return;
                    seen[identifier] = true;
                    var type = normalized ? normalized.media_type : (card.media_type || card.type);
                    result.push({path:'find/' + identifier + '?external_source=imdb_id', params:{}, lookup:identifier, type:type === 'movie' || type === 'tv' ? type : ''});
                });
            });
            return result;
        }

        function readFeedback(identity) {
            var saved = get(feedbackKey(identity));
            var result = {};
            if (!object(saved)) return result;
            Object.keys(saved).forEach(function (key) {
                var item = saved[key];
                var card = item && engine.normalizeCard(item.card);
                if (card && engine.key(card) === key && /^(like|hide|seen)$/.test(item.action)) {
                    result[key] = {card: card, action: item.action, at: Number(item.at) || 0};
                }
            });
            return result;
        }

        function feedback() {
            var current = state();
            return current.ready ? clone(readFeedback(current.owner)) || {} : {};
        }

        function validFeedbackCard(card, current) {
            if (!current.ready || disposed || !card) return null;
            if (card.recommendation_owner && card.recommendation_owner !== current.owner) return null;
            if (card.recommendation_epoch !== undefined && card.recommendation_epoch !== current.epoch) return null;
            return engine.normalizeCard(card);
        }

        function setFeedback(card, action) {
            var current = state();
            var normalized = validFeedbackCard(card, current);
            if (!normalized || !/^(like|hide|seen)$/.test(action)) return false;
            var saved = readFeedback(current.owner);
            var key = engine.key(normalized);
            saved[key] = {card: normalized, action: action, at: now()};
            var keys = Object.keys(saved).sort(function (a, b) { return saved[b].at - saved[a].at || (a < b ? -1 : 1); });
            for (var i = feedbackLimit; i < keys.length; i++) delete saved[keys[i]];
            if (!sameState(current)) return false;
            put(feedbackKey(current.owner), saved);
            return true;
        }

        function removeFeedback(card) {
            var current = state();
            var normalized = validFeedbackCard(card, current);
            if (!normalized) return false;
            var saved = readFeedback(current.owner);
            delete saved[engine.key(normalized)];
            if (!sameState(current)) return false;
            put(feedbackKey(current.owner), saved);
            return true;
        }

        function clearOperation(operation) {
            operation.finished = true;
            operation.timers.forEach(function (timer) { clearTimer(timer); });
            operation.timers = [];
            if (active === operation) active = null;
        }

        function failOperation(operation, code) {
            if (operation.finished || disposed) return;
            clearOperation(operation);
            if (typeof operation.error === 'function') operation.error({code: code, failures: operation.failures});
        }

        function snapshot(operation, cards, stale) {
            if (operation.finished || disposed) return;
            if (!sameState(operation.state)) return failOperation(operation, 'OWNER_CHANGED');
            var profile = profileFor(operation.state.owner);
            var ranked = engine.rank(cards, profile, {now: now(), limit: candidateLimit});
            ranked.forEach(function (card) {
                card.recommendation_owner = operation.state.owner;
                card.recommendation_epoch = operation.state.epoch;
            });
            if (!sameState(operation.state)) return failOperation(operation, 'OWNER_CHANGED');
            clearOperation(operation);
            if (typeof operation.callback === 'function') operation.callback({owner: operation.state.owner, cards: ranked, profile: profile, stats: profile.stats, stale: stale, failures: operation.failures});
        }

        function defaultRequest(path, complete, error, params) {
            var tmdb = lampa.Api && lampa.Api.sources && lampa.Api.sources.tmdb;
            if (!tmdb || typeof tmdb.get !== 'function') return error();
            return tmdb.get(path, params || {}, complete, error, false);
        }

        var request = options.request || defaultRequest;

        function jobs(profile) {
            var result = [];
            (profile.seeds || []).slice(0, 8).forEach(function (seed) {
                var card = engine.normalizeCard(seed);
                if (!card) return;
                result.push({path: card.media_type + '/' + card.id + '/recommendations', type: card.media_type, params: {}, source: {seed_key: seed.key || engine.key(card), seed_title: card.title || card.name || '', kind: 'recommendations', weight: Number(seed.weight) || 1}});
            });
            result.push({path:'trending/movie/week', type:'movie', params:{}, source:{kind:'trending'}});
            result.push({path:'trending/tv/week', type:'tv', params:{}, source:{kind:'trending'}});
            ['movie','tv'].forEach(function (type) {
                result.push({path:'discover/' + type, type:type, anime:true, params:{genres:'16', orig_lang:'ja', page:1, sort_by:'popularity.desc', filter:{'vote_count.gte':80}}, source:{kind:'genre'}});
            });
            var genres = topGenres(profile);
            genres.forEach(function (genre) {
                ['movie','tv'].forEach(function (type) {
                    if (genreIds[type].indexOf(Number(genre)) === -1) return;
                    result.push({path:'discover/' + type, type:type, params:{genres:genre, page:1, sort_by:'popularity.desc', filter:{'vote_count.gte':80}}, source:{kind:'genre'}});
                });
            });
            return result;
        }

        function mergeLookup(operation, job, response) {
            if (!object(response) || !Array.isArray(response.movie_results) || !Array.isArray(response.tv_results)) return false;
            var matches = [];
            ['movie','tv'].forEach(function (type) {
                if (job.type && job.type !== type) return;
                response[type + '_results'].forEach(function (raw) {
                    if (!object(raw)) return;
                    var input = {};
                    Object.keys(raw).forEach(function (key) { input[key] = raw[key]; });
                    input.source = 'tmdb';
                    input.media_type = type;
                    var card = engine.normalizeCard(input);
                    if (card) matches.push(card);
                });
            });
            if (matches.length === 1) {
                operation.resolved[job.lookup] = {card:matches[0], at:now()};
                var keys = Object.keys(operation.resolved).sort(function (a, b) { return operation.resolved[b].at - operation.resolved[a].at; });
                for (var i = 100; i < keys.length; i++) delete operation.resolved[keys[i]];
                put(resolutionKey(operation.state.owner), operation.resolved);
            }
            return true;
        }

        function mergeResponse(operation, job, response) {
            if (!object(response) || !Array.isArray(response.results)) return false;
            var valid = 0;
            (job.anime ? response.results.slice(0, 20) : response.results).forEach(function (raw) {
                if (!object(raw)) return;
                var input = {};
                Object.keys(raw).forEach(function (key) { input[key] = raw[key]; });
                input.media_type = job.type;
                input.source = 'tmdb';
                var card = engine.normalizeCard(input);
                if (!card) return;
                if (job.anime && !engine.isAnime(card)) return;
                valid++;
                var key = engine.key(card);
                var existing = operation.byKey[key];
                if (!existing && job.anime && operation.cards.length === candidateLimit) {
                    for (var index = operation.cards.length - 1; index >= 0; index--) {
                        if (!engine.isAnime(operation.cards[index])) {
                            delete operation.byKey[engine.key(operation.cards[index])];
                            operation.cards.splice(index, 1);
                            break;
                        }
                    }
                }
                if (!existing && operation.cards.length < candidateLimit) {
                    card.recommendation_sources = [];
                    operation.cards.push(card);
                    operation.byKey[key] = card;
                    existing = card;
                }
                if (existing) {
                    var source = clone(job.source);
                    var duplicate = existing.recommendation_sources.some(function (entry) { return entry.kind === source.kind && entry.seed_key === source.seed_key; });
                    if (!duplicate) existing.recommendation_sources.push(source);
                }
            });
            return response.results.length === 0 || valid > 0;
        }

        function load(callback, error, force) {
            if (disposed) return;
            if (active) failOperation(active, 'CANCELLED');
            var current = state();
            if (!current.ready) {
                if (typeof error === 'function') error({code:'SYNC_PENDING', failures:0});
                return;
            }
            var cached = get(cacheKey(current.owner));
            var cachedCards = cached && Array.isArray(cached.cards) ? cached.cards.slice(0, candidateLimit) : [];
            var mapped = resolutions(current.owner);
            var operation = {state:current, callback:callback, error:error, failures:0, candidateFailures:0, candidateCount:0, timers:[], finished:false, cards:[], byKey:{}, cached:cachedCards, jobs:lookupJobs(readFavorites(lampa), mapped), next:0, running:0, resolved:mapped, phase:'lookup', fingerprint:''};
            active = operation;

            function beginCandidates() {
                if (!sameState(current)) return failOperation(operation, 'OWNER_CHANGED');
                var profile = profileFor(current.owner);
                operation.fingerprint = fingerprint(profile);
                if (!force && !invalidated[current.owner] && cachedCards.length && cached.fingerprint === operation.fingerprint && now() - Number(cached.at) >= 0 && now() - Number(cached.at) < cacheTtl) {
                    snapshot(operation, cachedCards, false);
                    return;
                }
                operation.phase = 'candidates';
                var candidateJobs = jobs(profile);
                operation.candidateCount = candidateJobs.length;
                operation.jobs = operation.jobs.concat(candidateJobs);
                pump();
            }

            function finish() {
                if (operation.finished || disposed) return;
                if (!sameState(current)) return failOperation(operation, 'OWNER_CHANGED');
                if (operation.cards.length) {
                    put(cacheKey(current.owner), {at:now(), cards:operation.cards, fingerprint:operation.fingerprint});
                    delete invalidated[current.owner];
                    snapshot(operation, operation.cards, false);
                } else if (operation.cached.length) snapshot(operation, operation.cached, true);
                else if (operation.candidateFailures === operation.candidateCount) failOperation(operation, 'NETWORK_FAILED');
                else snapshot(operation, [], false);
            }

            function start(job) {
                operation.running++;
                var complete = false;
                var timer;
                function settle(response, failed) {
                    if (complete || operation.finished || disposed) return;
                    complete = true;
                    clearTimer(timer);
                    var index = operation.timers.indexOf(timer);
                    if (index !== -1) operation.timers.splice(index, 1);
                    operation.running--;
                    if (!sameState(current)) return failOperation(operation, 'OWNER_CHANGED');
                    var valid = !failed && (job.lookup ? mergeLookup(operation, job, response) : mergeResponse(operation, job, response));
                    if (!valid) {
                        operation.failures++;
                        if (!job.lookup) operation.candidateFailures++;
                    }
                    pump();
                }
                timer = setTimer(function () { settle(null, true); }, timeoutMs);
                operation.timers.push(timer);
                try { request(job.path, function (response) { settle(response, false); }, function () { settle(null, true); }, job.params); }
                catch (ignoreRequest) { settle(null, true); }
            }

            function pump() {
                if (operation.finished || disposed) return;
                while (operation.running < 2 && operation.next < operation.jobs.length && !operation.finished) start(operation.jobs[operation.next++]);
                if (!operation.running && operation.next === operation.jobs.length) {
                    if (operation.phase === 'lookup') beginCandidates();
                    else finish();
                }
            }

            pump();
        }

        function invalidate() {
            invalidated[owner(lampa)] = true;
            if (active) failOperation(active, 'CANCELLED');
        }

        function dispose() {
            disposed = true;
            if (active) clearOperation(active);
            memory = {};
        }

        return {load:load, setFeedback:setFeedback, removeFeedback:removeFeedback, feedback:feedback, invalidate:invalidate, dispose:dispose};
    }

    return {readFavorites:readFavorites, owner:owner, create:create};
}));
;
(function (window) {
    'use strict';

    if (window.LampacRecommendations) return;
    var Lampa;
    var Engine = window.LampacRecommendationEngine;
    var Data = window.LampacRecommendationData;
    var document = window.document;
    var COMPONENT = 'lampac_personal_feed';
    var VERSION = '1.1.1';
    var PAGE_SIZE = 60;
    var instances = [];
    var registered = false;
    var syncBound = null;
    var modes = [
        {title: 'Всё', type: 'all'},
        {title: 'Фильмы', type: 'movie'},
        {title: 'Сериалы', type: 'tv'},
        {title: 'Аниме', type: 'anime'}
    ];

    function icon(name) { return '<svg><use xlink:href="#sprite-' + name + '"></use></svg>'; }
    function notify(text) { if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(text); }
    function open() {
        if (!registered) return false;
        Lampa.Activity.push({component: COMPONENT, title: 'Для вас', page: 1, url: ''});
        return true;
    }
    function openCard(card) {
        var normalized = Engine.normalizeCard(card);
        if (!normalized) return false;
        if (card.recommendation_owner && card.recommendation_owner !== Data.owner(Lampa)) return false;
        Lampa.Activity.push({component: 'full', source: 'tmdb', method: normalized.media_type,
            id: normalized.id, card: normalized, url: '', title: normalized.title || normalized.name});
        return true;
    }
    function addMenu() {
        if (document.getElementById('lampac-personal-feed-menu')) return;
        if (!Lampa.Menu || !Lampa.Menu.addButton) return;
        Lampa.Menu.addButton(icon('feed'), 'Для вас', open)
            .attr('id', 'lampac-personal-feed-menu').attr('data-action', COMPONENT);
    }

    function Feed(object) {
        object = object || {};
        object.page = Math.max(1, parseInt(object.page, 10) || 1);
        object.params = object.params || {};
        object.params.empty = {
            title: 'Пока нет новых рекомендаций',
            descr: 'Выберите другой фильтр или уберите скрытие в «Мои оценки».'
        };
        var self = Lampa.Maker.make('Category', object, function (mask) {
            return mask.toggle(mask.MASK.base, 'Pagination');
        });
        var data = Data.create(Lampa, Engine);
        var owner = Data.owner(Lampa);
        var type = object.recommendation_type || 'all';
        var force = !!object.recommendation_force;
        delete object.recommendation_force;
        var snapshot = null;
        var cards = [];
        var active = false;
        var dead = false;
        var busy = false;
        var dirty = false;
        var built = false;
        var refreshing = false;
        var generation = 0;
        var timer;
        var reloadTimer;
        var historyTimer;
        var headIcon;

        function loader(value) { if (self.activity) self.activity.loader(value); }
        function removeHead() {
            if (headIcon) headIcon.remove();
            headIcon = null;
        }
        function showHead() {
            if (!headIcon && Lampa.Head && Lampa.Head.addIcon) {
                headIcon = Lampa.Head.addIcon(icon('filter'), filters);
                headIcon.attr('title', 'Для вас: фильтры и оценки');
            }
        }
        function back() { if (!dead && !refreshing) self.start(); }
        function select(title, items, callback) {
            Lampa.Select.show({title: title, items: items, onSelect: callback, onBack: back});
        }
        function requestRefresh(refreshPool, resetPage) {
            if (dead || refreshing) return;
            refreshing = true;
            generation++;
            busy = false;
            dirty = false;
            window.clearTimeout(reloadTimer);
            window.clearTimeout(historyTimer);
            reloadTimer = null;
            historyTimer = null;
            data.invalidate();
            if (resetPage !== false) object.page = 1;
            object.recommendation_type = type;
            if (refreshPool) object.recommendation_force = true;
            self.activity.refresh();
        }
        function summary() {
            var stats = snapshot && (snapshot.profile && snapshot.profile.stats || snapshot.stats) || {};
            var text = 'История: ' + Number(stats.history || 0) + ' · Нравится: ' + Number(stats.like || 0) +
                ' · Рекомендаций: ' + cards.length;
            if (stats.unsupported) text += ' · Ещё не сопоставлено с TMDB: ' + Number(stats.unsupported);
            if (snapshot && snapshot.stale) text += ' · Сохранённая подборка: сеть недоступна';
            else if (snapshot && snapshot.failures) text += ' · Часть источников временно недоступна';
            notify(text);
        }
        function filters() {
            if (self.ownerChanged() || dead || refreshing) return;
            var items = modes.map(function (mode) {
                return {title: mode.title, type: mode.type, selected: mode.type === type};
            });
            items.push({title: 'Обновить рекомендации', action: 'refresh'});
            items.push({title: 'Мои оценки', action: 'reviews'});
            items.push({title: 'О подборке', action: 'summary'});
            select('Для вас', items, function (item) {
                if (self.ownerChanged() || dead) return;
                if (item.type) {
                    if (type !== item.type) { type = item.type; requestRefresh(false); }
                    else back();
                } else if (item.action === 'refresh') requestRefresh(true);
                else if (item.action === 'reviews') reviews();
                else { summary(); back(); }
            });
        }
        function applyFeedback(card, action) {
            if (self.ownerChanged() || dead || refreshing) return;
            var saved = action === 'remove' ? data.removeFeedback(card) : data.setFeedback(card, action);
            if (saved === false) { notify('Не удалось сохранить оценку. Попробуйте ещё раз.'); back(); return; }
            requestRefresh(false);
        }
        function reviews() {
            var records = data.feedback();
            var items = [];
            Object.keys(records).forEach(function (key) {
                var record = records[key];
                if (!record || !record.card) return;
                items.push({title: (record.card.title || record.card.name) + ' · ' +
                    ({like: 'Нравится', hide: 'Не интересно', seen: 'Просмотрено'}[record.action] || ''), record: record});
            });
            if (!items.length) { notify('Здесь появятся ваши оценки и скрытые фильмы'); back(); return; }
            select('Мои оценки · выберите, чтобы убрать', items, function (item) {
                applyFeedback(item.record.card, 'remove');
            });
        }
        function page() {
            var number = Math.min(object.page, Math.max(1, Math.ceil(cards.length / PAGE_SIZE)));
            object.page = number;
            return {results: cards.slice((number - 1) * PAGE_SIZE, number * PAGE_SIZE), page: number,
                total_pages: Math.max(1, Math.ceil(cards.length / PAGE_SIZE)), total_results: cards.length};
        }
        function activate() {
            if (dead) return;
            active = true;
            showHead();
            if (self.ownerChanged() || refreshing) return;
            if (dirty && !busy && !reloadTimer) requestRefresh(false);
            else if (!built && !busy && !reloadTimer) self.load(false);
        }
        self.load = function (refreshPool) {
            if (dead || busy || refreshing) return;
            if (built) { requestRefresh(!!refreshPool); return; }
            if (self.ownerChanged()) return;
            window.clearTimeout(reloadTimer);
            reloadTimer = null;
            var turn = ++generation;
            busy = true;
            loader(true);
            data.load(function (value) {
                if (dead || turn !== generation) return;
                busy = false;
                if (Data.owner(Lampa) !== owner || value.owner !== owner) { self.ownerChanged(); return; }
                snapshot = value;
                cards = snapshot.cards.filter(function (card) {
                    return type === 'all' || (type === 'anime' ? Engine.isAnime(card) : card.media_type === type);
                });
                built = true;
                self.build(page());
            }, function (error) {
                if (dead || turn !== generation) return;
                busy = false;
                if (error && (error.code === 'OWNER_CHANGED' || error.code === 'SYNC_PENDING')) {
                    loader(true);
                    reloadTimer = window.setTimeout(function () {
                        reloadTimer = null;
                        if (!dead && active) self.load(false);
                        else dirty = true;
                    }, 1000);
                } else {
                    built = true;
                    self.params.empty = {title: 'Не удалось получить рекомендации',
                        descr: 'Проверьте доступность TMDB в Lampa и обновите ленту. Ваши оценки сохранены.'};
                    self.empty();
                }
            }, !!refreshPool);
        };
        self.ownerChanged = function () {
            if (dead) return false;
            var current = Data.owner(Lampa);
            if (current === owner) return false;
            owner = current;
            snapshot = null;
            cards = [];
            // Hide the previous profile immediately; Activity creates a fresh
            // native Category on refresh, including its cards and controller.
            self.render().hide();
            requestRefresh(false);
            return true;
        };
        self.historyChanged = function () {
            if (dead || refreshing) return;
            dirty = true;
            window.clearTimeout(historyTimer);
            historyTimer = null;
            if (!active) return;
            historyTimer = window.setTimeout(function () {
                historyTimer = null;
                if (!dead && active && !busy && !reloadTimer) requestRefresh(false);
            }, 300);
        };
        self.refresh = function () { requestRefresh(false); };
        self.stop = function () { self.pause(); };
        self.use({
            onCreate: function () {
                instances.push(self);
                if (window.setInterval) timer = window.setInterval(function () {
                    if (!dead && active) { bindSync(); self.ownerChanged(); }
                }, 1000);
                self.load(force);
            },
            onStart: activate,
            onPause: function () { active = false; removeHead(); },
            onEmpty: function () {
                // Native Empty has its own start method. Keep profile checks
                // and the same head menu available when returning to it.
                if (self.empty_class && self.empty_class.use) self.empty_class.use({onStart: activate});
            },
            onNext: function (resolve, reject) {
                if (self.ownerChanged() || refreshing || dead) { reject(); return; }
                resolve(page());
            },
            onInstance: function (item, card) {
                item.use({
                    onEnter: function () { openCard(card); },
                    onFocus: function () { Lampa.Background.change(Lampa.Utils.cardImgBackground(card)); },
                    onMenu: function (menu) {
                        if (Data.owner(Lampa) !== owner || dead || refreshing) return;
                        menu.push({title: 'Почему рекомендовано', action: 'why', onSelect: function () {
                            if (!self.ownerChanged()) notify(card.recommendation_reason || 'Начальная подборка по рейтингу и популярности');
                        }});
                        [['like', 'Нравится'], ['hide', 'Не интересно'], ['seen', 'Уже просмотрено'],
                            ['remove', 'Убрать мою оценку']].forEach(function (entry) {
                            menu.push({title: entry[1], action: entry[0], onSelect: function () { applyFeedback(card, entry[0]); }});
                        });
                    }
                });
            },
            onDestroy: function () {
                dead = true;
                active = false;
                generation++;
                removeHead();
                window.clearTimeout(reloadTimer);
                window.clearTimeout(historyTimer);
                if (timer && window.clearInterval) window.clearInterval(timer);
                if (self.empty_class) self.empty_class.destroy();
                data.dispose();
                var index = instances.indexOf(self);
                if (index >= 0) instances.splice(index, 1);
            }
        });
        return self;
    }

    function changed() {
        instances.slice().forEach(function (instance) {
            if (!instance.ownerChanged()) instance.historyChanged();
        });
    }
    function bindSync() {
        var sync = window.LampacSync;
        if (sync && sync !== syncBound && typeof sync.onChange === 'function') {
            syncBound = sync;
            sync.onChange(changed);
        }
    }
    function install() {
        if (registered || !window.Lampa || !Engine || !Data) return;
        Lampa = window.Lampa;
        if (!Lampa.Component || !Lampa.Component.add || !Lampa.Maker || !Lampa.Maker.make) return;
        registered = true;
        Lampa.Component.add(COMPONENT, Feed);
        addMenu(); bindSync();
        if (Lampa.Listener && Lampa.Listener.follow) {
            Lampa.Listener.follow('lampac', function (event) {
                if (event && (event.name === 'storage_importСompleted' || event.name === 'storage_importCompleted')) changed();
            });
            Lampa.Listener.follow('state:changed', function (event) { if (event && event.target === 'favorite') changed(); });
        }
        if (Lampa.Storage && Lampa.Storage.listener && Lampa.Storage.listener.follow) {
            Lampa.Storage.listener.follow('change', function (event) {
                var name = event && (event.name || event.key);
                if (name && /^(lampac_profile_id|lampac_unic_id|lampac_sync_owner_v1|account_email|account|profile|favorite)$/.test(name)) changed();
            });
        }
        if (Lampa.Account && Lampa.Account.listener && Lampa.Account.listener.follow) Lampa.Account.listener.follow('profile_select', changed);
        if (window.MutationObserver) {
            var menu = document.querySelector('.menu');
            if (menu) new window.MutationObserver(addMenu).observe(menu, {childList: true, subtree: true});
        }
    }

    window.LampacRecommendations = {version: VERSION, open: open, openCard: openCard};
    if (window.appready) install();
    else if (window.Lampa && window.Lampa.Listener) window.Lampa.Listener.follow('app', function (event) { if (event && event.type === 'ready') install(); });
}(window));
