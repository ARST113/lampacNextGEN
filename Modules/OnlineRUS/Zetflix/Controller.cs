using Microsoft.AspNetCore.Mvc;
using Shared.Attributes;
using Shared;
using Shared.Models.Base;
using Shared.Models.Templates;
using Shared.Services;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;
using System.Web;
using Shared.Services.Pools;

namespace Zetflix;

public class ZetflixController : BaseOnlineController<ModuleConf>
{
    static readonly HttpClient http2Client = FriendlyHttp.CreateHttp2Client();

    List<HeadersModel> bearer;

    public ZetflixController() : base(ModInit.conf)
    {
        requestInitialization += () =>
        {
            if (init.httpversion == 2)
                httpHydra.RegisterHttp(http2Client);

            bearer = HeadersModel.Init(
                ("Authorization", $"Bearer {init.token}"),
                ("Accept", "application/json")
            );
        };

        loadKitInitialization = (j, i, c) =>
        {
            if (j.ContainsKey("m4s"))
                i.m4s = c.m4s;

            if (j.ContainsKey("reserve"))
                i.reserve = c.reserve;

            i.secret_token = c.secret_token;
            i.token = c.token;

            return i;
        };
    }

    [HttpGet, Staticache(manually: true)]
    [Route("lite/zetflix")]
    async public Task<ActionResult> Index(string orid, string imdb_id, long kinopoisk_id, string title, string original_title, byte serial, string original_language, short year, int t = -1, short s = -1, bool rjson = false, bool similar = false)
    {
        if (string.IsNullOrEmpty(orid))
        {
            if (similar || (0 >= kinopoisk_id && string.IsNullOrEmpty(imdb_id)))
                return await RouteToSpiderSearch(title);
        }

        if (await IsRequestBlocked(rch: !string.IsNullOrEmpty(init.secret_token)))
            return badInitMsg;

        #region search
    rhubFallback:

        string memKey = string.IsNullOrEmpty(orid)
            ? $"zetflix:search:{imdb_id}:{kinopoisk_id}"
            : $"zetflix:search:{orid}";

        var cache = await InvokeCacheResult<ContentRoot>(memKey, TimeSpan.FromHours(4), async e =>
        {
            ContentRoot root = !string.IsNullOrEmpty(orid)
                ? await httpHydra.Get<ContentRoot>($"{init.apihost}/movies/token/{orid}", safety: true, newheaders: bearer)
                : await httpHydra.Get<ContentRoot>($"{init.apihost}/movies/search?imdb={imdb_id}&kp={kinopoisk_id}", safety: true, newheaders: bearer);

            if (root?.data?.category?.slug != null)
                return e.Success(root);

            return e.Fail("root", refresh_proxy: true);
        });

        if (IsRhubFallback(cache))
            goto rhubFallback;

        if (!cache.IsSuccess)
            return OnError(cache.ErrorMsg);
        #endregion

        MediaItem data = cache.Value.data;
        string defaultargs = $"&orid={orid}&imdb_id={imdb_id}&kinopoisk_id={kinopoisk_id}&title={HttpUtility.UrlEncode(title)}&original_title={HttpUtility.UrlEncode(original_title)}&serial={serial}&year={year}&original_language={original_language}";

        if (cache.Value.data.category.slug is "movie" or "anime")
        {
            #region Фильм
            var mtpl = new MovieTpl(title, original_title);
            bool directors_cut = data.flags.directors_cut;

            foreach (var translation in data.translations)
            {
                int trId = translation.id;
                string link = $"{host}/lite/zetflix/video?t={trId}&token_movie={data.token}" + defaultargs;
                string streamlink = accsArgs($"{link.Replace("/video", "/video.m3u8")}&play=true");

                bool uhd = translation.uhd && init.m4s;
                string quality = uhd ? "2160p" : translation.quality;

                if (directors_cut && trId == 66)
                {
                    mtpl.Append(
                        "Режиссерская версия",
                        $"{link}&directors_cut=true",
                        "call",
                        $"{streamlink}&directors_cut=true",
                        voice_name: quality,
                        quality: uhd ? "2160p" : ""
                    );
                }

                mtpl.Append(
                    translation.name,
                    link,
                    "call",
                    streamlink,
                    voice_name: quality,
                    quality: uhd ? "2160p" : ""
                );
            }

            return ContentTpl(mtpl);
            #endregion
        }
        else
        {
            #region Сериал
            if (s == -1)
            {
                var tpl = new SeasonTpl(data.flags.uhd && init.m4s ? "2160p" : null);

                foreach (var season in data.seasons.OrderBy(x => x.season))
                {
                    tpl.Append(
                        $"{season.season} сезон",
                        $"{host}/lite/zetflix?rjson={rjson}&s={season.season}{defaultargs}",
                        season.season.ToString()
                    );
                }

                return ContentTpl(tpl);
            }
            else
            {
                #region Перевод
                var vtpl = new VoiceTpl();
                var temp_translation = new HashSet<int>();

                int activTranslate = t;
                var selectedSeason = data.seasons?.FirstOrDefault(x => x.season == s);
                if (selectedSeason == null)
                    return OnError("selectedSeason");

                foreach (var episode in selectedSeason.episodes)
                {
                    foreach (var translation in episode.translations)
                    {
                        if (translation?.id > 0)
                        {
                            if (temp_translation.Add(translation.id))
                            {
                                if (activTranslate == -1)
                                    activTranslate = translation.id;

                                vtpl.Append(
                                    translation.name,
                                    activTranslate == translation.id,
                                    $"{host}/lite/zetflix?rjson={rjson}&s={s}&t={translation.id}{defaultargs}"
                                );
                            }
                        }
                    }
                }
                #endregion

                var etpl = new EpisodeTpl(vtpl);

                foreach (var episode in selectedSeason.episodes)
                {
                    if (episode.translations != null && !episode.translations.Any(x => x.id == activTranslate))
                        continue;

                    string episodeNum = episode.episode.ToString();
                    string link = $"{host}/lite/zetflix/video?t={activTranslate}&s={s}&e={episodeNum}&token_movie={data.token}" + defaultargs;

                    etpl.Append(
                        $"{episodeNum} серия",
                        title ?? original_title,
                        s,
                        episodeNum,
                        link,
                        "call",
                        streamlink: accsArgs($"{link.Replace("/video", "/video.m3u8")}&play=true")
                    );
                }

                return ContentTpl(etpl);
            }
            #endregion
        }
    }


