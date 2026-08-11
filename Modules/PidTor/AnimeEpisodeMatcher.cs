using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace PidTor;

public sealed class MatchedEpisodeFile
{
    public FileStat file { get; init; }
    public short episode { get; init; }
}

public static class AnimeEpisodeMatcher
{
    static readonly HashSet<string> VideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mkv", ".mp4", ".m4v", ".webm", ".avi", ".mov", ".ts", ".m2ts"
    };

    static readonly Regex ExtraPattern = new(
        @"(?:^|[\s._\-\[\]()])(ncop|nced|opening|ending|creditless|preview|trailer|sample|menu|extra(?:s)?|pv|ova|special|sp)(?:[\s._\-\[\]()\d]|$)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly Regex SeasonEpisodePattern = new(
        @"(?:^|[^\p{L}\p{N}])s(?<s>\d{1,2})[\s._-]*e(?<e>\d{1,3})(?:v\d+)?(?:[^\p{L}\p{N}]|$)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly Regex XPattern = new(
        @"(?:^|[^\p{L}\p{N}])(?<s>\d{1,2})x(?<e>\d{1,3})(?:[^\p{L}\p{N}]|$)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly Regex EpisodePattern = new(
        @"(?:^|[^\p{L}\p{N}])(?:episode|ep|e)[\s._-]*(?<e>\d{1,3})(?:v\d+)?(?:[^\p{L}\p{N}]|$)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly Regex FlatPattern = new(
        @"(?:^|[/\\\[\s._-])(?<e>\d{1,3})(?:v\d+)?(?:[\]\s._-]|$)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly Regex NaturalNumberPattern = new(@"\d+", RegexOptions.Compiled);

    public static IReadOnlyList<MatchedEpisodeFile> Match(IEnumerable<FileStat> source, short requestedSeason)
    {
        var files = source?
            .Where(i => i != null && IsVideo(i.path) && !IsExtra(i.path))
            .OrderBy(i => i.path, NaturalPathComparer.Instance)
            .ThenBy(i => i.id)
            .ToList() ?? new List<FileStat>();

        if (requestedSeason > 0)
            files = files.Where(i => !HasExplicitDifferentSeason(i.path, requestedSeason)).ToList();

        var result = new List<MatchedEpisodeFile>(files.Count);
        var unresolved = new List<FileStat>();
        var usedEpisodes = new HashSet<short>();

        foreach (FileStat file in files)
        {
            if (TryEpisode(file.path, requestedSeason, out short episode) && usedEpisodes.Add(episode))
                result.Add(new MatchedEpisodeFile { file = file, episode = episode });
            else
                unresolved.Add(file);
        }

        if (result.Count == 0 && files.Count is > 0 and <= 100)
        {
            for (short i = 0; i < files.Count; i++)
                result.Add(new MatchedEpisodeFile { file = files[i], episode = (short)(i + 1) });
        }
        else if (unresolved.Count > 0 && result.Count > 0)
        {
            short next = 1;
            foreach (FileStat file in unresolved)
            {
                while (usedEpisodes.Contains(next))
                    next++;

                if (next > 100)
                    break;

                usedEpisodes.Add(next);
                result.Add(new MatchedEpisodeFile { file = file, episode = next++ });
            }
        }

        return result.OrderBy(i => i.episode).ThenBy(i => i.file.id).ToList();
    }

    static bool TryEpisode(string path, short requestedSeason, out short episode)
    {
        episode = 0;
        string name = Path.GetFileNameWithoutExtension(path) ?? string.Empty;

        Match match = SeasonEpisodePattern.Match(name);
        if (match.Success)
        {
            if (!short.TryParse(match.Groups["s"].Value, out short season)
                || !short.TryParse(match.Groups["e"].Value, out episode))
                return false;

            return requestedSeason <= 0 || season == requestedSeason;
        }

        match = XPattern.Match(name);
        if (match.Success)
        {
            if (!short.TryParse(match.Groups["s"].Value, out short season)
                || !short.TryParse(match.Groups["e"].Value, out episode))
                return false;

            return requestedSeason <= 0 || season == requestedSeason;
        }

        match = EpisodePattern.Match(name);
        if (!match.Success)
            match = FlatPattern.Match(name);

        return match.Success
            && short.TryParse(match.Groups["e"].Value, out episode)
            && episode is > 0 and <= 100;
    }

    static bool HasExplicitDifferentSeason(string path, short requestedSeason)
    {
        if (requestedSeason <= 0)
            return false;

        string name = Path.GetFileNameWithoutExtension(path) ?? string.Empty;
        Match match = SeasonEpisodePattern.Match(name);
        if (!match.Success)
            match = XPattern.Match(name);

        return match.Success
            && short.TryParse(match.Groups["s"].Value, out short season)
            && season != requestedSeason;
    }

    static bool IsVideo(string path)
        => !string.IsNullOrWhiteSpace(path) && VideoExtensions.Contains(Path.GetExtension(path));

    static bool IsExtra(string path)
        => ExtraPattern.IsMatch(Path.GetFileNameWithoutExtension(path) ?? string.Empty);

    sealed class NaturalPathComparer : IComparer<string>
    {
        public static readonly NaturalPathComparer Instance = new();

        public int Compare(string left, string right)
        {
            left ??= string.Empty;
            right ??= string.Empty;
            var leftParts = NaturalNumberPattern.Split(left);
            var rightParts = NaturalNumberPattern.Split(right);
            var leftNumbers = NaturalNumberPattern.Matches(left);
            var rightNumbers = NaturalNumberPattern.Matches(right);
            int count = Math.Max(leftParts.Length, rightParts.Length);

            for (int i = 0; i < count; i++)
            {
                string lp = i < leftParts.Length ? leftParts[i] : string.Empty;
                string rp = i < rightParts.Length ? rightParts[i] : string.Empty;
                int text = string.Compare(lp, rp, StringComparison.OrdinalIgnoreCase);
                if (text != 0)
                    return text;

                if (i < leftNumbers.Count && i < rightNumbers.Count
                    && long.TryParse(leftNumbers[i].Value, out long ln)
                    && long.TryParse(rightNumbers[i].Value, out long rn)
                    && ln != rn)
                    return ln.CompareTo(rn);
            }

            return string.Compare(left, right, StringComparison.OrdinalIgnoreCase);
        }
    }
}
