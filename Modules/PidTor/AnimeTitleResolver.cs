using Shared.Models.Base;
using Shared.Services;
using Shared.Services.Hybrid;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace PidTor;

public static class AnimeTitleResolver
{
    const string Endpoint = "https://shikimori.io/api/graphql";
    const string UserAgent = "LampacNextGen-PidTor/1.0 (https://github.com/lampac-nextgen/lampac)";
    static readonly TimeSpan MappingTtl = TimeSpan.FromDays(14);
    static readonly TimeSpan NodeTtl = TimeSpan.FromDays(30);
    static readonly TimeSpan FailureTtl = TimeSpan.FromMinutes(5);
    static readonly SemaphoreSlim requestGate = new(1, 1);
    static readonly ConcurrentDictionary<string, Lazy<Task<AnimeResolveResult>>> resolveFlights = new();
    static readonly ConcurrentDictionary<string, Lazy<Task<ShikimoriAnime>>> nodeFlights = new();
    static readonly JsonSerializerOptions jsonOptions = new() { PropertyNameCaseInsensitive = true };
    static DateTime lastRequestUtc;

    const string AnimeFields = "id name russian english japanese synonyms kind episodes airedOn { year month day date } releasedOn { year month day date }";

    public static bool IsAnime(AnimeResolveRequest request)
    {
        if (request == null)
            return false;

        return request.anime
            || string.Equals(request.original_language, "ja", StringComparison.OrdinalIgnoreCase)
            || (!string.IsNullOrWhiteSpace(request.genres)
                && request.genres.Contains("anime", StringComparison.OrdinalIgnoreCase));
    }

    public static async Task<AnimeResolveResult> ResolveAsync(AnimeResolveRequest request)
    {
        if (!IsAnime(request))
            return null;

        string cardKey = CardKey(request);
        string resolveKey = $"anime:resolver:v2:{cardKey}:season:{Math.Max(0, request.season)}:{Math.Max(0, request.season_year)}";
        var cache = HybridCache.Get();

        if (cache.TryGetValue(resolveKey, out AnimeResolveResult cached, textJson: true))
            return cached?.id > 0 ? cached : null;

        var lazy = resolveFlights.GetOrAdd(resolveKey, _ => new Lazy<Task<AnimeResolveResult>>(
            () => ResolveCoreAsync(request, cardKey), LazyThreadSafetyMode.ExecutionAndPublication));

        try
        {
            var result = await lazy.Value.ConfigureAwait(false);
            cache.Set(resolveKey, result ?? new AnimeResolveResult(), result == null ? FailureTtl : MappingTtl, textJson: true);
            return result;
        }
        finally
        {
            resolveFlights.TryRemove(resolveKey, out _);
        }
    }

    static async Task<AnimeResolveResult> ResolveCoreAsync(AnimeResolveRequest request, string cardKey)
    {
        var cache = HybridCache.Get();
        string matchKey = $"anime:resolver:v2:{cardKey}";
        ShikimoriAnime matched = null;
        double matchedScore = 0;

        if (!cache.TryGetValue(matchKey, out AnimeResolveResult cachedMatch, textJson: true) || cachedMatch?.id <= 0)
        {
            (matched, matchedScore) = await SearchBestMatchAsync(request).ConfigureAwait(false);
            if (matched == null)
                return null;

            cache.Set(matchKey, new AnimeResolveResult
            {
                id = ParseId(matched.id),
                matched_score = matchedScore,
                kind = matched.kind,
                year = matched.airedOn?.year ?? 0,
                aliases = Aliases(matched)
            }, MappingTtl, textJson: true);
        }
        else
        {
            matchedScore = cachedMatch.matched_score;
            matched = await GetNodeAsync(cachedMatch.id).ConfigureAwait(false);
            if (matched == null)
                return null;
        }

        var graph = await BuildMainGraphAsync(matched).ConfigureAwait(false);
        var main = graph
            .Where(i => request.serial
                ? string.Equals(i.kind, "tv", StringComparison.OrdinalIgnoreCase)
                : string.Equals(i.kind, "movie", StringComparison.OrdinalIgnoreCase))
            .GroupBy(i => i.id)
            .Select(i => i.First())
            .OrderBy(i => i.airedOn?.date ?? "9999-99-99", StringComparer.Ordinal)
            .ThenBy(i => ParseId(i.id))
            .ToList();

        if (main.Count == 0)
            main.Add(matched);

        var seasons = new List<AnimeSeasonMatch>(main.Count);
        for (int i = 0; i < main.Count; i++)
        {
            seasons.Add(new AnimeSeasonMatch
            {
                season = i + 1,
                shikimori_id = ParseId(main[i].id),
                kind = main[i].kind,
                year = main[i].airedOn?.year ?? 0,
                episodes = main[i].episodes,
                aliases = Aliases(main[i])
            });
        }

        AnimeSeasonMatch selected = SelectSeason(request, seasons, matched);
        List<string> aliases = request.season > 0 && selected != null
            ? selected.aliases
            : seasons.SelectMany(i => i.aliases).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

        return new AnimeResolveResult
        {
            id = selected?.shikimori_id ?? ParseId(matched.id),
            matched_score = matchedScore,
            kind = selected?.kind ?? matched.kind,
            year = selected?.year ?? matched.airedOn?.year ?? 0,
            selected_season = selected?.season ?? 0,
            aliases = aliases,
            seasons = seasons
        };
    }