    #region Video
    [HttpGet]
    [Route("lite/zetflix/video")]
    [Route("lite/zetflix/video.m3u8")]
    async public Task<ActionResult> Video(string token_movie, string title, string original_title, string t, int s, short e, bool play, bool directors_cut, long kinopoisk_id = 0, string imdb_id = null)
    {
        if (await IsRequestBlocked(rch: !string.IsNullOrEmpty(init.secret_token), rch_check: !play))
            return badInitMsg;

        var cache = await InvokeCacheResult<DirectData>($"zetflix:view:stream:{init.secret_token}:{init.token}:{token_movie}:{t}:{s}:{e}:{init.m4s}:{directors_cut}", 20, async cacheEntry =>
        {
            DirectData data = await ResolveStreamData(token_movie, t, s, e, directors_cut, kinopoisk_id, imdb_id);

            if (data == null)
                return cacheEntry.Fail("data", refresh_proxy: true);

            return cacheEntry.Success(data);
        });

        if (!cache.IsSuccess)
            return OnError(cache.ErrorMsg);

        var data = cache.Value;

        #region subtitle
        var subtitles = new SubtitleTpl();

        foreach (var sub in data.file?.tracks ?? new List<Track>())
            subtitles.Append(sub.label, sub.src);
        #endregion

        List<StreamQualityDto> streams = null;

        string liveCtx = LiveCtx(token_movie, t, s, e, directors_cut, kinopoisk_id, imdb_id);

        foreach (var hlsSource in data.file?.hlsSource ?? new List<HlsSource>())
        {
            // first or default
            if (streams == null || hlsSource.@default)
            {
                streams = new List<StreamQualityDto>(6);

                foreach (var q in hlsSource.quality ?? new Dictionary<string, string>())
                {
                    string file = q.Value;
                    if (init.reserve && hlsSource.reserve != null && hlsSource.reserve.TryGetValue(q.Key, out string reserve))
                        file += " or " + reserve;

                    // Ссылку площадки не «запекаем» в прокси-линк: плеер ходит в наш маршрут,
                    // который заново авторизуется на площадке на каждый запрос (#region Живой поток).
                    // Иначе подпись/краевой токен протухают через несколько минут и всё начинает отдавать 403.
                    string live = accsArgs($"{host}/lite/zetflix/stream?k=p&q={HttpUtility.UrlEncode(q.Key)}&lvl=-1&u={UriB64(file)}{liveCtx}");
                    streams.Add(new StreamQualityDto(live, $"{q.Key}p"));
                }
            }
        }

        // 2160/1440 площадка отдаёт только в AV1 (CODECS=av01) — на устройствах без AV1 это чёрный экран.
        // Если AV1 не запрошен (m4s=false), отправляем эти качества в конец: по умолчанию играет H.264 1080p.
        if (!init.m4s && streams != null && streams.Count > 1)
            streams = streams.OrderBy(x => x.quality is "2160p" or "1440p" ? 1 : 0).ToList();

        if (streams == null || streams.Count == 0)
            return OnError("streams");

        var streamquality = new StreamQualityTpl(streams);

        var first = streamquality.Firts();
        if (first == null)
            return OnError();

        if (play)
            return RedirectToPlay(first.link);

        #region segments
        var segments = new SegmentTpl();

        var dfile = data.file;
        string skipTime = dfile?.skipTime;
        string removeTime = dfile?.removeTime;

        if (skipTime != null && skipTime.Contains("-"))
        {
            foreach (string skp in skipTime.Split(","))
            {
                var range = skp.Trim().Split('-');
                if (range.Length >= 2 && int.TryParse(range[0].Trim(), out int start) && int.TryParse(range[1].Trim(), out int end))
                    segments.skip(start, end);
            }
        }

        if (removeTime != null && removeTime.Contains("-"))
        {
            foreach (string skp in removeTime.Split(","))
            {
                var range = skp.Trim().Split('-');
                if (range.Length >= 2 && int.TryParse(range[0].Trim(), out int start) && int.TryParse(range[1].Trim(), out int end))
                    segments.ad(start, end);
            }
        }
        #endregion

        return ContentTo(VideoTpl.ToJson(
            "play",
            first.link,
            (title ?? original_title),
            streamquality: streamquality,
            vast: init.vast,
            subtitles: subtitles,
            segments: segments,
            httpContext: HttpContext
        ));
    }
    #endregion

