using Shared.Models.Online.Settings;
using Shared.Services;
using Shared.Services.Utilities;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web;

namespace PidTor;

public static class PidTorPlayerSearch
{
    public static async Task<PidTorPlayerResponse> SearchAsync(
        PidTorSettings settings,
        AnimeResolveRequest request,
        AnimeResolveResult resolved,
        string publicHost)
    {
        bool isAnime = AnimeTitleResolver.IsAnime(request);
        AnimeSeasonMatch selectedSeason = resolved?.seasons?.FirstOrDefault(i => i.season == resolved.selected_season);
        int searchYear = selectedSeason?.year ?? request.year;
        int torrentSeason = selectedSeason != null
            ? (selectedSeason.torrent_season > 0 ? selectedSeason.torrent_season : 1)
            : request.season;
        var searchTitles = isAnime ? AnimeTitleResolver.SearchTitles(request, resolved) : (request.title, request.original_title);
        string uri = $"{settings.redapi}/api/v2.0/indexers/all/results?title={HttpUtility.UrlEncode(searchTitles.Item1)}&title_original={HttpUtility.UrlEncode(searchTitles.Item2)}&year={searchYear}&is_serial={(isAnime ? 5 : (request.serial ? 2 : 1))}&apikey={settings.apikey}";

        if (resolved?.aliases != null)
        {
            foreach (string alias in resolved.aliases.Take(20))
                uri += $"&title_alias%5B%5D={HttpUtility.UrlEncode(alias)}";
        }

        var root = await Http.Get<RootObject>(uri, timeoutSeconds: 12, textJson: true).ConfigureAwait(false);
        var response = new PidTorPlayerResponse
        {
            title = request.title,
            season = request.season,
            episode = request.episode,
            gst = false,
            resolver = resolved?.provider,
            resolver_id = resolved?.id ?? 0,
            seasons = resolved?.seasons?
                .Where(i => i.season > 0 && (i.episodes > 0 || i.year > 0))
                .OrderBy(i => i.season)
                .Select(i => new PidTorPlayerSeason
                {
                    season = i.season,
                    year = i.year,
                    episodes = i.episodes
                })
                .ToList() ?? new List<PidTorPlayerSeason>()
        };

        if (root?.Results == null)
            return response;

        int minSeeders = isAnime ? ModInit.anime_min_sid : settings.min_sid;
        var allCandidates = root.Results
            .Where(i => i != null && !string.IsNullOrWhiteSpace(i.MagnetUri))
            .Where(i => !string.Equals(i.Tracker, "selezen", StringComparison.OrdinalIgnoreCase))
            .Where(i => !Regex.IsMatch(i.Title ?? string.Empty, @"(?:^|[^\p{L}\p{N}])(?:3d|h?sbs|h?ou|mvc)(?:$|[^\p{L}\p{N}])", RegexOptions.IgnoreCase))
            .Where(i => IsAllowedSize(settings, request.serial, i.Size ?? 0))
            .Select(i => new Candidate(i, InfoHash(i.MagnetUri)))
            .Where(i => !string.IsNullOrWhiteSpace(i.InfoHash))
            .GroupBy(i => i.InfoHash, StringComparer.OrdinalIgnoreCase)
            .Select(i => i.OrderByDescending(x => x.Result.Seeders).First())
            .ToList();

        if (request.serial && request.season > 0)
        {
            allCandidates = allCandidates.Where(i => IsSeasonCandidate(i.Result, torrentSeason, isAnime, resolved?.aliases, request)
                || (!isAnime && StoryTorrentSeason(i.Result, request) > 0)).ToList();
        }

        // A well-seeded release must not hide a live, distinct voice release.
        var candidates = allCandidates.Where(i => i.Result.Seeders >= minSeeders || i.Result.Seeders > 0).ToList();

        var selectedGroups = candidates
            // Different releases are not interchangeable audio-track layouts.
            .GroupBy(i => i.InfoHash, StringComparer.OrdinalIgnoreCase)
            .Select(group => new TechnicalGroup(
                group.Key,
                group.ToList(),
                group.OrderByDescending(i => VariantScore(i.Result)).First()
            ))
            .OrderByDescending(i => QualityRank(i.best.Result))
            .ThenByDescending(i => i.candidates.Any(x => x.Result.Seeders >= minSeeders))
            .ThenByDescending(i => VariantScore(i.best.Result))
            .ThenByDescending(i => i.candidates.Max(x => x.Result.Seeders))
            .ToList();

        foreach (TechnicalGroup group in selectedGroups)
        {
            Candidate best = group.best;
            var variant = BuildVariant(best.Result);
            variant.id = CrypTo.md5(group.key);
            variant.probe_required = !HasPlayableVideo(best.Result.ffprobe);

            foreach (Candidate candidate in group.candidates.OrderByDescending(i => i.Result.Seeders))
            {
                string trackers = TorrentTrackerFallback.FromMagnet(candidate.Result.MagnetUri);
                string query = string.IsNullOrWhiteSpace(trackers) ? string.Empty : trackers + "&";
                int storySeason = !isAnime ? StoryTorrentSeason(candidate.Result, request) : 0;
                int physicalSeason = storySeason > 0 ? storySeason : torrentSeason;
                string displaySeason = storySeason > 0 ? "&display_s=1" : string.Empty;
                variant.replicas.Add(new PidTorReplica
                {
                    infohash = candidate.InfoHash,
                    seeders = candidate.Result.Seeders,
                    size = candidate.Result.Size ?? 0,
                    tracker = candidate.Result.Tracker,
                    trackers = trackers,
                    stream_url = request.serial ? null : $"{publicHost}/lite/pidtor/s{candidate.InfoHash}?{query}direct=true",
                    episodes_url = request.serial
                        ? $"{publicHost}/lite/pidtor/serial/{candidate.InfoHash}?{query}rjson=true&nextgen=true&title={HttpUtility.UrlEncode(request.title)}&original_title={HttpUtility.UrlEncode(request.original_title)}&s={physicalSeason}&anime={isAnime}{displaySeason}"
                        : null
                });
            }

            response.variants.Add(variant);
        }

        return response;
    }