    public static (string title, string originalTitle) SearchTitles(AnimeResolveRequest request, AnimeResolveResult resolved)
    {
        if (resolved?.aliases == null || resolved.aliases.Count == 0)
            return (request.title, request.original_title);

        string russian = resolved.aliases.FirstOrDefault(i => Regex.IsMatch(i, @"\p{IsCyrillic}"));
        string latin = resolved.aliases.FirstOrDefault(i => Regex.IsMatch(i, @"[A-Za-z]"));
        string fallback = resolved.aliases[0];
        return (russian ?? fallback, latin ?? fallback);
    }

    static async Task<(ShikimoriAnime anime, double score)> SearchBestMatchAsync(AnimeResolveRequest request)
    {
        string search = !string.IsNullOrWhiteSpace(request.original_title) ? request.original_title : request.title;
        if (string.IsNullOrWhiteSpace(search))
            return (null, 0);

        string query = $"query($search: String!) {{ animes(search: $search, limit: 12) {{ {AnimeFields} }} }}";
        var response = await ExecuteAsync(query, new { search }).ConfigureAwait(false);
        var candidates = response?.data?.animes;
        if (candidates == null || candidates.Count == 0)
            return (null, 0);

        var ranked = candidates
            .Select(i => (anime: i, score: CandidateScore(request, i)))
            .OrderByDescending(i => i.score)
            .ToList();

        if (ranked[0].score < 85)
            return (null, 0);

        if (ranked.Count > 1 && ranked[0].score - ranked[1].score < 8 && ranked[0].score < 180)
            return (null, 0);

        return (ranked[0].anime, Math.Round(Math.Min(1, ranked[0].score / 250d), 3));
    }

    static double CandidateScore(AnimeResolveRequest request, ShikimoriAnime anime)
    {
        double score = 0;
        score += BestTitleScore(request.original_title, new[]
        {
            (anime.name, 100d), (anime.japanese, 100d), (anime.english, 90d), (anime.russian, 80d)
        }, anime.synonyms, 85);
        score += BestTitleScore(request.title, new[]
        {
            (anime.russian, 100d), (anime.name, 90d), (anime.english, 90d), (anime.japanese, 70d)
        }, anime.synonyms, 85);

        int animeYear = anime.airedOn?.year ?? 0;
        if (request.year > 0 && animeYear > 0)
        {
            int delta = Math.Abs(request.year - animeYear);
            score += delta == 0 ? 25 : delta == 1 ? 10 : delta > 2 ? -15 : 0;
        }

        if (request.serial)
            score += string.Equals(anime.kind, "tv", StringComparison.OrdinalIgnoreCase) ? 25 : -80;
        else
            score += string.Equals(anime.kind, "movie", StringComparison.OrdinalIgnoreCase) ? 25 : -60;

        return score;
    }