    #region Живой поток (самообновляемые ссылки)
    string LiveOrigin()
        => string.IsNullOrEmpty(init.linkhost) ? "https://tories-as.stloadi.live" : init.linkhost.TrimEnd('/');

    string LiveCtx(string token_movie, string t, int s, short e, bool directors_cut, long kinopoisk_id, string imdb_id)
    {
        var ctx = new System.Text.StringBuilder();

        ctx.Append($"&tm={HttpUtility.UrlEncode(token_movie)}&t={HttpUtility.UrlEncode(t)}&s={s}&e={e}");

        if (directors_cut)
            ctx.Append("&dc=1");

        if (kinopoisk_id > 0)
            ctx.Append($"&kp={kinopoisk_id}");

        if (!string.IsNullOrEmpty(imdb_id))
            ctx.Append($"&im={HttpUtility.UrlEncode(imdb_id)}");

        return ctx.ToString();
    }

    List<HeadersModel> LiveHeaders(string edgeHash)
    {
        string origin = LiveOrigin();

        var headers = HeadersModel.Init(
            ("Origin", origin),
            ("Referer", origin + "/"),
            ("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        );

        if (!string.IsNullOrEmpty(edgeHash))
            headers.Add(new HeadersModel("Accepts-Controls", edgeHash));

        return headers;
    }

    async Task<string> LiveEdgeHash()
    {
        string edge = await ZetflixGuard.ForHost(LiveOrigin()).GetTokenAsync();

        if (string.IsNullOrEmpty(edge))
            edge = ZetflixSessionManager.GetGlobalEdgeHash();

        return edge;
    }

    async Task<string> LiveFetchPlaylist(string url, string edgeHash, string cacheKey = null)
    {
        if (string.IsNullOrEmpty(url))
            return null;

        // мастер-плейлист меняется редко — не дёргаем площадку на каждый запрос плеера
        if (!string.IsNullOrEmpty(cacheKey))
        {
            var cached = await InvokeCacheResult<string>($"zetflix:live:pl:{cacheKey}", TimeSpan.FromSeconds(45), async cacheEntry =>
            {
                string text2 = await LiveFetchPlaylist(url, edgeHash, null);

                if (string.IsNullOrEmpty(text2))
                    return cacheEntry.Fail("pl");

                return cacheEntry.Success(text2);
            });

            return cached.IsSuccess ? cached.Value : null;
        }

        foreach (string candidate in url.Split(" or ", StringSplitOptions.RemoveEmptyEntries))
        {
            // площадка отдаёт манифесты только «своему» выходному IP, поэтому идём через прокси модуля
            string text = await LiveFetchText(candidate.Trim(), edgeHash);

            // смешивать выходы нельзя: ссылка, выданная одному IP, у другого отдаёт 403
            if (string.IsNullOrEmpty(text) && liveUseProxy)
                text = await httpHydra.Get(candidate.Trim(), safety: true, addheaders: LiveHeaders(edgeHash));

            if (!string.IsNullOrEmpty(text) && text.Contains("#EXTM3U"))
                return text;
        }

        return null;
    }

    HttpClient LiveHttp()
    {
        if (_liveHttp != null)
            return _liveHttp;

        var handler = new HttpClientHandler
        {
            AutomaticDecompression = System.Net.DecompressionMethods.All
        };

        try
        {
            if (liveUseProxy && init.useproxy && init.proxy?.list != null && init.proxy.list.Length > 0)
                handler.Proxy = ProxyManager.ConfigureWebProxy(init.proxy, init.proxy.list.First()).proxy;
        }
        catch { }

        _liveHttp = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(25) };
        return _liveHttp;
    }
    static HttpClient _liveHttp;

    // площадка допускает и прямой выход сервера — важно лишь, чтобы манифест и сегменты шли с одного IP
    static readonly bool liveUseProxy = true;

    async Task<string> LiveFetchText(string url, string edgeHash)
    {
        // WARP-прокси площадки иногда отказывает на короткое время — пара повторов спасает поток
        for (int attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, url);

                foreach (var h in LiveHeaders(edgeHash))
                    request.Headers.TryAddWithoutValidation(h.name, h.val);

                using var response = await LiveHttp().SendAsync(request, HttpCompletionOption.ResponseHeadersRead);

                if (!response.IsSuccessStatusCode)
                    return null;

                return await response.Content.ReadAsStringAsync();
            }
            catch
            {
                await Task.Delay(250);
            }
        }