    const string BordenStory = "Monster: The Lizzie Borden Story";

    static int StoryTorrentSeason(Result result, AnimeResolveRequest request)
    {
        // This named story has a standalone card but anthology-numbered releases.
        if (!request.serial || request.season != 1 || request.year != 2026
            || Normalize(request.original_title) != Normalize(BordenStory)
            || Normalize(result.info?.originalname) != Normalize(BordenStory)
            || !Regex.IsMatch(result.Title ?? string.Empty, @"(?<!\d)2026(?!\d)"))
            return 0;
        var seasons = result.info?.seasons;
        if (seasons?.Length > 1) return 0;
        int physicalSeason = seasons?.Length == 1 ? seasons[0] : ExplicitTorrentSeason(result.Title);
        return physicalSeason == 4 ? 4 : 0;
    }

    public static short EpisodeSeason(short physicalSeason, short displaySeason, string originalTitle)
        => physicalSeason == 4 && displaySeason == 1 && Normalize(originalTitle) == Normalize(BordenStory)
            ? (short)1 : physicalSeason;

    static int VariantScore(Result result)
    {
        var streams = result.ffprobe ?? new List<FfStream>();
        int audioCount = streams.Count(i => string.Equals(i.codec_type, "audio", StringComparison.OrdinalIgnoreCase));
        int subtitleCount = streams.Count(i => string.Equals(i.codec_type, "subtitle", StringComparison.OrdinalIgnoreCase));
        int russianAudio = streams.Count(i =>
            string.Equals(i.codec_type, "audio", StringComparison.OrdinalIgnoreCase)
            && (Regex.IsMatch(i.tags?.language ?? string.Empty, "^(?:rus|ru)$", RegexOptions.IgnoreCase)
                || Regex.IsMatch(i.tags?.title ?? string.Empty, @"рус|дуб|многоголос|одноголос|anilibria|anidub|dream|jisedai|shiza|studio", RegexOptions.IgnoreCase)));

        return (HasPlayableVideo(streams) ? 1_000_000 : 0)
            + russianAudio * 100_000
            + audioCount * 10_000
            + subtitleCount * 1_000
            + Math.Min(Math.Max(result.Seeders, 0), 999);
    }

