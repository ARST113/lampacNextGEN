(function () {
    'use strict';

    var taskId = null;
    var heartbeatTimer = null;
    var switchGeneration = 0;
    var activeSubtitleProbe = null;
    var activePlayerData = null;
    var taskCache = {};
    var taskWaiters = {};
    var warmupTimer = null;
    var taskCacheTtl = 5 * 60 * 1000;

    function account(url) {
        url = String(url || '');
        if (url.indexOf('account_email=') < 0) {
            var email = Lampa.Storage.get('account_email');
            if (email) url = Lampa.Utils.addUrlComponent(url, 'account_email=' + encodeURIComponent(email));
        }
        if (url.indexOf('uid=') < 0) {
            var uid = Lampa.Storage.get('lampac_unic_id', '');
            if (uid) url = Lampa.Utils.addUrlComponent(url, 'uid=' + encodeURIComponent(uid));
        }
        if (url.indexOf('token=') < 0 && '{token}') {
            url = Lampa.Utils.addUrlComponent(url, 'token={token}');
        }
        return url;
    }

    function sourceUrl(data) {
        return rawPidtorSource(data && (data.pidtor_source_url || data.url_orig || data.url) || '');
    }

    function rawPidtorSource(value) {
        var url = String(value || '')
            .replace(/&\.m3u8(?=&|$)/g, '')
            .replace(/([?&])audio=[^&#]*&?/gi, function (_, prefix) { return prefix === '?' ? '?' : ''; })
            .replace(/\?&/, '?')
            .replace(/[?&]$/, '');
        if (/\/lite\/pidtor\/s/i.test(url) && !/[?&]raw=/.test(url)) {
            url = Lampa.Utils.addUrlComponent(url, 'raw=true');
        }
        return url;
    }

    function sourceUrls(data) {
        var values = data && Array.isArray(data.pidtor_source_urls) ? data.pidtor_source_urls.slice() : [];
        if (!values.length && sourceUrl(data)) values.push(sourceUrl(data));
        var seen = {};
        return values.map(rawPidtorSource).map(account).filter(function (value) {
            if (!value || seen[value]) return false;
            seen[value] = true;
            return true;
        });
    }

    function isMkvSource(data) {
        var url = sourceUrl(data);
        if (!url) return false;
        if (/\/dlna\/stream(?:\?|$)/i.test(url) && /[?&]path=[^&#]*\.(?:mkv|avi)(?:[&#]|$)/i.test(url)) return true;
        url = url.split('#')[0].split('?')[0];
        return /\.(?:mkv|avi)$/i.test(url) || /\/lite\/pidtor\//i.test(url);
    }

    function parseJson(response) {
        if (typeof response !== 'string') return response;
        try { return JSON.parse(response); } catch (e) { return null; }
    }

    function taskKey(source, audioIndex) {
        return String(source || '') + '|' + parseInt(audioIndex || 0, 10);
    }

    function forgetTask(id) {
        Object.keys(taskCache).forEach(function (key) {
            if (String(taskCache[key].json.id) === String(id)) delete taskCache[key];
        });
    }

    function task(source, audioIndex, complete, error) {
        var key = taskKey(source, audioIndex);
        var cached = taskCache[key];
        if (cached && cached.expires > Date.now()) {
            var heartbeat = new Lampa.Reguest();
            heartbeat.timeout(3000);
            heartbeat['native']('{localhost}/gst/' + cached.json.id + '/heartbeat', function () {
                complete(cached.json);
            }, function () {
                delete taskCache[key];
                task(source, audioIndex, complete, error);
            }, false, { dataType: 'text' });
            return;
        }
        if (cached) delete taskCache[key];
        if (taskWaiters[key]) {
            taskWaiters[key].push({ complete: complete, error: error });
            return;
        }
        taskWaiters[key] = [{ complete: complete, error: error }];

        function finish(json, message) {
            var waiters = taskWaiters[key] || [];
            delete taskWaiters[key];
            if (json) taskCache[key] = { json: json, expires: Date.now() + taskCacheTtl };
            waiters.forEach(function (waiter) {
                if (json) waiter.complete(json);
                else waiter.error(message);
            });
        }

        var network = new Lampa.Reguest();
        network.timeout(45000);
        var url = '{localhost}/gst/add?linkencode=' + encodeURIComponent(Lampa.Base64.encode(source)) + '&audio=' + audioIndex;
        network['native'](account(url), function (response) {
            var json = parseJson(response);
            if (json && json.id && json.hls) finish(json);
            else finish(null, 'Некорректный ответ GStreamer');
        }, function (response) {
            var message = response && (response.responseText || response.statusText);
            finish(null, message || 'GStreamer не запустил поток');
        }, false, { dataType: 'text' });
    }

    function firstResponsiveSource(sources, complete, error) {
        var queue = sources.slice();

        function isMediaHeader(buffer) {
            if (!buffer || buffer.byteLength < 12) return false;
            var bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16));
            var ebml = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
            var riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
            var mp4 = bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
            return ebml || riff || mp4;
        }

        function nextBatch() {
            var batch = queue.splice(0, 2);
            if (!batch.length) {
                error('Торрент не отдаёт данные');
                return;
            }

            var requests = [];
            var pending = batch.length;
            var settled = false;

            function failed() {
                if (settled) return;
                pending--;
                if (!pending) nextBatch();
            }

            batch.forEach(function (source) {
                var xhr = new XMLHttpRequest();
                requests.push(xhr);
                xhr.open('GET', source, true);
                xhr.responseType = 'arraybuffer';
                xhr.timeout = 18000;
                try { xhr.setRequestHeader('Range', 'bytes=0-65535'); } catch (e) {}
                xhr.onload = function () {
                    var size = xhr.response && xhr.response.byteLength || 0;
                    if (settled) return;
                    if ((xhr.status === 200 || xhr.status === 206) && size > 0 && isMediaHeader(xhr.response)) {
                        settled = true;
                        requests.forEach(function (request) { if (request !== xhr) request.abort(); });
                        complete(source);
                    } else {
                        failed();
                    }
                };
                xhr.onerror = failed;
                xhr.ontimeout = failed;
                xhr.onabort = function () { if (!settled) failed(); };
                xhr.send();
            });
        }

        nextBatch();
    }

    function taskCandidates(sources, audioIndex, complete, error) {
        var candidates = [];
        var seen = {};
        (sources || []).map(rawPidtorSource).map(account).forEach(function (source) {
            if (!source || seen[source]) return;
            seen[source] = true;
            candidates.push(source);
        });
        if (!candidates.length) {
            error('Не найден поток для запуска');
            return;
        }

        function launch(source) {
            task(source, audioIndex, function (json) {
                complete(json, source);
            }, function (message) {
                var rest = candidates.filter(function (item) { return item !== source; });
                if (!rest.length) error(message);
                else taskCandidates(rest, audioIndex, complete, error);
            });
        }

        launch(candidates[0]);
    }

    function warmResource(url, complete) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.timeout = 20000;
        xhr.onload = function () { complete(xhr.status >= 200 && xhr.status < 300 ? xhr.responseText : ''); };
        xhr.onerror = function () { complete(''); };
        xhr.ontimeout = function () { complete(''); };
        xhr.send();
    }

    function resumeSeconds(data) {
        var timeline = data && data.timeline || {};
        var seconds = parseFloat(timeline.time || timeline.position || timeline.played || 0) || 0;
        if (!seconds && timeline.percent && timeline.duration) {
            seconds = (parseFloat(timeline.percent) || 0) * (parseFloat(timeline.duration) || 0) / 100;
        }
        return Math.max(0, seconds);
    }

    function warmHls(json, audioIndex, seekSeconds) {
        if (!json || !json.hls) return;
        var masterUrl = json.hls + '?audio=' + parseInt(audioIndex || 0, 10);
        warmResource(masterUrl, function (master) {
            var videoPath = String(master || '').split(/\r?\n/).filter(function (line) {
                return line && line.charAt(0) !== '#' && /video\.m3u8/i.test(line);
            })[0];
            if (!videoPath) return;
            var videoUrl = new URL(videoPath, masterUrl).href;
            warmResource(videoUrl, function (playlist) {
                var map = String(playlist || '').match(/#EXT-X-MAP:URI="([^"]+)"/i);
                if (map) warmResource(new URL(map[1], videoUrl).href, function () {});
                if (seekSeconds === false) return;
                var lines = String(playlist || '').split(/\r?\n/);
                var elapsed = 0;
                var duration = 0;
                var segment = '';
                lines.some(function (line) {
                    var match = line.match(/^#EXTINF:([\d.]+)/i);
                    if (match) {
                        duration = parseFloat(match[1]) || 0;
                        return false;
                    }
                    if (!line || line.charAt(0) === '#' || !/\.m4s(?:\?|$)/i.test(line)) return false;
                    segment = line;
                    if (elapsed + duration >= (parseFloat(seekSeconds) || 0)) return true;
                    elapsed += duration;
                    return false;
                });
                if (segment) warmResource(new URL(segment, videoUrl).href, function () {});
            });
        });
    }

    function prefetchTask(sources, audioIndex, seekSeconds) {
        taskCandidates(sources, audioIndex, function (json) {
            warmHls(json, audioIndex, seekSeconds);
        }, function () {});
    }

    function scheduleWarmups(data, json, playlist, audioIndex) {
        if (warmupTimer) clearTimeout(warmupTimer);
        warmupTimer = setTimeout(function () {
            var currentEpisode = parseInt(data.episode || 0, 10);
            var currentSeason = parseInt(data.season || 0, 10);
            var next = null;
            (playlist || []).some(function (item) {
                if (parseInt(item.season || 0, 10) !== currentSeason) return false;
                if (parseInt(item.episode || 0, 10) === currentEpisode + 1) {
                    next = item;
                    return true;
                }
                return false;
            });
            if (next) prefetchTask(sourceUrls(next), audioIndex, resumeSeconds(next));

            var tracks = json && json.probe && Array.isArray(json.probe.tracks) ? json.probe.tracks : [];
            var alternate = tracks.filter(function (track) {
                return track && track.type === 'audio' && parseInt(track.index, 10) !== parseInt(audioIndex, 10);
            })[0];
            if (alternate) task(sourceUrl(data), parseInt(alternate.index, 10), function (alternateJson) {
                warmHls(alternateJson, parseInt(alternate.index, 10), resumeSeconds(data));
            }, function () {});

            var qualities = Array.isArray(data.pidtor_quality_options) ? data.pidtor_quality_options : [];
            var alternative = qualities.filter(function (option) { return !option.selected; })[0];
            if (alternative && typeof alternative.resolve === 'function') {
                alternative.resolve(function (resolved) {
                    var sources = typeof resolved === 'string' ? [resolved] : (resolved.sources || [resolved.url]);
                    prefetchTask(sources, audioIndex, resumeSeconds(data));
                }, function () {});
            }
        }, 750);
    }

    function codecName(capsName) {
        var codec = String(capsName || '').replace(/^audio\/x-/i, '').replace(/^audio\//i, '').toLowerCase();
        var names = { ac3: 'AC-3', eac3: 'E-AC-3', aac: 'AAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', dts: 'DTS', truehd: 'TrueHD' };
        return names[codec] || codec.toUpperCase();
    }

    function normalized(value) {
        return String(value || '').toLowerCase().replace(/[\[\](){}]/g, ' ').replace(/[^a-z0-9\u0400-\u04ff]+/g, ' ').trim();
    }

    function normalizedLanguage(value) {
        value = normalized(value);
        if (value === 'ru' || value === 'rus') return 'rus';
        if (value === 'en' || value === 'eng') return 'eng';
        if (value === 'uk' || value === 'ukr') return 'ukr';
        if (value === 'he' || value === 'heb') return 'heb';
        return value;
    }

    function choiceIdentity(choice) {
        if (!choice) return '';
        return normalized(choice.title) + '|' + normalizedLanguage(choice.track && choice.track.language);
    }

    function currentPidtorAudioChoice(data) {
        var options = data && data.pidtor_audio_options || [];
        return options.filter(function (choice) { return choice.key === data.pidtor_audio_key; })[0] || null;
    }

    function matchingPidtorAudio(option, previous) {
        var choices = option && option.audio_options || [];
        if (!choices.length) return null;
        if (previous) {
            var exact = choices.filter(function (choice) { return choiceIdentity(choice) === choiceIdentity(previous); })[0];
            if (exact) return exact;
            var language = normalizedLanguage(previous.track && previous.track.language);
            var sameLanguage = choices.filter(function (choice) {
                return normalizedLanguage(choice.track && choice.track.language) === language;
            })[0];
            if (sameLanguage) return sameLanguage;
        }
        return choices.filter(function (choice) {
            return normalizedLanguage(choice.track && choice.track.language) === 'rus';
        })[0] || choices[0];
    }

    function genericAudioTitle(value, language) {
        var title = normalized(value);
        var lang = normalizedLanguage(language);
        return !title || title === lang || title === 'ru' || title === 'rus' || title === 'en' || title === 'eng'
            || title === 'audio' || title === 'track' || title === 'russian' || title === 'english'
            || title === '\u0440\u0443\u0441\u0441\u043a\u0438\u0439' || title === '\u0430\u043d\u0433\u043b\u0438\u0439\u0441\u043a\u0438\u0439'
            || title === '\u0440\u0443\u0441\u0441\u043a\u0430\u044f \u0434\u043e\u0440\u043e\u0436\u043a\u0430' || title.indexOf('\u0430\u0443\u0434\u0438\u043e\u0434\u043e\u0440\u043e\u0436\u043a\u0430') === 0;
    }

    function subtitleRole(value) {
        var title = normalized(value);
        if (/forced|forsed|\u0444\u043e\u0440\u0441/.test(title)) return 'forced';
        if (/sdh|hearing|\u0433\u043b\u0443\u0445/.test(title)) return 'sdh';
        if (!title || /^(?:ru|rus|russian|en|eng|english|uk|ukr|he|heb)$/.test(title)) return 'main';
        return title;
    }

    function audioTitle(track, index) {
        var title = String(track.title || '').trim();
        var language = String(track.language || '').toLowerCase();
        if (!title || /^(?:audio|track|sound(?:handler)?)\s*#?\d*$/i.test(title)) {
            if (/^(?:en|eng)$/.test(language)) title = 'Original';
            else if (/^(?:ru|rus)$/.test(language)) title = 'Русская дорожка';
            else title = 'Аудиодорожка #' + (index + 1);
        }
        return title;
    }

    function buildAudioItems(data, json, selectedIndex) {
        var tracks = json.probe && Array.isArray(json.probe.tracks) ? json.probe.tracks : [];
        var unique = {};
        var items = [];
        tracks.filter(function (track) { return track && track.type === 'audio'; }).forEach(function (track, index) {
            var audioIndex = Number.isFinite(parseInt(track.index, 10)) ? parseInt(track.index, 10) : index;
            var title = audioTitle(track, index);
            var language = String(track.language || '').toUpperCase();
            var manifestTrack = data && data.pidtor_variant && data.pidtor_variant.audio && data.pidtor_variant.audio[index];
            var manifestTitle = manifestTrack && String(manifestTrack.title || '').trim();
            if (genericAudioTitle(title, language) && manifestTitle && !genericAudioTitle(manifestTitle, manifestTrack.language || language)) {
                title = manifestTitle;
            }
            var codec = codecName(track.capsName);
            var channels = parseInt(track.channels || 0, 10);
            var key = normalized(title) + '|' + normalizedLanguage(language);
            if (unique[key]) return;
            unique[key] = true;
            var details = [];
            if (language && language !== 'UND') details.push(language);
            if (codec) details.push(codec);
            if (channels) details.push(channels === 6 ? '5.1' : channels === 8 ? '7.1' : channels + '.0');
            items.push({
                name: title,
                title: title,
                label: title,
                language: language,
                subtitle: details.join(' · '),
                audioIndex: audioIndex,
                selected: audioIndex === selectedIndex
            });
        });
        if (!items.some(function (item) { return item.selected; }) && items[0]) items[0].selected = true;
        items.forEach(function (item) {
            item.onSelect = function () { switchAudio(data, item.audioIndex); };
        });
        return items;
    }

    function buildPidtorAudioItems(data, probeItems) {
        var unique = {};
        var items = [];
        var choices = data && data.pidtor_audio_options || [];
        var sourceProbeItems = choices.length ? [] : (probeItems || []);
        var namedLanguages = {};
        sourceProbeItems.forEach(function (item) {
            var language = item.language;
            var title = item.label || item.title || item.name;
            if (!genericAudioTitle(title, language)) namedLanguages[normalizedLanguage(language)] = true;
        });
        choices.forEach(function (choice) {
            var language = choice.track && choice.track.language;
            if (!genericAudioTitle(choice.title, language)) namedLanguages[normalizedLanguage(language)] = true;
        });
        sourceProbeItems.forEach(function (item) {
            var language = item.language;
            var title = item.label || item.title || item.name;
            if (genericAudioTitle(title, language) && namedLanguages[normalizedLanguage(language)]) return;
            var key = normalized(item.label || item.title || item.name) + '|' + normalizedLanguage(item.language);
            if (!key || unique[key]) return;
            unique[key] = true;
            items.push(item);
        });
        choices.forEach(function (choice) {
            var language = String(choice.track && choice.track.language || '').toUpperCase();
            var title = String(choice.title || '').trim();
            if (genericAudioTitle(title, language) && namedLanguages[normalizedLanguage(language)]) return;
            var key = normalized(title) + '|' + normalizedLanguage(language);
            if (!title || unique[key]) return;
            unique[key] = true;
            var details = [];
            var codec = String(choice.track && choice.track.codec || '').toUpperCase();
            var channels = parseInt(choice.track && choice.track.channels || 0, 10);
            if (language && language !== 'UND') details.push(language);
            if (codec) details.push(codec);
            if (channels) details.push(channels === 6 ? '5.1' : channels === 8 ? '7.1' : channels + '.0');
            var item = {
                name: title,
                title: title,
                label: title,
                language: language,
                subtitle: details.join(' · '),
                selected: false
            };
            item.onSelect = function () {
                choice.resolve(function (resolved) {
                    data.pidtor_audio_key = choice.key;
                    replacePidtorSource(data, resolved, choice.order || 0);
                }, function (message) {
                    Lampa.Noty.show(message || 'Audio track unavailable');
                });
            };
            items.push(item);
        });
        return items;
    }

    function applyAudioPanel(data, json, selectedIndex) {
        var apply = function () {
            if (!data || !data.pidtor_nextgen) return;
            var tracks = buildPidtorAudioItems(data, buildAudioItems(data, json, selectedIndex));
            if (tracks.length) Lampa.PlayerPanel.setTracks(tracks);
            applySubtitlePanel(json, data);
        };
        apply();
        setTimeout(apply, 1200);
        setTimeout(apply, 3000);
    }

    function buildSubtitleItems(json) {
        var tracks = json && json.probe && Array.isArray(json.probe.tracks) ? json.probe.tracks : [];
        var unique = {};
        var items = [];
        tracks.filter(function (track) { return track && track.type === 'subtitle'; }).forEach(function (track, index) {
            var language = String(track.language || 'und').toUpperCase();
            var title = String(track.title || '').trim();
            var label = title || language;
            var key = normalized(label);
            if (unique[key]) return;
            unique[key] = true;
            var item = {
                index: Number.isFinite(parseInt(track.index, 10)) ? parseInt(track.index, 10) : index,
                language: language,
                label: label,
                ghost: false,
                selected: false
            };
            Object.defineProperty(item, 'mode', {
                set: function (mode) {
                    var video = Lampa.PlayerVideo && Lampa.PlayerVideo.video ? Lampa.PlayerVideo.video() : null;
                    var subtitles = video && video.textTracks ? video.textTracks : [];
                    for (var i = 0; i < subtitles.length; i++) {
                        subtitles[i].mode = i === index && mode === 'showing' ? 'showing' : 'disabled';
                        subtitles[i].selected = i === index && mode === 'showing';
                    }
                    item.selected = mode === 'showing';
                },
                get: function () { return item.selected ? 'showing' : 'disabled'; }
            });
            items.push(item);
        });
        return items;
    }

    function buildPidtorSubtitleItems(data, probeItems) {
        var unique = {};
        var items = [];
        (probeItems || []).forEach(function (item) {
            var key = subtitleRole(item.label || item.title) + '|' + normalizedLanguage(item.language);
            if (!key || unique[key]) return;
            unique[key] = true;
            items.push(item);
        });
        (data && data.pidtor_subtitle_options || []).forEach(function (choice) {
            var language = String(choice.track && choice.track.language || 'und').toUpperCase();
            var title = String(choice.title || language).trim();
            var key = subtitleRole(title) + '|' + normalizedLanguage(language);
            if (!title || unique[key]) return;
            unique[key] = true;
            var item = { language: language, label: title, ghost: false, selected: false };
            Object.defineProperty(item, 'mode', {
                set: function (mode) {
                    if (mode !== 'showing') return;
                    choice.resolve(function (resolved) {
                        replacePidtorSource(data, resolved, data.pidtor_audio_stream_index || 0);
                    }, function (message) {
                        Lampa.Noty.show(message || 'Subtitle unavailable');
                    });
                },
                get: function () { return item.selected ? 'showing' : 'disabled'; }
            });
            items.push(item);
        });
        return items;
    }

    function applySubtitlePanel(json, data) {
        var items = buildPidtorSubtitleItems(data, buildSubtitleItems(json));
        if (items.length) Lampa.PlayerPanel.setSubs(items);
    }

    function refreshSubtitlePanel() {
        if (!activeSubtitleProbe) return;
        setTimeout(function () { applySubtitlePanel(activeSubtitleProbe, activePlayerData); }, 0);
    }

    function restorePosition(seconds) {
        if (!(seconds > 0)) return;
        var restored = false;
        var onLoaded = function () {
            if (restored) return;
            restored = true;
            Lampa.PlayerVideo.listener.remove('loadeddata', onLoaded);
            Lampa.PlayerVideo.to(seconds);
        };
        Lampa.PlayerVideo.listener.follow('loadeddata', onLoaded);
        setTimeout(onLoaded, 5000);
    }

    function currentPosition() {
        var video = Lampa.PlayerVideo && Lampa.PlayerVideo.video ? Lampa.PlayerVideo.video() : null;
        return video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
    }

    function replacePidtorSource(data, resolved, audioIndex) {
        var generation = ++switchGeneration;
        var position = currentPosition();
        var sources = (resolved && resolved.sources || [resolved && resolved.url]).filter(Boolean);
        Lampa.Player.loading(true);
        taskCandidates(sources, parseInt(audioIndex || 0, 10), function (json, source) {
            if (generation !== switchGeneration) return;
            taskId = json.id;
            data.pidtor_source_url = source;
            data.pidtor_source_urls = sources.map(account);
            data.url_orig = source;
            data.url = json.hls + '?audio=' + parseInt(audioIndex || 0, 10);
            data.pidtor_audio_stream_index = parseInt(audioIndex || 0, 10);
            activeSubtitleProbe = json;
            applyAudioPanel(data, json, data.pidtor_audio_stream_index);
            Lampa.PlayerVideo.destroy(true);
            restorePosition(position);
            Lampa.PlayerVideo.url(data.url, true);
            Lampa.Player.loading(false);
        }, function (message) {
            if (generation !== switchGeneration) return;
            Lampa.Player.loading(false);
            Lampa.Noty.show(message || 'Audio track unavailable');
        });
    }

    function updatePlaylistAudio(data, audioIndex) {
        data.pidtor_audio_stream_index = audioIndex;
        var playlist = Lampa.PlayerPlaylist && Lampa.PlayerPlaylist.get ? Lampa.PlayerPlaylist.get() : [];
        (playlist || []).forEach(function (item) { item.pidtor_audio_stream_index = audioIndex; });
    }

    function switchAudio(data, audioIndex) {
        var source = sourceUrl(data);
        if (!source) return;
        var generation = ++switchGeneration;
        var position = currentPosition();
        Lampa.Player.loading(true);
        task(source, audioIndex, function (json) {
            if (generation !== switchGeneration) return;
            taskId = json.id;
            data.pidtor_source_url = source;
            data.url_orig = source;
            data.url = json.hls + '?audio=' + audioIndex;
            updatePlaylistAudio(data, audioIndex);
            applyAudioPanel(data, json, audioIndex);
            Lampa.PlayerVideo.destroy(true);
            restorePosition(position);
            Lampa.PlayerVideo.url(data.url, true);
            Lampa.Player.loading(false);
        }, function (message) {
            if (generation !== switchGeneration) return;
            Lampa.Player.loading(false);
            Lampa.Noty.show('Не удалось переключить дорожку: ' + message);
        });
    }

    function buildQualities(data, initial, audioIndex) {
        var options = Array.isArray(data.pidtor_quality_options) ? data.pidtor_quality_options : [];
        if (!options.length) return data.quality;
        var qualities = {};
        options.forEach(function (option) {
            var instance = {
                label: option.label || '',
                url: option.selected ? initial.hls + '?audio=' + audioIndex : '',
                call: function (_, complete) {
                    var position = currentPosition();
                    var generation = ++switchGeneration;
                    var previousAudio = currentPidtorAudioChoice(data);
                    var targetAudio = matchingPidtorAudio(option, previousAudio);
                    instance._resume = position;
                    Lampa.Player.loading(true);
                    var resolver = targetAudio || option;
                    resolver.resolve(function (resolved) {
                        if (generation !== switchGeneration) return;
                        var resolvedSource = account(typeof resolved === 'string' ? resolved : resolved.url);
                        var resolvedSources = typeof resolved === 'string' ? [resolved] : (resolved.sources || [resolved.url]);
                        var targetIndex = targetAudio && targetAudio.track
                            ? parseInt(targetAudio.track.stream_index, 10)
                            : parseInt(data.pidtor_audio_stream_index || 0, 10);
                        if (!Number.isFinite(targetIndex) || targetIndex < 0) targetIndex = 0;
                        taskCandidates(resolvedSources, targetIndex, function (json, activeSource) {
                            if (generation !== switchGeneration) return;
                            taskId = json.id;
                            data.pidtor_source_url = activeSource || resolvedSource;
                            data.pidtor_source_urls = resolvedSources.map(account);
                            data.url_orig = data.pidtor_source_url;
                            data.pidtor_quality_key = option.key;
                            data.pidtor_audio_options = option.audio_options || [];
                            data.pidtor_subtitle_options = option.subtitle_options || [];
                            data.pidtor_audio_key = targetAudio ? targetAudio.key : '';
                            data.pidtor_audio_stream_index = targetIndex;
                            instance.url = json.hls + '?audio=' + targetIndex;
                            applyAudioPanel(data, json, targetIndex);
                            complete(instance.url);
                            setTimeout(function () { Lampa.Player.loading(false); }, 0);
                        }, function (message) {
                            Lampa.Player.loading(false);
                            Lampa.Noty.show('Качество недоступно: ' + message);
                        });
                    }, function (message) {
                        Lampa.Player.loading(false);
                        Lampa.Noty.show(message || 'Качество недоступно');
                    });
                },
                trigger: function () {
                    restorePosition(instance._resume || 0);
                    instance._resume = 0;
                }
            };
            qualities[option.key] = instance;
        });
        return qualities;
    }

    function createPlaylist(data, audioIndex) {
        var playlist = [];
        var sources = Lampa.PlayerPlaylist && Lampa.PlayerPlaylist.get ? Lampa.PlayerPlaylist.get() : [];
        if (!sources || !sources.length) sources = data.playlist || [];
        sources.forEach(function (source) {
            var item = {};
            for (var key in source) {
                if (key !== 'playlist') item[key] = source[key];
            }
            ['pidtor_quality_options', 'pidtor_audio_options', 'pidtor_subtitle_options', 'pidtor_variant'].forEach(function (key) {
                if (typeof source[key] === 'undefined') return;
                Object.defineProperty(item, key, { value: source[key], writable: true, configurable: true });
            });
            item.url_orig = account(source.url_orig || source.pidtor_source_url || source.url);
            item.pidtor_source_url = item.url_orig;
            item.pidtor_source_urls = (source.pidtor_source_urls || [item.url_orig]).map(account);
            var active = source === data;
            if (!active && parseInt(data.episode || 0, 10) > 0) {
                active = parseInt(source.episode || 0, 10) === parseInt(data.episode, 10)
                    && parseInt(source.season || 0, 10) === parseInt(data.season || 0, 10);
            }
            item.url = active ? data.url : item.url_orig;
            item.pidtor_audio_stream_index = audioIndex;
            playlist.push(item);
        });
        return playlist;
    }

    function startPlayback(data, source, json) {
        activePlayerData = data;
        var tracks = json.probe && Array.isArray(json.probe.tracks) ? json.probe.tracks : [];
        var audioTracks = tracks.filter(function (track) { return track && track.type === 'audio'; });
        var requested = parseInt(data.pidtor_audio_stream_index, 10);
        var selected = audioTracks.some(function (track) { return parseInt(track.index, 10) === requested; }) ? requested : (audioTracks[0] ? parseInt(audioTracks[0].index, 10) || 0 : 0);

        data.pidtor_source_url = source;
        data.pidtor_source_urls = sourceUrls(data);
        data.url_orig = source;
        data.url = json.hls + '?audio=' + selected;
        data.pidtor_audio_stream_index = selected;
        data.hls_type = 'hlsjs';
        data.hls_manifest_timeout = 45000;
        data.voiceovers = buildAudioItems(data, json, selected);
        data.quality = buildQualities(data, json, selected);
        if (data.pidtor_nextgen) delete data.ffprobe;
        activeSubtitleProbe = json;

        var playlist = createPlaylist(data, selected);
        if (playlist.length) data.playlist = playlist;
        Lampa.Player.play(data);
        Lampa.Player.playlist(playlist.length ? playlist : [data]);
        applyAudioPanel(data, json, selected);
        taskId = json.id;
        scheduleWarmups(data, json, playlist, selected);
    }

    function handlePlayerStart(event) {
        if (!isMkvSource(event.data)) return;
        var mediaPath = String(event.data.url || '').split('?')[0];
        if (/\/gst\//i.test(event.data.url) || /\.m3u8$/i.test(mediaPath)) return;

        event.abort();
        var data = event.data;
        var sources = sourceUrls(data).map(function (source) {
            return account(source.replace(/&(preload|stat|m3u)(?:=[^&]*)?/g, '&play'));
        });
        var requested = parseInt(data.pidtor_audio_stream_index, 10);
        var audioIndex = Number.isFinite(requested) && requested >= 0 ? requested : 0;

        setTimeout(function () {
            Lampa.Player.close();
            Lampa.Loading.start(function () {}, 'Подготовка потока...');
            taskCandidates(sources, audioIndex, function (json, source) {
                Lampa.Loading.stop();
                startPlayback(data, source, json);
            }, function (message) {
                Lampa.Loading.stop();
                Lampa.Noty.show('PidTor: ' + message);
            });
        }, 10);
    }

    function handlePlayerDestroy() {
        switchGeneration++;
        activeSubtitleProbe = null;
        activePlayerData = null;
        if (warmupTimer) clearTimeout(warmupTimer);
        warmupTimer = null;
        if (taskId !== null) {
            forgetTask(taskId);
            var network = new Lampa.Reguest();
            network.timeout(5000);
            network['native']('{localhost}/gst/remove?id=' + taskId, function () {}, function () {});
            taskId = null;
        }
    }

    function sendHeartbeat() {
        if (taskId === null) return;
        var network = new Lampa.Reguest();
        network['native']('{localhost}/gst/' + taskId + '/heartbeat', function () {}, function () {}, null, { dataType: 'text', timeout: 3000 });
    }

    function stopHeartbeat() {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }

    function handleVideoPause() {
        if (taskId === null) return;
        stopHeartbeat();
        heartbeatTimer = setInterval(sendHeartbeat, 20000);
    }

    function handleVideoPlay() {
        if (taskId !== null) stopHeartbeat();
    }

    function bindLifecycle() {
        if (window.lampac_gstreamer_lifecycle) return;
        window.lampac_gstreamer_lifecycle = true;
        Lampa.Player.listener.follow('destroy', handlePlayerDestroy);
        Lampa.PlayerVideo.listener.follow('pause', handleVideoPause);
        Lampa.PlayerVideo.listener.follow('play', handleVideoPlay);
        Lampa.PlayerVideo.listener.follow('subs', refreshSubtitlePanel);
        Lampa.PlayerVideo.listener.follow('canplay', refreshSubtitlePanel);
    }

    if (!window.lampac_pidtor_gst_plugin) {
        window.lampac_pidtor_gst_plugin = true;
        Lampa.Player.listener.follow('create', function (event) {
            if (!event.data || !event.data.pidtor_nextgen || event.data.pidtor_use_gst !== true) return;
            handlePlayerStart(event);
        });
        bindLifecycle();
    }

    if (window.pidtor_nextgen_gst_only !== true && !window.lampac_transcoding_plugin) {
        window.lampac_transcoding_plugin = true;
        Lampa.Utils.putScriptAsync(['{localhost}/gst/tracks.js']);
        Lampa.Player.listener.follow('create', function (event) {
            if (event.data && event.data.pidtor_nextgen) return;
            handlePlayerStart(event);
        });
        bindLifecycle();
    }

    window.lampac_pidtor_gst_ready = true;
})();
