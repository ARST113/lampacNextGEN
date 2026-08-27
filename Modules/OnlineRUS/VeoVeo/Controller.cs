using Microsoft.AspNetCore.Mvc;
using Shared;
using Shared.Attributes;
using Shared.Models.Base;
using Shared.Models.Templates;
using Shared.Services;
using Shared.Services.RxEnumerate;
using Shared.Services.Utilities;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web;

namespace VeoVeo;

public class VeoVeoController : BaseOnlineController
{
    static readonly HttpClient manifestClient = FriendlyHttp.CreateHttpClient();

    public VeoVeoController() : base(ModInit.conf)
    {
        requestInitialization += () =>
        {
            if (init.httpversion == 2)
                httpHydra.RegisterHttp(manifestClient);
        };
    }

    [HttpGet, Staticache(manually: true)]
    [Route("lite/veoveo")]
    async public Task<ActionResult> Index(long movieid, string imdb_id, long kinopoisk_id, string title, string original_title, byte clarification, string t = null, short s = -1, bool rjson = false, bool similar = false)
    {
        if (await IsRequestBlocked(rch: true, rch_check: !similar))
            return badInitMsg;

        #region search
        if (movieid == 0)
        {
            if (similar)
                return await Spider(title);

            var movie = clarification == 1
                ? await search(null, 0, title, null)
                : await search(imdb_id, kinopoisk_id, title, original_title);
            if (movie == null)
                return await Spider(clarification == 1 ? title : (original_title ?? title));

            movieid = movie.id;
        }
        #endregion

        #region media
    rhubFallback:

        var cache = await InvokeCacheResult<List<CatalogItem>>($"{init.plugin}:view:{movieid}", 20, async e =>
        {
            var root = await httpHydra.Get<List<CatalogItem>>($"{init.host}/balancer-api/proxy/playlists/catalog-api/episodes?content-id={movieid}");

            if (root == null || root.Count == 0)
                return e.Fail("data");

            return e.Success(root);
        });

        if (IsRhubFallback(cache))
            goto rhubFallback;
        #endregion

        var voiceLabels = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        if (cache.Value?.Count > 0)
        {
            IEnumerable<EpisodeVariant> variants = null;

            if (cache.Value.First().season?.order == 0)
            {
                variants = cache.Value.First().episodeVariants;
            }
            else if (s >= 0)
            {
                variants = cache.Value
                    .Where(i => (i.season?.order ?? 0) == s)
                    .SelectMany(i => i.episodeVariants ?? Enumerable.Empty<EpisodeVariant>());
            }

            if (variants != null)
            {
                var groups = variants
                    .Where(i => !string.IsNullOrWhiteSpace(i.title) && !string.IsNullOrWhiteSpace(i.filepath))
                    .GroupBy(i => i.title, StringComparer.OrdinalIgnoreCase)
                    .ToList();

                var labels = await Task.WhenAll(groups.Select(async group =>
                {
                    string sourceVoice = group.Key;
                    string label = IsGenericVoice(sourceVoice)
                        ? await DetectVoiceLabel(movieid, s, sourceVoice, group.First().filepath)
                        : sourceVoice;

                    return (sourceVoice, label);
                }));

                foreach (var item in labels)
                    voiceLabels[item.sourceVoice] = item.label;
            }
        }

        return ContentTpl(cache, () =>
        {
            var firstCatalogItem = cache.Value.First();

            if (firstCatalogItem.season?.order == 0)
            {
                #region Фильм
                var mtpl = new MovieTpl(title, original_title, 1);

                if (firstCatalogItem != null)
                {
                    var episodes = firstCatalogItem.episodeVariants;
                    if (episodes != null)
                    {
                        foreach (var episode in episodes)
                        {
                            string file = episode?.filepath;
                            if (!string.IsNullOrWhiteSpace(file))
                            {
                                string voiceName = DisplayVoice(voiceLabels, episode.title ?? "VeoVeo");
                                string stream = file.Contains(".json")
                                    ? accsArgs($"{host}/lite/veoveo/parsed.m3u8?link={EncryptQuery(file)}")
                                    : HostStreamProxy(file);

                                mtpl.Append(
                                    voiceName,
                                    stream,
                                    voice_name: voiceName,
                                    vast: init.vast
                                );
                            }
                        }
                    }
                }

                return mtpl;
                #endregion
            }
            else
            {
                #region Сериал
                if (s == -1)
                {
                    var tpl = new SeasonTpl();
                    var hash = new HashSet<int>();
                    string enc_title = HttpUtility.UrlEncode(title);
                    string enc_original_title = HttpUtility.UrlEncode(original_title);

                    foreach (var item in cache.Value)
                    {
                        int season = item.season?.order ?? 0;
                        if (hash.Add(season))
                        {
                            tpl.Append(
                                $"{season} сезон",
                                $"{host}/lite/veoveo?rjson={rjson}&movieid={movieid}&kinopoisk_id={kinopoisk_id}&imdb_id={imdb_id}&title={enc_title}&original_title={enc_original_title}&s={season}",
                                season
                            );
                        }
                    }

                    return tpl;
                }
                else
                {
                    var seasonEpisodes = cache.Value
                        .Where(i => (i.season?.order ?? 0) == s)
                        .OrderBy(i => i.order)
                        .ToList();

                    var voiceNames = seasonEpisodes
                        .SelectMany(i => i.episodeVariants ?? Enumerable.Empty<EpisodeVariant>())
                        .Where(i => !string.IsNullOrWhiteSpace(i.title) && !string.IsNullOrWhiteSpace(i.filepath))
                        .GroupBy(i => i.title, StringComparer.OrdinalIgnoreCase)
                        .Select(i => i.Key)
                        .ToList();

                    if (voiceNames.Any(i => !string.Equals(i, "Default", StringComparison.OrdinalIgnoreCase)))
                        voiceNames = voiceNames.Where(i => !string.Equals(i, "Default", StringComparison.OrdinalIgnoreCase)).ToList();

                    string selectedVoice = voiceNames.FirstOrDefault(i => string.Equals(i, t, StringComparison.OrdinalIgnoreCase))
                        ?? voiceNames.FirstOrDefault();

                    if (string.IsNullOrEmpty(selectedVoice))
                        return default;

                    var vtpl = new VoiceTpl(voiceNames.Count);
                    string enc_title = HttpUtility.UrlEncode(title);
                    string enc_original_title = HttpUtility.UrlEncode(original_title);

                    foreach (string voice in voiceNames)
                    {
                        vtpl.Append(
                            DisplayVoice(voiceLabels, voice),
                            string.Equals(voice, selectedVoice, StringComparison.OrdinalIgnoreCase),
                            $"{host}/lite/veoveo?rjson={rjson}&movieid={movieid}&kinopoisk_id={kinopoisk_id}&imdb_id={imdb_id}&title={enc_title}&original_title={enc_original_title}&s={s}&t={HttpUtility.UrlEncode(voice)}"
                        );
                    }

                    var etpl = new EpisodeTpl(vtpl, seasonEpisodes.Count);

                    foreach (var episode in seasonEpisodes)
                    {
                        string name = episode.title;

                        var variants = episode.episodeVariants;
                        var fileToken = variants?
                            .Where(i => string.Equals(i.title, selectedVoice, StringComparison.OrdinalIgnoreCase))
                            .OrderByDescending(i => (i.filepath ?? "").Contains(".m3u8"))
                            .FirstOrDefault();

                        string file = fileToken?.filepath;
                        if (!string.IsNullOrWhiteSpace(file))
                        {
                            string stream = file.Contains(".json")
                                ? accsArgs($"{host}/lite/veoveo/parsed.m3u8?link={EncryptQuery(file)}")
                                : HostStreamProxy(file);

                            etpl.Append(
                                name ?? $"{episode.order} серия",
                                title ?? original_title,
                                s.ToString(),
                                episode.order.ToString(),
                                stream,
                                voice_name: DisplayVoice(voiceLabels, selectedVoice),
                                vast: init.vast
                            );
                        }
                    }

                    return etpl;
                }
                #endregion
            }
        });
    }