    static PidTorPlayerVariant BuildVariant(Result result)
    {
        var streams = result.ffprobe ?? new List<FfStream>();
        FfStream video = streams.FirstOrDefault(IsPlayableVideo);
        var audioStreams = streams.Where(i => string.Equals(i.codec_type, "audio", StringComparison.OrdinalIgnoreCase)).ToList();
        string quality = Quality(result);
        var variant = new PidTorPlayerVariant
        {
            release_voice = ReleaseVoice(result.Title),
            video = new PidTorVideoTrack
            {
                stream_index = video?.index ?? -1,
                width = video?.width ?? 0,
                height = video?.height ?? 0,
                quality = quality,
                source = Source(result.Title),
                codec = video?.codec_name ?? CodecFromTitle(result.Title),
                hdr = Hdr(result.Title, video),
                bit_depth = BitDepth(result.Title, video),
                bitrate = ParseLong(video?.bit_rate)
            }
        };

        foreach (FfStream audio in audioStreams)
        {
            variant.audio.Add(new PidTorAudioTrack
            {
                id = $"a{audio.index}",
                stream_index = audio.index,
                language = NormalizeLanguage(audio.tags?.language),
                title = audioStreams.Count == 1 && NormalizeLanguage(audio.tags?.language) == "und"
                    && string.IsNullOrWhiteSpace(audio.tags?.title)
                    && (string.IsNullOrWhiteSpace(audio.tags?.handler_name)
                        || string.Equals(audio.tags.handler_name.Trim(), "SoundHandler", StringComparison.OrdinalIgnoreCase))
                    && !string.IsNullOrWhiteSpace(variant.release_voice)
                        ? variant.release_voice : TrackTitle(audio.tags, audio.tags?.language),
                codec = audio.codec_name,
                channels = audio.channels ?? 0,
                bitrate = ParseLong(audio.bit_rate),
                @default = audio.disposition?.@default == 1
            });
        }

        foreach (FfStream subtitle in streams.Where(i => string.Equals(i.codec_type, "subtitle", StringComparison.OrdinalIgnoreCase)))
        {
            variant.subtitles.Add(new PidTorSubtitleTrack
            {
                id = $"s{subtitle.index}",
                stream_index = subtitle.index,
                language = NormalizeLanguage(subtitle.tags?.language),
                title = TrackTitle(subtitle.tags, subtitle.tags?.language),
                codec = subtitle.codec_name,
                forced = subtitle.disposition?.forced == 1
            });
        }

        return variant;
    }

    static bool IsAllowedSize(PidTorSettings settings, bool serial, long size)
    {
        if (serial && settings.max_serial_size > 0)
            return size <= settings.max_serial_size;
        return settings.max_size <= 0 || size <= settings.max_size;
    }

    static bool IsSeasonCandidate(Result result, int season, bool isAnime, IEnumerable<string> aliases, AnimeResolveRequest request)
    {
        var seasons = result.info?.seasons;
        if (seasons?.Length > 0)
            return seasons.Contains((short)season);

        int explicitSeason = ExplicitTorrentSeason(result.Title);
        if (explicitSeason > 0)
            return explicitSeason == season;

        if (!isAnime)
        {
            if (season != 1 || request.year <= 0)
                return false;

            string name = Normalize(result.info?.name);
            string original = Normalize(result.info?.originalname);
            string title = Normalize(request.title);
            string originalTitle = Normalize(request.original_title);
            bool sameTitle = (!string.IsNullOrEmpty(title) && (name == title || original == title))
                || (!string.IsNullOrEmpty(originalTitle) && (name == originalTitle || original == originalTitle));
            return sameTitle && Regex.IsMatch(result.Title ?? string.Empty,
                $@"(?<!\d){request.year}(?!\d)");
        }

        if (season <= 1)
            return true;

        return MatchesSpecificAlias(result.Title, aliases, request);
    }

    static int ExplicitTorrentSeason(string title)
    {
        if (string.IsNullOrWhiteSpace(title))
            return 0;

        string[] patterns =
        {
            @"(?:season|сезон|tv|тв)[\s._:-]*(?<n>[1-9]\d?)",
            @"(?<n>[1-9]\d?)(?:st|nd|rd|th)[\s._-]*season",
            @"(?<n>[1-9]\d?)[\s._-]*(?:сезон|season)",
            @"(?:^|[^\p{L}\p{N}])s0?(?<n>[1-9]\d?)(?:e0?\d+|\b)",
            @"(?:^|[^\p{L}\p{N}])0?(?<n>[1-9]\d?)[xх]0?\d+"
        };

        foreach (string pattern in patterns)
        {
            Match match = Regex.Match(title, pattern, RegexOptions.IgnoreCase);
            if (match.Success && int.TryParse(match.Groups["n"].Value, out int parsedSeason))
                return parsedSeason;
        }

        return 0;
    }