    static double BestTitleScore(string requested, IEnumerable<(string value, double weight)> primary, IEnumerable<string> synonyms, double synonymWeight)
    {
        if (string.IsNullOrWhiteSpace(requested))
            return 0;

        double best = 0;
        foreach (var item in primary)
            best = Math.Max(best, item.weight * Similarity(requested, item.value));

        if (synonyms != null)
        {
            foreach (string synonym in synonyms)
                best = Math.Max(best, synonymWeight * Similarity(requested, synonym));
        }

        return best;
    }

    static async Task<List<ShikimoriAnime>> BuildMainGraphAsync(ShikimoriAnime start)
    {
        var result = new Dictionary<string, ShikimoriAnime>();
        var queue = new Queue<ShikimoriAnime>();
        queue.Enqueue(start);

        while (queue.Count > 0 && result.Count < 24)
        {
            var current = queue.Dequeue();
            if (current == null || string.IsNullOrWhiteSpace(current.id) || result.ContainsKey(current.id))
                continue;

            var full = current.related == null ? await GetNodeAsync(ParseId(current.id)).ConfigureAwait(false) : current;
            if (full == null)
                continue;

            result[full.id] = full;
            foreach (var relation in full.related ?? new List<ShikimoriRelated>())
            {
                if (relation?.anime == null)
                    continue;

                if (relation.relationKind is "prequel" or "sequel")
                    queue.Enqueue(relation.anime);
            }
        }

        return result.Values.ToList();
    }

    static AnimeSeasonMatch SelectSeason(AnimeResolveRequest request, List<AnimeSeasonMatch> seasons, ShikimoriAnime matched)
    {
        if (seasons.Count == 0)
            return null;

        if (request.season > 0)
        {
            var numbered = seasons.FirstOrDefault(i => i.season == request.season);
            if (numbered != null && request.season_year <= 0 && string.IsNullOrWhiteSpace(request.season_title))
                return numbered;
        }

        return seasons
            .Select(i => (season: i, score: SeasonScore(request, i, matched)))
            .OrderByDescending(i => i.score)
            .ThenBy(i => Math.Abs((request.season > 0 ? request.season : 1) - i.season.season))
            .First().season;
    }

    static double SeasonScore(AnimeResolveRequest request, AnimeSeasonMatch season, ShikimoriAnime matched)
    {
        double score = 0;
        if (request.season > 0)
            score += season.season == request.season ? 60 : -10 * Math.Abs(season.season - request.season);
        if (request.season_year > 0 && season.year > 0)
            score += season.year == request.season_year ? 80 : -15 * Math.Min(4, Math.Abs(season.year - request.season_year));
        if (request.season_episodes > 0 && season.episodes > 0)
            score += season.episodes == request.season_episodes ? 20 : 0;
        if (!string.IsNullOrWhiteSpace(request.season_title))
            score += season.aliases.Max(i => Similarity(request.season_title, i)) * 50;
        if (season.shikimori_id == ParseId(matched.id))
            score += 5;
        return score;
    }

    static async Task<ShikimoriAnime> GetNodeAsync(long id)
    {
        if (id <= 0)
            return null;

        string key = $"anime:resolver:shiki:{id}:node";
        var cache = HybridCache.Get();
        if (cache.TryGetValue(key, out ShikimoriAnime cached, textJson: true))
            return cached?.id != null ? cached : null;

        var lazy = nodeFlights.GetOrAdd(key, _ => new Lazy<Task<ShikimoriAnime>>(
            async () =>
            {
                string query = $"query($ids: String!) {{ animes(ids: $ids, limit: 1) {{ {AnimeFields} related {{ relationKind relationText anime {{ {AnimeFields} }} }} }} }}";
                var response = await ExecuteAsync(query, new { ids = id.ToString() }).ConfigureAwait(false);
                return response?.data?.animes?.FirstOrDefault();
            }, LazyThreadSafetyMode.ExecutionAndPublication));

        try
        {
            var node = await lazy.Value.ConfigureAwait(false);
            cache.Set(key, node ?? new ShikimoriAnime(), node == null ? FailureTtl : NodeTtl, textJson: true);
            return node;
        }
        finally
        {
            nodeFlights.TryRemove(key, out _);
        }
    }

