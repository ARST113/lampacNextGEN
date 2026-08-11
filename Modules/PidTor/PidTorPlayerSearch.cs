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
        int searchYear = resolved?.seasons?.FirstOrDefault(i => i.season == resolved.selected_season)?.year ?? request.year;
        string uri = $"{settings.redapi}/api/v2.0/indexers/all/results?title={HttpUtility.UrlEncode(request.title)}&title_original={HttpUtility.UrlEncode(request.original_title)}&year={searchYear}&is_serial={(isAnime ? 5 : (request.serial ? 2 : 1))}&apikey={settings.apikey}";

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
            resolver = resolved?.provider,
            resolver_id = resolved?.id ?? 0
        };

        if (root?.Results == null)
            return response;

        int minSeeders = isAnime ? ModInit.anime_min_sid : settings.min_sid;
        var candidates = root.Results
            .Where(i => i != null && i.Seeders >= minSeeders && !string.IsNullOrWhiteSpace(i.MagnetUri))
            .Where(i => !string.Equals(i.Tracker, "selezen", StringComparison.OrdinalIgnoreCase))
            .Where(i => IsAllowedSize(settings, request.serial, i.Size ?? 0))
            .Select(i => new Candidate(i, InfoHash(i.MagnetUri)))
            .Where(i => !string.IsNullOrWhiteSpace(i.InfoHash))
            .GroupBy(i => i.InfoHash, StringComparer.OrdinalIgnoreCase)
            .Select(i => i.OrderByDescending(x => x.Result.Seeders).First())
            .ToList();

        if (request.serial && request.season > 0)
        {
            candidates = candidates.Where(i => IsSeasonCandidate(i.Result, request.season, isAnime, resolved?.aliases)).ToList();
        }

        foreach (var group in candidates
            .GroupBy(TechnicalKey)
            .OrderByDescending(i => QualityRank(i.First().Result))
            .ThenByDescending(i => i.Max(x => x.Result.Seeders)))
        {
            Candidate best = group.OrderByDescending(i => i.Result.Seeders).First();
            var variant = BuildVariant(best.Result);
            variant.id = CrypTo.md5(group.Key);
            variant.probe_required = best.Result.ffprobe == null || best.Result.ffprobe.Count == 0;

            foreach (Candidate candidate in group.OrderByDescending(i => i.Result.Seeders))
            {
                string trackers = TrackerArgs(candidate.Result.MagnetUri);
                string query = string.IsNullOrWhiteSpace(trackers) ? string.Empty : trackers + "&";
                variant.replicas.Add(new PidTorReplica
                {
                    infohash = candidate.InfoHash,
                    seeders = candidate.Result.Seeders,
                    size = candidate.Result.Size ?? 0,
                    tracker = candidate.Result.Tracker,
                    trackers = trackers,
                    stream_url = request.serial ? null : $"{publicHost}/lite/pidtor/s{candidate.InfoHash}?{query}",
                    episodes_url = request.serial
                        ? $"{publicHost}/lite/pidtor/serial/{candidate.InfoHash}?{query}rjson=true&title={HttpUtility.UrlEncode(request.title)}&original_title={HttpUtility.UrlEncode(request.original_title)}&s={request.season}&anime={isAnime}"
                        : null
                });
            }

            response.variants.Add(variant);
        }

        return response;
    }

    static PidTorPlayerVariant BuildVariant(Result result)
    {
        var streams = result.ffprobe ?? new List<FfStream>();
        FfStream video = streams.FirstOrDefault(i => string.Equals(i.codec_type, "video", StringComparison.OrdinalIgnoreCase));
        string quality = Quality(result);
        var variant = new PidTorPlayerVariant
        {
            video = new PidTorVideoTrack
            {
                stream_index = video?.index ?? -1,
                width = video?.width ?? 0,
                height = video?.height ?? 0,
                quality = quality,
                codec = video?.codec_name ?? CodecFromTitle(result.Title),
                hdr = Hdr(result.Title, video),
                bit_depth = BitDepth(result.Title, video),
                bitrate = ParseLong(video?.bit_rate)
            }
        };

        foreach (FfStream audio in streams.Where(i => string.Equals(i.codec_type, "audio", StringComparison.OrdinalIgnoreCase)))
        {
            variant.audio.Add(new PidTorAudioTrack
            {
                id = $"a{audio.index}",
                stream_index = audio.index,
                language = NormalizeLanguage(audio.tags?.language),
                title = TrackTitle(audio.tags, audio.tags?.language),
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

    static bool IsSeasonCandidate(Result result, int season, bool isAnime, IEnumerable<string> aliases)
    {
        var seasons = result.info?.seasons;
        if (seasons?.Length > 0)
            return seasons.Contains((short)season) || isAnime && MatchesAlias(result.Title, aliases);
        return isAnime;
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
        if (result.ffprobe == null || result.ffprobe.Count == 0)
            return "unknown:" + candidate.InfoHash;

        FfStream video = result.ffprobe.FirstOrDefault(i => i.codec_type == "video");
        string audio = string.Join(',', result.ffprobe
            .Where(i => i.codec_type == "audio")
            .Select(i => $"{i.codec_name}:{NormalizeLanguage(i.tags?.language)}:{Normalize(i.tags?.title)}:{i.channels}")
            .OrderBy(i => i, StringComparer.Ordinal));
        long sizeBucket = (result.Size ?? 0) / (50L * 1024 * 1024);
        return $"{video?.width}x{video?.height}:{video?.codec_name}:{Hdr(result.Title, video)}:{BitDepth(result.Title, video)}:{audio}:{sizeBucket}";
    }

    static int QualityRank(Result result)
    {
        string quality = Quality(result);
        return int.TryParse(quality.Replace("p", string.Empty), out int value) ? value : 0;
    }

    static string Quality(Result result)
    {
        int height = result.ffprobe?.Where(i => i.codec_type == "video").Select(i => i.height ?? 0).DefaultIfEmpty().Max() ?? 0;
        if (height <= 0) height = result.info?.quality ?? 0;
        if (height >= 2000) return "2160p";
        if (height >= 1300) return "1440p";
        if (height >= 900) return "1080p";
        if (height >= 650) return "720p";
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
        if (Regex.IsMatch(value, "hdr", RegexOptions.IgnoreCase)) return "hdr";
        return "sdr";
    }

    static int BitDepth(string title, FfStream video)
    {
        Match match = Regex.Match(video?.pix_fmt ?? string.Empty, @"p(?<depth>10|12)(?:le|be)?$", RegexOptions.IgnoreCase);
        if (!match.Success) match = Regex.Match(title ?? string.Empty, @"(?<depth>10|12)[ ._-]*bit", RegexOptions.IgnoreCase);
        return match.Success && int.TryParse(match.Groups["depth"].Value, out int value) ? value : 8;
    }

    static string CodecFromTitle(string title)
    {
        if (Regex.IsMatch(title ?? string.Empty, @"hevc|h[ ._-]*265|x265", RegexOptions.IgnoreCase)) return "hevc";
        if (Regex.IsMatch(title ?? string.Empty, @"av1", RegexOptions.IgnoreCase)) return "av1";
        if (Regex.IsMatch(title ?? string.Empty, @"h[ ._-]*264|x264|avc", RegexOptions.IgnoreCase)) return "h264";
        return null;
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

    static string TrackerArgs(string magnet)
    {
        var result = new List<string>();
        Match match = Regex.Match(magnet ?? string.Empty, @"(?:&|\?)tr=([^&?]+)", RegexOptions.IgnoreCase);
        while (match.Success)
        {
            string tracker = match.Groups[1].Value.Trim();
            if (!string.IsNullOrWhiteSpace(tracker))
                result.Add("tr=" + (tracker.Contains('/') || tracker.Contains(':') ? HttpUtility.UrlEncode(tracker) : tracker));
            match = match.NextMatch();
        }
        return string.Join('&', result.Distinct(StringComparer.OrdinalIgnoreCase));
    }

    sealed record Candidate(Result Result, string InfoHash);
}