    static bool MatchesSpecificAlias(string title, IEnumerable<string> aliases, AnimeResolveRequest request)
    {
        if (aliases == null || string.IsNullOrWhiteSpace(title))
            return false;

        string normalizedTitle = Normalize(title);
        string baseTitle = Normalize(request?.title);
        string baseOriginal = Normalize(request?.original_title);
        return aliases.Any(i =>
        {
            string alias = Normalize(i);
            if (alias.Length < 4 || alias == baseTitle || alias == baseOriginal)
                return false;
            return normalizedTitle.Contains(alias, StringComparison.Ordinal);
        });
    }

    static bool MatchesAlias(string title, IEnumerable<string> aliases)
    {
        if (aliases == null || string.IsNullOrWhiteSpace(title))
            return false;
        string normalizedTitle = Normalize(title);
        return aliases.Any(i =>
        {
            string alias = Normalize(i);
            return alias.Length >= 4 && normalizedTitle.Contains(alias, StringComparison.Ordinal);
        });
    }

    static string TechnicalKey(Candidate candidate)
    {
        Result result = candidate.Result;
        FfStream video = result.ffprobe?.FirstOrDefault(IsPlayableVideo);
        if (video == null)
            return $"estimated:{Quality(result)}:{Source(result.Title)}:{CodecFromTitle(result.Title)}:{Hdr(result.Title, null)}:{BitDepth(result.Title, null)}";

        string audio = string.Join(',', result.ffprobe
            .Where(i => i.codec_type == "audio")
            .Select(i => $"{i.codec_name}:{NormalizeLanguage(i.tags?.language)}:{Normalize(i.tags?.title)}:{i.channels}")
            .OrderBy(i => i, StringComparer.Ordinal));
        long sizeBucket = (result.Size ?? 0) / (50L * 1024 * 1024);
        return $"{video?.width}x{video?.height}:{Source(result.Title)}:{video?.codec_name}:{Hdr(result.Title, video)}:{BitDepth(result.Title, video)}:{audio}:{sizeBucket}";
    }

    static int QualityRank(Result result)
    {
        string quality = Quality(result);
        return int.TryParse(quality.Replace("p", string.Empty), out int value) ? value : 0;
    }

    static string Quality(Result result)
    {
        int width = result.ffprobe?.Where(IsPlayableVideo).Select(i => i.width ?? 0).DefaultIfEmpty().Max() ?? 0;
        int height = result.ffprobe?.Where(IsPlayableVideo).Select(i => i.height ?? 0).DefaultIfEmpty().Max() ?? 0;
        if (height <= 0) height = result.info?.quality ?? 0;
        if (width >= 3000 || height >= 1800) return "2160p";
        if (width >= 2400 || height >= 1300) return "1440p";
        if (width >= 1700 || height >= 900) return "1080p";
        if (width >= 1200 || height >= 650) return "720p";
        if (height >= 540) return "576p";
        if (height >= 440) return "480p";
        Match match = Regex.Match(result.Title ?? string.Empty, @"(?<!\d)(2160|1440|1080|720|576|480)p(?!\d)", RegexOptions.IgnoreCase);
        if (match.Success) return match.Groups[1].Value + "p";
        return Regex.IsMatch(result.Title ?? string.Empty, @"(?:4k|uhd)", RegexOptions.IgnoreCase) ? "2160p" : "SD";
    }

    static string Hdr(string title, FfStream video)
    {
        string value = title ?? string.Empty;
        if (Regex.IsMatch(value, @"dolby[ ._-]*vision|(?:^|[ ._\-\[])dv(?:[ ._\-\]]|$)", RegexOptions.IgnoreCase)) return "dolby_vision";
        if (Regex.IsMatch(value, @"hdr10\+|hdr10plus", RegexOptions.IgnoreCase)) return "hdr10_plus";
        if (string.Equals(video?.color_transfer, "smpte2084", StringComparison.OrdinalIgnoreCase) || Regex.IsMatch(value, "hdr10", RegexOptions.IgnoreCase)) return "hdr10";
        if (string.Equals(video?.color_transfer, "arib-std-b67", StringComparison.OrdinalIgnoreCase)) return "hlg";
        if (Regex.IsMatch(value, @"(?:^|[ ._\-\[])hdr(?:[ ._\-\]]|$)", RegexOptions.IgnoreCase)) return "hdr10";
        return "sdr";
    }