    #region VoiceLabel
    static bool IsGenericVoice(string name)
    {
        return string.Equals(name, "Original", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(name, "\u041e\u0440\u0438\u0433\u0438\u043d\u0430\u043b", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(name, "Default", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(name, "\u041f\u043e \u0443\u043c\u043e\u043b\u0447\u0430\u043d\u0438\u044e", StringComparison.OrdinalIgnoreCase);
    }

    static string DisplayVoice(IReadOnlyDictionary<string, string> labels, string sourceVoice)
    {
        if (!string.IsNullOrWhiteSpace(sourceVoice) && labels.TryGetValue(sourceVoice, out string label))
            return label;

        return sourceVoice;
    }

    async Task<string> ResolveMediaSource(string file)
    {
        if (string.IsNullOrWhiteSpace(file))
            return null;

        if (!file.Contains(".json", StringComparison.OrdinalIgnoreCase))
            return file;

        var parsed = await httpHydra.Get<ParsedResponse>(file);
        return parsed?.sources?.FirstOrDefault()?.link;
    }

    async Task<string> DetectVoiceLabel(long movieid, int season, string sourceVoice, string file)
    {
        string fallback = string.Equals(sourceVoice, "Default", StringComparison.OrdinalIgnoreCase)
            ? "\u041f\u043e \u0443\u043c\u043e\u043b\u0447\u0430\u043d\u0438\u044e"
            : sourceVoice;

        return await InvokeCache($"veoveo:voice:v3:{movieid}:{season}:{sourceVoice}", TimeSpan.FromHours(2), async () =>
        {
            try
            {
                string source = await ResolveMediaSource(file);
                if (string.IsNullOrWhiteSpace(source) || !source.Contains(".m3u8", StringComparison.OrdinalIgnoreCase))
                    return fallback;

                using var response = await manifestClient.GetAsync(source);
                if (!response.IsSuccessStatusCode)
                    return fallback;

                string manifest = await response.Content.ReadAsStringAsync();
                if (string.IsNullOrWhiteSpace(manifest))
                    return fallback;

                var tracks = Regex.Matches(
                        manifest,
                        @"^#EXT-X-MEDIA:(?=[^\r\n]*TYPE=AUDIO)[^\r\n]+$",
                        RegexOptions.Multiline
                    )
                    .Cast<Match>()
                    .Select(m => new
                    {
                        line = m.Value,
                        name = Regex.Match(m.Value, @"(?:^|,)NAME=""([^""]+)""").Groups[1].Value
                    })
                    .Where(i => !string.IsNullOrWhiteSpace(i.name))
                    .GroupBy(i => i.name, StringComparer.OrdinalIgnoreCase)
                    .Select(i => i.First())
                    .ToList();

                var selected = tracks.FirstOrDefault(i => i.line.Contains("DEFAULT=YES", StringComparison.OrdinalIgnoreCase))
                    ?? tracks.FirstOrDefault();

                if (selected == null)
                    return fallback;

                string label = HttpUtility.HtmlDecode(selected.name).Trim();
                label = Regex.Replace(label, @"^\s*[0-9]+[.)]\s*", string.Empty);
                label = Regex.Replace(label, @"\s*\((RUS|ENG|UKR|BEL|KAZ)\)\s*$", string.Empty, RegexOptions.IgnoreCase);

                if (string.IsNullOrWhiteSpace(label))
                    return fallback;

                return label;
            }
            catch (Exception ex)
            {
                Serilog.Log.Warning(ex, "VeoVeo voice detection failed MovieId={MovieId} Season={Season}", movieid, season);
                return fallback;
            }
        });
    }
    #endregion

    #region Parsed
    [HttpGet]
    [Route("lite/veoveo/parsed.m3u8")]
    async public Task<ActionResult> Parsed(string link)
    {
        link = DecryptQuery(link);
        if (string.IsNullOrWhiteSpace(link))
            return OnError();

        string m3u8 = await InvokeCache($"veoveo:parsed:{link}", 20, async () =>
        {
            var parsed = await httpHydra.Get<ParsedResponse>(link);
            if (parsed?.sources != null && parsed.sources.Count > 0)
            {
                string m3u8 = parsed.sources.FirstOrDefault()?.link;
                if (!string.IsNullOrEmpty(m3u8))
                    return m3u8;
            }

            return null;
        });

        if (!string.IsNullOrEmpty(m3u8))
            return Redirect(HostStreamProxy(m3u8));

        return OnError();
    }
    #endregion

    #region Spider
    static int SpiderSearchScore(string candidate, string search)
    {
        if (string.IsNullOrEmpty(candidate) || string.IsNullOrEmpty(search))
            return int.MaxValue;

        if (candidate.Equals(search, StringComparison.Ordinal))
            return 0;

        if (candidate.StartsWith(search, StringComparison.Ordinal))
            return 1;

        if (candidate.Contains(search, StringComparison.Ordinal))
            return 2;

        return search.Length >= 6 && IsEditDistanceWithin(candidate, search, 2)
            ? 3
            : int.MaxValue;
    }

    static bool IsEditDistanceWithin(string left, string right, int maxDistance)
    {
        if (Math.Abs(left.Length - right.Length) > maxDistance)
            return false;

        var previous = new int[right.Length + 1];
        var current = new int[right.Length + 1];

        for (int j = 0; j <= right.Length; j++)
            previous[j] = j;

        for (int i = 1; i <= left.Length; i++)
        {
            current[0] = i;
            int rowMin = current[0];

            for (int j = 1; j <= right.Length; j++)
            {
                int cost = left[i - 1] == right[j - 1] ? 0 : 1;
                current[j] = Math.Min(
                    Math.Min(current[j - 1] + 1, previous[j] + 1),
                    previous[j - 1] + cost
                );
                rowMin = Math.Min(rowMin, current[j]);
            }

            if (rowMin > maxDistance)
                return false;

            (previous, current) = (current, previous);
        }

        return previous[right.Length] <= maxDistance;
    }

    [HttpGet, Staticache(manually: true)]
    [Route("lite/veoveo-spider")]
    async public Task<ActionResult> Spider(string title)
    {
        string stitle = SearchNameTo.Convert(title);
        if (stitle == null)
            return OnError();

        string stage = "start";
        int scanned = 0;
        int matches = 0;

        try
        {
            stage = "template";
            var stpl = new SimilarTpl(100);
            stage = "database";
            IEnumerable<Movie> database = ModInit.databaseById?.Values.Distinct()
                ?? ModInit.database
                ?? Enumerable.Empty<Movie>();
            var found = new List<(Movie movie, int score, int titleLength)>();

            stage = "enumerate";
            foreach (var m in database)
            {
                if (m == null)
                    continue;

                scanned++;
                stage = $"normalize:{m.id}";
                string normalizedTitle = SearchNameTo.Convert(m.title);
                string normalizedOriginal = SearchNameTo.Convert(m.originalTitle);
                int titleScore = SpiderSearchScore(normalizedTitle, stitle);
                int originalScore = SpiderSearchScore(normalizedOriginal, stitle);
                int score = Math.Min(titleScore, originalScore);

                if (score != int.MaxValue)
                    found.Add((m, score, normalizedTitle?.Length ?? normalizedOriginal?.Length ?? int.MaxValue));
            }

            stage = "append";
            foreach (var candidate in found
                .OrderBy(i => i.score)
                .ThenBy(i => i.titleLength)
                .ThenByDescending(i => i.movie.year)
                .Take(100))
            {
                var m = candidate.movie;
                stage = $"append:{m.id}";
                stpl.Append(
                    m.title ?? m.originalTitle,
                    m.year.ToString(),
                    string.Empty,
                    $"{host}/lite/veoveo?movieid={m.id}",
                    m.kinopoiskId > 0
                        ? $"https://st.kp.yandex.net/images/film_iphone/iphone360_{m.kinopoiskId}.jpg"
                        : null
                );
                matches++;
            }

            stage = "response";
            return ContentTpl(stpl);
        }
        catch (Exception ex)
        {
            Serilog.Log.Error(ex, "VeoVeo spider failed Title={Title} Normalized={Normalized} Stage={Stage} Scanned={Scanned}", title, stitle, stage, scanned);
            return OnError();
        }
    }
    #endregion


    #region search
    ValueTask<Movie> search(string imdb_id, long kinopoisk_id, string title, string original_title)
    {
        if (!string.IsNullOrEmpty(init.token) && (!string.IsNullOrEmpty(imdb_id) || kinopoisk_id > 0))
            return searchApi(imdb_id, kinopoisk_id);

        string stitle = SearchNameTo.Convert(title);
        string sorigtitle = SearchNameTo.Convert(original_title);

        if (ModInit.databaseById != null)
        {
            foreach (var key in new[]
            {
                kinopoisk_id > 0 ? kinopoisk_id.ToString() : null,
                imdb_id,
                sorigtitle,
                stitle
            })
            {
                if (!string.IsNullOrEmpty(key) && ModInit.databaseById.TryGetValue(key, out var item))
                    return ValueTask.FromResult(item);
            }

            return default;
        }
        else
        {
            Movie goSearch(bool searchToId)
            {
                if (searchToId && kinopoisk_id == 0 && string.IsNullOrEmpty(imdb_id))
                    return null;

                // уже был поиск в api
                if (searchToId && !string.IsNullOrEmpty(init.token))
                    return null;

                foreach (var item in ModInit.database)
                {
                    if (searchToId)
                    {
                        if (kinopoisk_id > 0)
                        {
                            if (item.kinopoiskId == kinopoisk_id)
                                return item;
                        }

                        if (!string.IsNullOrEmpty(imdb_id))
                        {
                            if (item.imdbId == imdb_id)
                                return item;
                        }
                    }
                    else
                    {
                        if (SearchNameTo.Equals(item.originalTitle, sorigtitle) ||
                            SearchNameTo.Equals(item.title, stitle))
                            return item;
                    }
                }

                return null;
            }

            return ValueTask.FromResult(goSearch(true) ?? goSearch(false));
        }
    }
    #endregion

    #region searchApi
    ValueTask<Movie> searchApi(string imdb_id, long kinopoisk_id)
    {
        return InvokeCache($"veoveo:searchApi:{imdb_id}:{kinopoisk_id}", TimeSpan.FromHours(4), async () =>
        {
            async Task<Movie> MOVIE_ID(string url)
            {
                string MOVIE_ID = null;
                await httpHydra.GetSpan(url, html =>
                {
                    MOVIE_ID = Rx.Match(html, "window.MOVIE_ID=([0-9]+);");
                });

                if (MOVIE_ID != null && int.TryParse(MOVIE_ID, out int _id) && _id > 0)
                    return new Movie() { id = _id };

                return null;
            }

            Movie movie = null;

            if (kinopoisk_id > 0)
                movie = await MOVIE_ID($"{init.host}/balancer-api/iframe?kp={kinopoisk_id}&token={init.token}");

            if (!string.IsNullOrEmpty(imdb_id) && movie == null)
                movie = await MOVIE_ID($"{init.host}/balancer-api/iframe?imdb={imdb_id}&token={init.token}");

            return movie;
        });
    }
    #endregion
}
