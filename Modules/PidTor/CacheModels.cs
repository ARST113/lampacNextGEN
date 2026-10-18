using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace PidTor;

public readonly record struct TorrentFileKey(string InfoHash, int Index)
{
    public static bool TryCreate(string hash, int index, out TorrentFileKey key)
    {
        key = default;
        if (index < 1 || index > short.MaxValue || string.IsNullOrEmpty(hash)) return false;
        if (Regex.IsMatch(hash, "\\A[a-fA-F0-9]{40}\\z")) hash = hash.ToLowerInvariant();
        else if (Regex.IsMatch(hash, "\\A[A-Z2-7a-z]{32}\\z"))
        {
            const string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
            var bytes = new byte[20];
            int bits = 0, value = 0, position = 0;
            foreach (char c in hash.ToUpperInvariant())
            {
                int digit = alphabet.IndexOf(c);
                if (digit < 0) return false;
                value = (value << 5) | digit;
                bits += 5;
                if (bits >= 8) { bits -= 8; bytes[position++] = (byte)(value >> bits); }
            }
            hash = Convert.ToHexString(bytes).ToLowerInvariant();
        }
        else return false;
        key = new(hash, index);
        return true;
    }
    public override string ToString() => InfoHash + ":" + Index;
}

public sealed class VerifiedFileFacts
{
    public TorrentFileKey Key { get; set; }
    public string Path { get; set; }
    public long? Size { get; set; }
    public string StreamsJson { get; set; }
    public DateTimeOffset ConfirmedAt { get; set; }
    public string Provenance { get; set; } = "file_probe";
}
public sealed class FileProjection
{
    public PidTorVideoTrack Video { get; set; }
    public List<PidTorAudioTrack> Audio { get; set; } = new();
    public List<PidTorSubtitleTrack> Subtitles { get; set; } = new();
    public List<StoredFileTrack> Tracks { get; set; } = new();
    public List<FfStream> Streams { get; set; } = new();
}
public sealed class StoredFileTrack
{
    public string TrackId { get; set; }
    public string Type { get; set; }
    public int StreamIndex { get; set; }
    public string Language { get; set; }
    public string Title { get; set; }
    public string Codec { get; set; }
    public int Channels { get; set; }
    public bool Default { get; set; }
    public bool Forced { get; set; }
    public string LabelSource { get; set; }
}
public sealed class StoredTorrentFile
{
    public VerifiedFileFacts Facts { get; set; }
    public string State { get; set; } = "ready";
    public int NormalizationVersion { get; set; } = FileMetadataProjector.Version;
    public FileProjection Projection { get; set; }
    public FileMetadata Metadata() => new()
    {
        file_key = Facts.Key.ToString(), infohash = Facts.Key.InfoHash, index = Facts.Key.Index,
        path = Facts.Path, size = Facts.Size, streams = Projection.Streams,
        confirmed_at = Facts.ConfirmedAt, normalization_version = NormalizationVersion,
        metadata_state = State, persisted = true
    };
}
public sealed class FileMetadata
{
    public string file_key { get; set; }
    public string infohash { get; set; }
    public int index { get; set; }
    public string path { get; set; }
    public long? size { get; set; }
    public string metadata_state { get; set; } = "missing";
    public List<FfStream> streams { get; set; } = new();
    public DateTimeOffset? confirmed_at { get; set; }
    public int normalization_version { get; set; }
    public bool persisted { get; set; }
}
public sealed class MediaIdentity
{
    public string Kind { get; set; }
    public bool Anime { get; set; }
    public Dictionary<string, string> Ids { get; set; } = new();
    public string UnresolvedKey { get; set; }
}
public readonly record struct MediaContext(long MediaId, int PhysicalSeason, int Season);
public sealed class MediaFileBinding
{
    public long MediaId { get; set; }
    public TorrentFileKey Key { get; set; }
    public int PhysicalSeason { get; set; }
    public int Season { get; set; }
    public int Episode { get; set; }
    public string MappingMethod { get; set; }
    public int MappingVersion { get; set; } = 1;
}
public sealed class DiscoveredTorrentFile
{
    public int Index { get; set; }
    public string Path { get; set; }
    public long? Size { get; set; }
}
public sealed class ProbeAttempt
{
    public string Error { get; set; }
    public DateTimeOffset RetryAfter { get; set; }
}
public readonly record struct CatalogueKey(long MediaId, string ContextKey);
public sealed class CatalogueSearchContext { public CatalogueKey Key { get; set; } }
public sealed class CatalogueRelease
{
    public int PhysicalSeason { get; set; }
    public string Hash { get; set; }
    public Result Result { get; set; }
    public string Trackers { get; set; }
    public DateTimeOffset SeenAt { get; set; }
    public string Availability { get; set; } = "observed";
}
public sealed class CatalogueSnapshot
{
    public CatalogueKey Key { get; set; }
    public List<CatalogueRelease> Releases { get; set; } = new();
    public DateTimeOffset FetchedAt { get; set; }
}