    static int BitDepth(string title, FfStream video)
    {
        Match match = Regex.Match(video?.pix_fmt ?? string.Empty, @"p(?<depth>10|12)(?:le|be)?$", RegexOptions.IgnoreCase);
        if (!match.Success) match = Regex.Match(title ?? string.Empty, @"(?<depth>10|12)[ ._-]*bit", RegexOptions.IgnoreCase);
        if (match.Success && int.TryParse(match.Groups["depth"].Value, out int value)) return value;
        if (!string.IsNullOrWhiteSpace(video?.pix_fmt)) return 8;
        if (Regex.IsMatch(title ?? string.Empty, @"(?:^|[^0-9])8[ ._-]*bit(?:[^0-9]|$)", RegexOptions.IgnoreCase)) return 8;
        return 0;
    }

    static string Source(string title)
    {
        string value = title ?? string.Empty;
        if (Regex.IsMatch(value, @"(?:bd|blu[ ._-]*ray)[ ._-]*remux|\bremux\b", RegexOptions.IgnoreCase)) return "BD Remux";
        if (Regex.IsMatch(value, @"blu[ ._-]*ray|bd[ ._-]*rip", RegexOptions.IgnoreCase)) return "Blu-ray";
        if (Regex.IsMatch(value, @"web[ ._-]*dl", RegexOptions.IgnoreCase)) return "WEB-DL";
        if (Regex.IsMatch(value, @"web[ ._-]*rip", RegexOptions.IgnoreCase)) return "WEBRip";
        if (Regex.IsMatch(value, @"hdtv", RegexOptions.IgnoreCase)) return "HDTV";
        if (Regex.IsMatch(value, @"dvd[ ._-]*rip", RegexOptions.IgnoreCase)) return "DVD";
        return null;
    }

    static string CodecFromTitle(string title)
    {
        if (Regex.IsMatch(title ?? string.Empty, @"hevc|h[ ._-]*265|x265", RegexOptions.IgnoreCase)) return "hevc";
        if (Regex.IsMatch(title ?? string.Empty, @"av1", RegexOptions.IgnoreCase)) return "av1";
        if (Regex.IsMatch(title ?? string.Empty, @"h[ ._-]*264|x264|avc", RegexOptions.IgnoreCase)) return "h264";
        return null;
    }

    static bool HasPlayableVideo(IEnumerable<FfStream> streams)
        => streams?.Any(IsPlayableVideo) == true;

    static bool IsPlayableVideo(FfStream stream)
    {
        if (stream == null || !string.Equals(stream.codec_type, "video", StringComparison.OrdinalIgnoreCase))
            return false;
        if (stream.disposition?.attached_pic == 1)
            return false;

        return !Regex.IsMatch(stream.codec_name ?? string.Empty, @"^(?:apng|bmp|gif|jpeg|mjpeg|png|tiff|webp)$", RegexOptions.IgnoreCase);
    }

    static string ReleaseVoice(string title)
    {
        // A single named credit can describe one unnamed stream, not a multi-track layout.
        var credits = Regex.Matches(title ?? string.Empty,
            @"(?:^|(?<=/))\s*(?:ПМ|ДБ|ЛМ|ЛД|MVO|DUB|AVO)\s*\((?<voice>[^()/]+)\)\s*(?=/|$)", RegexOptions.IgnoreCase);
        if (credits.Count != 1) return null;
        string voice = credits[0].Groups["voice"].Value.Trim();
        return voice.Length > 0 && voice.Length <= 120 && !Regex.IsMatch(voice, @"[,;+&]") ? voice : null;
    }

    static string TrackTitle(FfTags tags, string fallback)
        => !string.IsNullOrWhiteSpace(tags?.title) ? tags.title.Trim()
            : !string.IsNullOrWhiteSpace(tags?.handler_name) ? tags.handler_name.Trim()
            : NormalizeLanguage(fallback);

    static string NormalizeLanguage(string value)
        => string.IsNullOrWhiteSpace(value) ? "und" : value.Trim().ToLowerInvariant();

    static long ParseLong(string value)
        => long.TryParse(value, out long parsed) ? parsed : 0;

    static string Normalize(string value)
        => Regex.Replace((value ?? string.Empty).ToLowerInvariant(), @"[^\p{L}\p{N}]+", string.Empty);

    static string InfoHash(string magnet)
        => Regex.Match(magnet ?? string.Empty, @"magnet:\?xt=urn:btih:([a-zA-Z0-9]+)", RegexOptions.IgnoreCase).Groups[1].Value.ToLowerInvariant();

    sealed record Candidate(Result Result, string InfoHash);
    sealed record TechnicalGroup(string key, List<Candidate> candidates, Candidate best);
}
