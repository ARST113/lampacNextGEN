using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Web;
using Shared.Services.Utilities;

namespace PidTor;

public sealed class PidTorResponseBuilder
{
    readonly PidTorCacheStore store;
    public PidTorResponseBuilder(PidTorCacheStore store) { this.store = store; }
    public string Title { get; set; }
    public string OriginalTitle { get; set; }
    public bool Anime { get; set; }
    public string Trackers { get; set; }
    static bool CacheFailure(Exception error) => error is Microsoft.Data.Sqlite.SqliteException or IOException or UnauthorizedAccessException;
    async Task<IReadOnlyList<MediaFileBinding>> Bindings(MediaContext context, CancellationToken ct)
    {
        try
        {
            var saved = await store.ReadBindingsAsync(context, ct);
            return context.Season <= 0 ? saved : saved.Where(i => i.MappingVersion >= AnimeEpisodeMatcher.MappingVersion).ToArray();
        }
        catch (Exception error) when (CacheFailure(error)) { return Array.Empty<MediaFileBinding>(); }
    }
    async Task<IReadOnlyDictionary<TorrentFileKey, StoredTorrentFile>> Facts(IEnumerable<TorrentFileKey> keys, CancellationToken ct)
    { try { return await store.ReadFilesAsync(keys.Distinct().ToArray(), ct); } catch (Exception error) when (CacheFailure(error)) { return new Dictionary<TorrentFileKey, StoredTorrentFile>(); } }
    static string Direct(string host, TorrentFileKey key, string trackers)
        => host.TrimEnd('/') + "/lite/pidtor/s" + key.InfoHash + "?" + (string.IsNullOrEmpty(trackers) ? "" : trackers + "&") + "tsid=" + key.Index + "&direct=true";