        return null;
    }

    static string UriB64(string value)
        => Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(value ?? string.Empty)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    static string UriFromB64(string value)
    {
        if (string.IsNullOrEmpty(value))
            return null;

        string s = value.Replace('-', '+').Replace('_', '/');

        switch (s.Length % 4)
        {
            case 2: s += "=="; break;
            case 3: s += "="; break;
        }

        try
        {
            return System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(s));
        }
        catch
        {
            return null;
        }
    }

    static string AbsUri(string baseUrl, string uri)
    {
        if (string.IsNullOrEmpty(uri))
            return null;

        if (uri.StartsWith("http://") || uri.StartsWith("https://"))
            return uri;

        try
        {
            string baseOne = baseUrl;
            int idx = baseOne.IndexOf(" or ", StringComparison.Ordinal);

            if (idx > 0)
                baseOne = baseOne.Substring(0, idx);

            return Uri.TryCreate(new Uri(baseOne), uri, out Uri abs) ? abs.ToString() : uri;
        }
        catch
        {
            return uri;
        }
    }

    // площадка умеет отдавать резервные зеркала через " or " — разбираем каждое отдельно
    static string AbsUriList(string baseUrl, string uri)
    {
        if (string.IsNullOrEmpty(uri))
            return null;

        var parts = uri.Split(" or ", StringSplitOptions.RemoveEmptyEntries);

        if (parts.Length < 2)
            return AbsUri(baseUrl, uri.Trim());

        var list = new List<string>(parts.Length);

        foreach (string part in parts)
            list.Add(AbsUri(baseUrl, part.Trim()));

        return string.Join(" or ", list);
    }

    static List<string> PlaylistUris(string playlist)
    {
        var list = new List<string>();

        if (string.IsNullOrEmpty(playlist))
            return list;

        foreach (string raw in playlist.Split('\n'))
        {
            string line = raw.Trim();

            if (line.Length == 0 || line[0] == '#')
                continue;

            list.Add(line);
        }

        return list;
    }

    static string PlaylistMapUri(string playlist)
    {
        if (string.IsNullOrEmpty(playlist))
            return null;

        var m = System.Text.RegularExpressions.Regex.Match(playlist, @"#EXT-X-MAP:[^\n]*?URI=""([^""]+)""");
        return m.Success ? m.Groups[1].Value : null;
    }

    string LiveUrl(string kind, string q, int lvl, int i, string uri, string ctx)
        => accsArgs($"{host}/lite/zetflix/stream?k={kind}&q={HttpUtility.UrlEncode(q)}&lvl={lvl}&i={i}&u={UriB64(uri)}{ctx}");

    ActionResult LiveM3u8(string playlist)
    {
        if (string.IsNullOrEmpty(playlist))
            return OnError("m3u8");

        HttpContext.Response.Headers["Cache-Control"] = "no-store";
        return Content(playlist, "application/vnd.apple.mpegurl");
    }

    // мастер-плейлист: варианты качества переписываем на наш маршрут
    string LiveRewriteMaster(string playlist, string q, string ctx, string baseUrl)
    {
        var sb = new System.Text.StringBuilder(playlist.Length + 2048);
        bool pending = false;
        int lvl = 0;

        foreach (string raw in playlist.Split('\n'))
        {
            string line = raw.TrimEnd('\r');

            if (pending && line.Length > 0 && line[0] != '#')
            {
                sb.Append(LiveUrl("p", q, lvl, -1, AbsUriList(baseUrl, line.Trim()), ctx)).Append('\n');
                lvl++;
                pending = false;
                continue;
            }

            if (line.StartsWith("#EXT-X-STREAM-INF"))
                pending = true;

            sb.Append(line).Append('\n');
        }

        return sb.ToString();
    }

    // медиа-плейлист: сегменты и init-карту переписываем на наш маршрут
    string LiveRewriteMedia(string playlist, string q, int lvl, string ctx, string baseUrl)
    {
        var sb = new System.Text.StringBuilder(playlist.Length + 4096);
        int idx = 0;

        foreach (string raw in playlist.Split('\n'))
        {
            string line = raw.TrimEnd('\r');

            if (line.Length > 0 && line[0] != '#')
            {
                sb.Append(LiveUrl("v", q, lvl, idx, AbsUriList(baseUrl, line.Trim()), ctx)).Append('\n');
                idx++;
                continue;
            }

            if (line.StartsWith("#EXT-X-MAP"))
            {
                var m = System.Text.RegularExpressions.Regex.Match(line, @"URI=""([^""]+)""");

                if (m.Success)
                    line = line.Substring(0, m.Index) + "URI=\"" + LiveUrl("v", q, lvl, -1, AbsUriList(baseUrl, m.Groups[1].Value), ctx) + "\"" + line.Substring(m.Index + m.Length);
            }
            else if (line.StartsWith("#EXT-X-KEY") || line.StartsWith("#EXT-X-MEDIA") || line.StartsWith("#EXT-X-I-FRAME-STREAM-INF") || line.StartsWith("#EXT-X-PART") || line.StartsWith("#EXT-X-PRELOAD-HINT"))
            {
                var m = System.Text.RegularExpressions.Regex.Match(line, @"URI=""([^""]+)""");

                if (m.Success)
                    line = line.Substring(0, m.Index) + "URI=\"" + LiveUrl("r", q, lvl, -1, AbsUriList(baseUrl, m.Groups[1].Value), ctx) + "\"" + line.Substring(m.Index + m.Length);
            }

            sb.Append(line).Append('\n');
        }

        return sb.ToString();
    }

    string LivePickQuality(DirectData data, string q)
    {
        HlsSource source = null;

        foreach (var hlsSource in data?.file?.hlsSource ?? new List<HlsSource>())
        {
            if (hlsSource?.quality == null || hlsSource.quality.Count == 0)
                continue;

            if (source == null)
                source = hlsSource;

            if (hlsSource.@default)
            {
                source = hlsSource;
                break;
            }
        }

        if (source == null)
            return null;

        string url = null;

        if (!string.IsNullOrEmpty(q))
            source.quality.TryGetValue(q, out url);

        if (string.IsNullOrEmpty(url))
            url = source.quality.Values.FirstOrDefault();

        if (string.IsNullOrEmpty(url))
            return null;

        if (init.reserve && source.reserve != null && !string.IsNullOrEmpty(q) && source.reserve.TryGetValue(q, out string reserve) && !string.IsNullOrEmpty(reserve))
            url += " or " + reserve;

        return url;
    }

    async Task<List<string>> LiveVariants(string master, string masterText, string q, string tm, string t, int s, short e)
    {
        var cache = await InvokeCacheResult<List<string>>($"zetflix:live:v:{init.token}:{tm}:{t}:{s}:{e}:{q}:{master.GetHashCode()}", TimeSpan.FromSeconds(20), async cacheEntry =>
        {
            var list = LiveAbsUris(master, masterText);

            if (list.Count == 0)
                return cacheEntry.Fail("variants");

            return cacheEntry.Success(list);
        });

        return cache.IsSuccess ? cache.Value : LiveAbsUris(master, masterText);
    }

    // площадка отдаёт и относительные пути — приводим к абсолютным от базового плейлиста
    static List<string> LiveAbsUris(string baseUrl, string playlist)
    {
        var list = new List<string>();

        foreach (string uri in PlaylistUris(playlist))
            list.Add(AbsUriList(baseUrl, uri));

        return list;
    }

    async Task<LiveSegmentMap> LiveSegments(string variantUrl, string edgeHash, string q, int lvl, string tm, string t, int s, short e)
    {
        var cache = await InvokeCacheResult<LiveSegmentMap>($"zetflix:live:g:{init.token}:{tm}:{t}:{s}:{e}:{q}:{lvl}:{variantUrl.GetHashCode()}", TimeSpan.FromSeconds(20), async cacheEntry =>
        {
            string text = await LiveFetchPlaylist(variantUrl, edgeHash);

            if (string.IsNullOrEmpty(text))
                return cacheEntry.Fail("segments");

            var segs = new LiveSegmentMap
            {
                map = AbsUriList(variantUrl, PlaylistMapUri(text)),
                items = LiveAbsUris(variantUrl, text)
            };

            if (segs.items.Count == 0)
                return cacheEntry.Fail("empty");

            return cacheEntry.Success(segs);
        });

        return cache.IsSuccess ? cache.Value : null;
    }

    async Task<DirectData> ResolveStreamData(string token_movie, string t, int s, short e, bool directors_cut, long kinopoisk_id, string imdb_id)
    {
        DirectData data = null;

        if (!string.IsNullOrEmpty(init.secret_token))
        {
            string userIp = requestInfo.IP;
            if (init.localip || init.streamproxy)
            {
                userIp = await mylocalip();
                if (userIp == null)
                    return null;
            }

            #region url запроса
            var uri = StringBuilderPool.ThreadInstance;

            uri.Append($"{init.linkhost}/direct?secret_token={init.secret_token}&token_movie={token_movie}")
               .Append($"&ip={userIp}&translation={t}");

            if (s > 0)
                uri.Append($"&season={s}");

            if (e > 0)
                uri.Append($"&episode={e}");

            if (init.m4s)
                uri.Append("&av1=true");

            if (directors_cut)
                uri.Append("&directors_cut");
            #endregion

            var root = await httpHydra.Get<DirectRoot>(uri.ToString(), safety: true);
            if (root?.data?.file?.hlsSource != null && root.data.file.hlsSource.Count > 0)
                data = root.data;
        }

        if (data == null)
            data = await ResolveBnsiStream(token_movie, t, s, e, kinopoisk_id, imdb_id);

        if (data?.file?.hlsSource == null || data.file.hlsSource.Count == 0)
            return null;

        return data;
    }

    [HttpGet, Route("lite/zetflix/stream")]
    async public Task<ActionResult> Stream(string k, string q, int lvl = -1, int i = 0, string u = null,
        string tm = null, string t = null, int s = 0, short e = 0, int dc = 0, long kp = 0, string im = null)
    {
        if (await IsRequestBlocked(rch: false))
            return badInitMsg;

        string edge = await LiveEdgeHash();
        string ctx = LiveCtx(tm, t, s, e, dc != 0, kp, im);
        string raw = UriFromB64(u);

        // ключи шифрования и прочие одиночные ресурсы — отдаём свежий прокси-линк
        if (k == "r")
        {
            if (string.IsNullOrEmpty(raw))
                return OnError("raw");

            if (await LiveStreamBytes(raw, edge))
                return new EmptyResult();

            return OnError("raw");
        }

        var cache = await InvokeCacheResult<DirectData>($"zetflix:live:stream:{init.token}:{tm}:{t}:{s}:{e}:{dc}:{init.m4s}", TimeSpan.FromSeconds(60), async cacheEntry =>
        {
            DirectData data = await ResolveStreamData(tm, t, s, e, dc != 0, kp, im);

            if (data?.file?.hlsSource == null || data.file.hlsSource.Count == 0)
                return cacheEntry.Fail("data");

            return cacheEntry.Success(data);
        });

        string master = cache.IsSuccess ? LivePickQuality(cache.Value, q) : null;

        // площадка не ответила — работаем с тем, что пришло от плеера
        if (string.IsNullOrEmpty(master))
        {
            if (string.IsNullOrEmpty(raw))
                return OnError(cache.IsSuccess ? "quality" : cache.ErrorMsg);

            if (k != "p")
            {
                if (await LiveStreamBytes(raw, edge))
                    return new EmptyResult();

                return OnError("segment");
            }

            string stale = await LiveFetchPlaylist(raw, edge);
            if (string.IsNullOrEmpty(stale))
                return OnError("stale");

            return stale.Contains("#EXT-X-STREAM-INF")
                ? LiveM3u8(LiveRewriteMaster(stale, q, ctx, raw))
                : LiveM3u8(LiveRewriteMedia(stale, q, lvl, ctx, raw));
        }

        string masterText = await LiveFetchPlaylist(master, edge, $"{init.token}:{tm}:{t}:{s}:{e}:{dc}:{q}:{master.GetHashCode()}");
        if (string.IsNullOrEmpty(masterText))
            return OnError("master");

        #region мастер / вариант плейлиста
        if (k == "p")
        {
            if (lvl < 0)
            {
                return masterText.Contains("#EXT-X-STREAM-INF")
                    ? LiveM3u8(LiveRewriteMaster(masterText, q, ctx, master))
                    : LiveM3u8(LiveRewriteMedia(masterText, q, 0, ctx, master));
            }

            var variants = await LiveVariants(master, masterText, q, tm, t, s, e);
            if (variants == null || variants.Count <= lvl)
                return OnError("variant");

            string mediaText = await LiveFetchPlaylist(variants[lvl], edge);

            if (string.IsNullOrEmpty(mediaText))
            {
                // у CDN площадки бывают протухшие ссылки в кэше — берём данные заново
                var fresh = await ResolveStreamData(tm, t, s, e, dc != 0, kp, im);
                string m2 = LivePickQuality(fresh, q);

                if (!string.IsNullOrEmpty(m2))
                {
                    var v2 = LiveAbsUris(m2, await LiveFetchPlaylist(m2, edge));

                    if (v2 != null && v2.Count > lvl)
                        mediaText = await LiveFetchPlaylist(v2[lvl], edge);
                }
            }

            if (string.IsNullOrEmpty(mediaText))
                return OnError("media");

            return LiveM3u8(LiveRewriteMedia(mediaText, q, lvl, ctx, variants[lvl]));
        }
        #endregion

        #region сегмент
        string variantUrl;

        if (masterText.Contains("#EXT-X-STREAM-INF"))
        {
            var lvls = await LiveVariants(master, masterText, q, tm, t, s, e);
            if (lvls == null || lvls.Count == 0)
                return OnError("variants");

            lvl = lvl >= 0 && lvl < lvls.Count ? lvl : 0;
            variantUrl = lvls[lvl];
        }
        else
        {
            lvl = 0;
            variantUrl = master;
        }

        var segs = await LiveSegments(variantUrl, edge, q, lvl, tm, t, s, e);
        string segUrl = LiveSegmentUrl(segs, i) ?? raw;

        if (!string.IsNullOrEmpty(segUrl) && await LiveStreamBytes(segUrl, edge))
            return new EmptyResult();

        // повторный резолв «с нуля»: у CDN площадки бывают протухшие ссылки в кэше
        var freshSeg = await ResolveStreamData(tm, t, s, e, dc != 0, kp, im);
        string masterFresh = LivePickQuality(freshSeg, q);

        if (!string.IsNullOrEmpty(masterFresh))
        {
            string masterTextFresh = await LiveFetchPlaylist(masterFresh, edge);

            if (!string.IsNullOrEmpty(masterTextFresh))
            {
                int lvlFresh = 0;
                string variantFresh = masterFresh;

                if (masterTextFresh.Contains("#EXT-X-STREAM-INF"))
                {
                    var lvls = LiveAbsUris(masterFresh, masterTextFresh);

                    if (lvls.Count == 0)
                        return OnError("variants");

                    lvlFresh = lvl >= 0 && lvl < lvls.Count ? lvl : 0;
                    variantFresh = lvls[lvlFresh];
                }

                var segsFresh = await LiveSegments(variantFresh, edge, q, lvlFresh, tm, t, s, e);
                string segUrlFresh = LiveSegmentUrl(segsFresh, i);

                if (!string.IsNullOrEmpty(segUrlFresh) && await LiveStreamBytes(segUrlFresh, edge))
                    return new EmptyResult();
            }
        }

        return OnError("segment");
        #endregion
    }
    #endregion

    // Сегменты отдаём сами: площадка привязывает их к тому же выходному IP, через который отдан плейлист,
    // поэтому и плейлист, и сегменты должны идти через прокси модуля (Cloudflare WARP), а не через общий /proxy.
    async Task<bool> LiveStreamBytes(string url, string edgeHash)
    {
        string range = HttpContext.Request.Headers["Range"].ToString();

        foreach (string candidate in url.Split(" or ", StringSplitOptions.RemoveEmptyEntries))
        {
            for (int attempt = 0; attempt < 2; attempt++)
            {
                try
                {
                    using var request = new HttpRequestMessage(HttpMethod.Get, candidate.Trim());

                    foreach (var h in LiveHeaders(edgeHash))
                        request.Headers.TryAddWithoutValidation(h.name, h.val);

                    if (!string.IsNullOrEmpty(range))
                        request.Headers.TryAddWithoutValidation("Range", range);

                    using var response = await LiveHttp().SendAsync(request, HttpCompletionOption.ResponseHeadersRead);

                    if (!response.IsSuccessStatusCode)
                        break;

                    HttpContext.Response.StatusCode = (int)response.StatusCode;

                    if (response.Content.Headers.ContentType != null)
                        HttpContext.Response.ContentType = response.Content.Headers.ContentType.ToString();

                    if (response.Content.Headers.ContentRange != null)
                        HttpContext.Response.Headers["Content-Range"] = response.Content.Headers.ContentRange.ToString();

                    if (response.Content.Headers.ContentLength != null)
                        HttpContext.Response.ContentLength = response.Content.Headers.ContentLength;

                    HttpContext.Response.Headers["Accept-Ranges"] = "bytes";

                    using var stream = await response.Content.ReadAsStreamAsync();
                    await stream.CopyToAsync(HttpContext.Response.Body, HttpContext.RequestAborted);

                    return true;
                }
                catch
                {
                    // сбой прокси — повторяем, затем пробуем следующее зеркало
                    await Task.Delay(250);
                }
            }
        }

        return false;
    }

    static string LiveSegmentUrl(LiveSegmentMap segs, int i)
    {
        if (segs == null)
            return null;

        return i < 0 ? segs.map : (i < segs.items.Count ? segs.items[i] : null);
    }

    #region ResolveBnsiStream
    async Task<DirectData> ResolveBnsiStream(string token_movie, string t, int s, short e, long kinopoisk_id, string imdb_id)
    {
        string linkHost = string.IsNullOrEmpty(init.linkhost) ? "https://tories-as.stloadi.live" : init.linkhost.TrimEnd('/');
        string token = string.IsNullOrEmpty(init.token) ? init.secret_token : init.token;
        if (string.IsNullOrEmpty(token))
            return null;

        var pUri = new System.Text.StringBuilder();
        pUri.Append($"{linkHost}/?token={token}");
        if (!string.IsNullOrEmpty(token_movie))
            pUri.Append($"&token_movie={token_movie}");
        else if (kinopoisk_id > 0)
            pUri.Append($"&kp={kinopoisk_id}");
        else if (!string.IsNullOrEmpty(imdb_id))
            pUri.Append($"&imdb={imdb_id}");

        if (s > 0) pUri.Append($"&season={s}");
        if (e > 0) pUri.Append($"&episode={e}");
        if (!string.IsNullOrEmpty(t)) pUri.Append($"&translation={t}");

        string playerUrl = pUri.ToString();
        var playerHeaders = HeadersModel.Init(
            ("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"),
            ("Referer", $"{linkHost}/")
        );

        string html = await httpHydra.Get(playerUrl, safety: true, addheaders: playerHeaders);
        if (string.IsNullOrEmpty(html))
            return null;

        var vpMatch = System.Text.RegularExpressions.Regex.Match(html, @"name=[""']viewporti[""']\s+content=[""']([^""']+)[""']");
        if (!vpMatch.Success)
            return null;
        string viewporti = vpMatch.Groups[1].Value;

        var flMatch = System.Text.RegularExpressions.Regex.Match(html, @"fileList\s*=\s*JSON\.parse\('([^']+)'\);");
        if (!flMatch.Success)
            flMatch = System.Text.RegularExpressions.Regex.Match(html, @"fileList\s*=\s*JSON\.parse\(""([^""]+)""\);");
        if (!flMatch.Success)
            return null;

        string actId = null;
        try
        {
            string rawJson = flMatch.Groups[1].Value;
            var fl = Newtonsoft.Json.Linq.JObject.Parse(rawJson);

            if (fl["active"]?["id"] != null)
                actId = fl["active"]["id"].ToString();

            if (fl["all"] != null && !string.IsNullOrEmpty(t))
            {
                string trKey = "t" + t;
                if (s > 0 && e > 0)
                {
                    var epToken = fl["all"]?[s.ToString()]?[e.ToString()]?[trKey];
                    if (epToken?["id"] != null)
                        actId = epToken["id"].ToString();
                }
                else
                {
                    var theatrical = fl["all"]?["theatrical"]?[trKey];
                    if (theatrical is Newtonsoft.Json.Linq.JObject thObj)
                    {
                        foreach (var prop in thObj.Properties())
                        {
                            if (prop.Value?["id"] != null)
                            {
                                actId = prop.Value["id"].ToString();
                                break;
                            }
                        }
                    }
                    if (actId == null && fl["all"]?["directors"]?[trKey] is Newtonsoft.Json.Linq.JObject dirObj)
                    {
                        foreach (var prop in dirObj.Properties())
                        {
                            if (prop.Value?["id"] != null)
                            {
                                actId = prop.Value["id"].ToString();
                                break;
                            }
                        }
                    }
                }
            }
        }
        catch { }

        if (string.IsNullOrEmpty(actId))
            return null;

        string borth = ZetflixBorth.Compute(viewporti);
        string postUrl = $"{linkHost}/bnsi/movies/{actId}";

        var bnsiHeaders = HeadersModel.Init(
            ("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"),
            ("Origin", linkHost),
            ("Referer", playerUrl),
            ("Borth", borth),
            ("Accept", "application/json, text/plain, */*"),
            ("X-Requested-With", "XMLHttpRequest"),
            ("Content-Type", "application/x-www-form-urlencoded")
        );

        string audioParam = string.IsNullOrEmpty(t) ? "66" : t;
        string postData = $"token={token}&av1={(init.m4s ? "true" : "false")}&autoplay=0&audio={audioParam}";

        var bnsiResp = await httpHydra.Post<BnsiResponse>(postUrl, postData, safety: true, addheaders: bnsiHeaders);
        if (bnsiResp?.hlsSource == null || bnsiResp.hlsSource.Count == 0)
        {
            string dynamicBorth = await ZetflixBorth.ComputeFromHtmlAsync(html, viewporti, linkHost);
            if (!string.IsNullOrEmpty(dynamicBorth) && dynamicBorth != borth)
            {
                bnsiHeaders.RemoveAll(x => x.name == "Borth");
                bnsiHeaders.Add(new HeadersModel("Borth", dynamicBorth));
                bnsiResp = await httpHydra.Post<BnsiResponse>(postUrl, postData, safety: true, addheaders: bnsiHeaders);
            }
        }

        if (bnsiResp?.hlsSource == null || bnsiResp.hlsSource.Count == 0)
            return null;

        if (!string.IsNullOrEmpty(bnsiResp.pnr) && !string.IsNullOrEmpty(bnsiResp.pnk))
        {
            ZetflixSessionManager.GetOrCreate(bnsiResp.pnr, bnsiResp.pnk, linkHost);
        }
        _ = Task.Run(() => ZetflixGuard.ForHost(linkHost).GetTokenAsync());

        return new DirectData
        {
            file = new FileData
            {
                hlsSource = bnsiResp.hlsSource,
                tracks = bnsiResp.tracks
            }
        };
    }
    #endregion

    #region RouteToSpiderSearch
    [HttpGet, Staticache(manually: true)]
    [Route("lite/zetflix-search")]
    async public Task<ActionResult> RouteToSpiderSearch(string title)
    {
        if (string.IsNullOrWhiteSpace(title))
            return OnError("title", gbcache: false);

        if (await IsRequestBlocked(rch: !string.IsNullOrEmpty(init.token)))
            return badInitMsg;

        var cache = await InvokeCacheResult<List<MediaItem>>($"zetflix:search:{title}", TimeSpan.FromHours(4), async e =>
        {
            var root = await httpHydra.Get<SearchListRoot>($"{init.apihost}/movies/name/list?name={HttpUtility.UrlEncode(title)}", safety: true, newheaders: bearer);
            if (root?.data == null)
                return e.Fail("data", refresh_proxy: true);

            return e.Success(root.data);
        });

        return ContentTpl(cache, () =>
        {
            var stpl = new SimilarTpl(cache.Value.Count);

            foreach (var j in cache.Value)
            {
                stpl.Append(
                    j.name ?? j.original_name,
                    j.year.ToString(),
                    string.Empty,
                    $"{host}/lite/zetflix?orid={j.token}",
                    PosterApi.Size(j.poster)
                );
            }

            return stpl;
        });
    }
    #endregion
}

public class LiveSegmentMap
{
    public string map { get; set; }

    public List<string> items { get; set; } = new List<string>();
}