    static async Task<ShikimoriGraphResponse> ExecuteAsync(string query, object variables)
    {
        string payload = JsonSerializer.Serialize(new { query, variables }, jsonOptions);
        for (int attempt = 0; attempt < 3; attempt++)
        {
            await requestGate.WaitAsync().ConfigureAwait(false);
            try
            {
                var wait = TimeSpan.FromMilliseconds(400) - (DateTime.UtcNow - lastRequestUtc);
                if (wait > TimeSpan.Zero)
                    await Task.Delay(wait).ConfigureAwait(false);

                using var content = new StringContent(payload, Encoding.UTF8, "application/json");
                var response = await Http.BasePost(
                    Endpoint,
                    content,
                    timeoutSeconds: 10,
                    headers: HeadersModel.Init("User-Agent", UserAgent),
                    statusCodeOK: false
                ).ConfigureAwait(false);
                lastRequestUtc = DateTime.UtcNow;

                int status = (int)(response.response?.StatusCode ?? HttpStatusCode.InternalServerError);
                if (status == 200 && !string.IsNullOrWhiteSpace(response.content))
                {
                    var graph = JsonSerializer.Deserialize<ShikimoriGraphResponse>(response.content, jsonOptions);
                    return graph?.errors?.Count > 0 ? null : graph;
                }

                if (status != 429 && status < 500)
                    return null;
            }
            finally
            {
                requestGate.Release();
            }

            await Task.Delay(TimeSpan.FromMilliseconds(750 * (attempt + 1))).ConfigureAwait(false);
        }

        return null;
    }

    static List<string> Aliases(ShikimoriAnime anime)
    {
        var values = new[] { anime?.name, anime?.russian, anime?.japanese, anime?.english }
            .Concat(anime?.synonyms ?? Enumerable.Empty<string>())
            .Where(i => !string.IsNullOrWhiteSpace(i))
            .Select(i => i.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        return values;
    }

    static double Similarity(string left, string right)
    {
        string a = Normalize(left);
        string b = Normalize(right);
        if (a.Length == 0 || b.Length == 0)
            return 0;
        if (a == b)
            return 1;
        if ((a.Contains(b, StringComparison.Ordinal) || b.Contains(a, StringComparison.Ordinal)) && Math.Min(a.Length, b.Length) >= 5)
            return 0.82;

        int distance = Levenshtein(a, b);
        return Math.Max(0, 1d - (double)distance / Math.Max(a.Length, b.Length));
    }

    static string Normalize(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return string.Empty;

        value = value.Normalize(NormalizationForm.FormKC).ToLowerInvariant();
        return Regex.Replace(value, @"[^\p{L}\p{N}]+", "");
    }

    static int Levenshtein(string a, string b)
    {
        var previous = new int[b.Length + 1];
        var current = new int[b.Length + 1];
        for (int j = 0; j <= b.Length; j++)
            previous[j] = j;

        for (int i = 1; i <= a.Length; i++)
        {
            current[0] = i;
            for (int j = 1; j <= b.Length; j++)
                current[j] = Math.Min(Math.Min(current[j - 1] + 1, previous[j] + 1), previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
            (previous, current) = (current, previous);
        }

        return previous[b.Length];
    }

    static string CardKey(AnimeResolveRequest request)
    {
        long tmdb = request.tmdb_id > 0
            ? request.tmdb_id
            : request.id > 0 && (request.source is "tmdb" or "cub" || string.IsNullOrWhiteSpace(request.source)) ? request.id : 0;
        if (tmdb > 0)
            return $"tmdb:{tmdb}";
        if (request.kinopoisk_id > 0)
            return $"kp:{request.kinopoisk_id}";
        if (!string.IsNullOrWhiteSpace(request.imdb_id))
            return $"imdb:{request.imdb_id.Trim().ToLowerInvariant()}";
        return $"title:{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes($"{request.original_title}|{request.title}|{request.year}|{request.serial}"))).ToLowerInvariant()}";
    }

    static long ParseId(string value) => long.TryParse(value, out long id) ? id : 0;
}