    public async Task<PidTorPlayerResponse> BuildManifestAsync(CatalogueSnapshot snapshot, MediaContext context,
        string host, Func<string, string> accountUrl, CancellationToken ct = default)
    {
        var bindings = await Bindings(context, ct);
        var keys = bindings.Select(i => i.Key).Concat(snapshot.Releases.Select(i => { TorrentFileKey.TryCreate(i.Hash, 1, out var key); return key; })).Where(i => i.Index > 0);
        var facts = await Facts(keys, ct);
        var response = new PidTorPlayerResponse { media_id = context.MediaId, title = Title, season = context.Season, gst = false };
        foreach (var release in snapshot.Releases)
        {
            if (!TorrentFileKey.TryCreate(release.Hash, 1, out var defaultKey) || release.Result == null) continue;
            var variant = PidTorPlayerSearch.BuildVariant(release.Result);
            variant.id = CrypTo.md5(defaultKey.InfoHash); variant.probe_required = true;
            var matching = bindings.Where(i => i.Key.InfoHash == defaultKey.InfoHash && (release.PhysicalSeason <= 0 || i.PhysicalSeason == release.PhysicalSeason)).ToList();
            var replica = new PidTorReplica { infohash = defaultKey.InfoHash, seeders = release.Result.Seeders, size = release.Result.Size ?? 0, tracker = release.Result.Tracker, trackers = release.Trackers };
            if (context.Season <= 0)
            {
                var key = matching.FirstOrDefault(i => i.Episode == 0)?.Key ?? defaultKey;
                replica.stream_url = accountUrl(matching.Any(i => i.Episode == 0) ? Direct(host, key, release.Trackers)
                    : host.TrimEnd('/') + "/lite/pidtor/s" + defaultKey.InfoHash + "?" + (string.IsNullOrEmpty(release.Trackers) ? "" : release.Trackers + "&") + "direct=true");
                if (facts.TryGetValue(key, out var file)) replica.file_metadata = file.Metadata();
            }
            else
            {
                int physical = release.PhysicalSeason > 0 ? release.PhysicalSeason : context.PhysicalSeason > 0 ? context.PhysicalSeason : context.Season;
                replica.episodes_url = accountUrl(host.TrimEnd('/') + "/lite/pidtor/serial/" + defaultKey.InfoHash + "?" + (string.IsNullOrEmpty(release.Trackers) ? "" : release.Trackers + "&") + "rjson=true&nextgen=true&media_id=" + context.MediaId + "&title=" + HttpUtility.UrlEncode(Title) + "&original_title=" + HttpUtility.UrlEncode(OriginalTitle) + "&s=" + physical + "&display_s=" + context.Season + "&anime=" + Anime);
                foreach (var binding in matching.Where(i => i.Episode > 0)) replica.file_bindings.Add(Item(binding, facts, host, release.Trackers, accountUrl));
            }
            variant.replicas.Add(replica); response.variants.Add(variant);
        }
        return response;
    }
    NextgenEpisodeItem Item(MediaFileBinding binding, IReadOnlyDictionary<TorrentFileKey, StoredTorrentFile> facts, string host, string trackers, Func<string, string> accountUrl, string path = null)
    {
        facts.TryGetValue(binding.Key, out var file);
        string name = Path.GetFileName(path ?? file?.Facts.Path) ?? "Серия " + binding.Episode;
        if (string.IsNullOrEmpty(name)) name = "Серия " + binding.Episode;
        return new() { s = binding.Season, e = binding.Episode, physical_season = binding.PhysicalSeason, index = binding.Key.Index,
            file_key = binding.Key.ToString(), name = name, title = (Title ?? name) + " (" + binding.Episode + " серия)",
            url = accountUrl(Direct(host, binding.Key, trackers)), file_metadata = file?.Metadata(), mapping_method = binding.MappingMethod, mapping_version = binding.MappingVersion };
    }
    public async Task<NextgenEpisodeResponse> BuildEpisodesAsync(MediaContext context, string hash,
        IReadOnlyList<MatchedEpisodeFile> matches, string host, Func<string, string> accountUrl, CancellationToken ct = default)
    {
        if (!TorrentFileKey.TryCreate(hash, 1, out var canonical)) throw new ArgumentException("Invalid torrent hash");
        var map = matches.Where(i => i.file != null && i.file.id > 0).Select(i => new MediaFileBinding
        { MediaId = context.MediaId, Key = new(canonical.InfoHash, i.file.id), PhysicalSeason = context.PhysicalSeason, Season = context.Season, Episode = i.episode, MappingMethod = i.mapping_method, MappingVersion = i.mapping_version }).ToList();
        if (map.Count > 0)
        {
            try
            {
                await store.SaveObservedFilesAsync(canonical.InfoHash, matches.Select(i => new DiscoveredTorrentFile { Index = i.file.id, Path = i.file.path, Size = i.file.size }).ToArray(), ct);
                await store.SaveBindingsAsync(context, map, ct);
            }
            catch (Exception error) when (CacheFailure(error)) { }
        }
        var saved = await Bindings(context, ct);
        var sameHash = saved.Where(i => i.Key.InfoHash == canonical.InfoHash).ToList();
        if (map.Count == 0) map = sameHash;
        else map = map.Select(binding => sameHash.FirstOrDefault(old => old.Key == binding.Key && old.MappingMethod == "explicit_filename" && binding.MappingMethod == "inferred_sequential" && old.MappingVersion >= binding.MappingVersion) ?? binding).ToList();
        var facts = await Facts(map.Select(i => i.Key), ct);
        var response = new NextgenEpisodeResponse();
        foreach (var binding in map.OrderBy(i => i.Episode))
            response.data.Add(Item(binding, facts, host, Trackers, accountUrl, matches.FirstOrDefault(i => i.file.id == binding.Key.Index)?.file.path));
        return response;
    }

    public async Task<NextgenEpisodeResponse> TryBuildCachedEpisodesAsync(MediaContext context, string hash,
        string host, Func<string, string> accountUrl, CancellationToken ct = default)
    {
        try
        {
            var files = await store.ReadTorrentFilesAsync(hash, ct);
            if (files == null) return null;
            var matches = AnimeEpisodeMatcher.Match(files.Select(i => new FileStat { id = (short)i.Index, path = i.Path, size = i.Size }), (short)context.PhysicalSeason);
            if (matches.Count == 0) return new NextgenEpisodeResponse();
            var known = await BuildEpisodesAsync(context, hash, Array.Empty<MatchedEpisodeFile>(), host, accountUrl, ct);
            if (known.data.Count == matches.Count && matches.All(match => known.data.Any(item =>
                item.index == match.file.id && item.e == match.episode
                && item.s == context.Season && item.physical_season == context.PhysicalSeason
                && item.mapping_version >= AnimeEpisodeMatcher.MappingVersion)))
                return known;
            return await BuildEpisodesAsync(context, hash, matches, host, accountUrl, ct);
        }
        catch (Exception error) when (CacheFailure(error)) { return null; }
    }
}
