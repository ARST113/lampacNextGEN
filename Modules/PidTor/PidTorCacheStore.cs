using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using Newtonsoft.Json;
using System.Web;

namespace PidTor;

public sealed class PidTorCacheStore
{
    public string DatabasePath { get; }
    readonly TimeProvider clock;
    static readonly ConcurrentDictionary<string, SemaphoreSlim> writers = new();
    readonly SemaphoreSlim writer;
    bool initialized;
    public PidTorCacheStore(string databasePath, TimeProvider clock = null)
    {
        DatabasePath = Path.GetFullPath(databasePath);
        this.clock = clock ?? TimeProvider.System;
        writer = writers.GetOrAdd(DatabasePath, _ => new SemaphoreSlim(1, 1));
    }
    async Task<SqliteConnection> Open(CancellationToken ct)
    {
        if (!initialized)
        {
            await writer.WaitAsync(ct);
            try
            {
                if (!initialized)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(DatabasePath));
                    using var c = Connection(); await c.OpenAsync(ct);
                    await Execute(c, null, "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;", ct);
                    using var tx = c.BeginTransaction();
                    await Execute(c, tx, """
                        CREATE TABLE IF NOT EXISTS media(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, anime INTEGER NOT NULL, unresolved_key TEXT, UNIQUE(kind,unresolved_key));
                        CREATE TABLE IF NOT EXISTS media_ids(kind TEXT NOT NULL, namespace TEXT NOT NULL, value TEXT NOT NULL, media_id INTEGER NOT NULL REFERENCES media(id), PRIMARY KEY(kind,namespace,value));
                        CREATE TABLE IF NOT EXISTS torrent_files(file_key TEXT PRIMARY KEY, infohash TEXT NOT NULL, file_index INTEGER NOT NULL, path TEXT NOT NULL, size INTEGER, streams_json TEXT, confirmed_at TEXT, provenance TEXT, metadata_state TEXT NOT NULL DEFAULT 'missing', normalization_version INTEGER NOT NULL DEFAULT 0, UNIQUE(infohash,file_index));
                        CREATE TABLE IF NOT EXISTS file_tracks(track_id TEXT PRIMARY KEY, file_key TEXT NOT NULL REFERENCES torrent_files(file_key), type TEXT NOT NULL, stream_index INTEGER NOT NULL, language TEXT, title TEXT, codec TEXT, channels INTEGER, is_default INTEGER, forced INTEGER, label_source TEXT, UNIQUE(file_key,type,stream_index));
                        CREATE TABLE IF NOT EXISTS torrent_layouts(infohash TEXT PRIMARY KEY, discovered_at TEXT NOT NULL);
                        CREATE TABLE IF NOT EXISTS media_files(media_id INTEGER NOT NULL REFERENCES media(id), file_key TEXT NOT NULL REFERENCES torrent_files(file_key), physical_season INTEGER NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL, mapping_method TEXT NOT NULL, mapping_version INTEGER NOT NULL, PRIMARY KEY(media_id,physical_season,season,episode,file_key));
                        CREATE TABLE IF NOT EXISTS probe_attempts(file_key TEXT PRIMARY KEY, error TEXT NOT NULL, retry_after TEXT NOT NULL);
                        CREATE TABLE IF NOT EXISTS catalogue_headers(media_id INTEGER NOT NULL REFERENCES media(id), context_key TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY(media_id,context_key));
                        CREATE TABLE IF NOT EXISTS catalogue_releases(media_id INTEGER NOT NULL, context_key TEXT NOT NULL, infohash TEXT NOT NULL, release_json TEXT NOT NULL, seen_at TEXT NOT NULL, availability TEXT NOT NULL, PRIMARY KEY(media_id,context_key,infohash));
                        CREATE INDEX IF NOT EXISTS media_files_context ON media_files(media_id,season,physical_season);
                        CREATE UNIQUE INDEX IF NOT EXISTS media_files_one_episode ON media_files(media_id,physical_season,season,file_key);
                        PRAGMA user_version=1;
                        """, ct);
                    tx.Commit(); initialized = true;
                }
            }
            finally { writer.Release(); }
        }
        var connection = Connection();
        try { await connection.OpenAsync(ct); return connection; }
        catch { connection.Dispose(); throw; }
    }
    SqliteConnection Connection() => new(new SqliteConnectionStringBuilder
    { DataSource = DatabasePath, ForeignKeys = true, DefaultTimeout = 5, Pooling = true }.ToString());
    static SqliteCommand Command(SqliteConnection c, SqliteTransaction tx, string sql, params (string, object)[] values)
    {
        var command = c.CreateCommand(); command.Transaction = tx; command.CommandText = sql;
        foreach (var (name, value) in values) command.Parameters.AddWithValue(name, value ?? DBNull.Value);
        return command;
    }
    static async Task Execute(SqliteConnection c, SqliteTransaction tx, string sql, CancellationToken ct, params (string, object)[] values)
    { using var command = Command(c, tx, sql, values); await command.ExecuteNonQueryAsync(ct); }
    async Task Write(Func<SqliteConnection, SqliteTransaction, Task> action, CancellationToken ct)
    {
        using var c = await Open(ct);
        await writer.WaitAsync(ct);
        try { using var tx = c.BeginTransaction(); await action(c, tx); tx.Commit(); }
        finally { writer.Release(); }
    }
    static string Date(DateTimeOffset value) => value.ToString("O");
    static TorrentFileKey Key(string hash, int index)
    { if (!TorrentFileKey.TryCreate(hash, index, out var key)) throw new ArgumentException("Invalid file key"); return key; }

    public async Task<long> ResolveMediaAsync(MediaIdentity identity, CancellationToken ct = default)
    {
        if (identity == null || (identity.Kind != "movie" && identity.Kind != "tv")) throw new ArgumentException("Invalid media identity");
        var ids = identity.Ids.Where(i => !string.IsNullOrWhiteSpace(i.Key) && !string.IsNullOrWhiteSpace(i.Value))
            .ToDictionary(i => i.Key.Trim().ToLowerInvariant(), i => i.Value.Trim().ToLowerInvariant());
        long id = 0;
        await Write(async (c, tx) =>
        {
            var found = new HashSet<long>();
            foreach (var pair in ids)
            {
                using var cmd = Command(c, tx, "SELECT media_id FROM media_ids WHERE kind=$k AND namespace=$n AND value=$v", ("$k", identity.Kind), ("$n", pair.Key), ("$v", pair.Value));
                var value = await cmd.ExecuteScalarAsync(ct); if (value != null) found.Add(Convert.ToInt64(value));
            }
            if (found.Count > 1) throw new ArgumentException("Conflicting known media identities");
            id = found.FirstOrDefault();
            if (id > 0)
            {
                foreach (var pair in ids)
                {
                    using var cmd = Command(c, tx, "SELECT value FROM media_ids WHERE media_id=$id AND namespace=$n", ("$id", id), ("$n", pair.Key));
                    var value = await cmd.ExecuteScalarAsync(ct);
                    if (value != null && (string)value != pair.Value) throw new ArgumentException("Conflicting media alias");
                }
            }
            if (id == 0 && ids.Count == 0)
            {
                if (string.IsNullOrWhiteSpace(identity.UnresolvedKey)) throw new ArgumentException("Missing media context");
                using var cmd = Command(c, tx, "SELECT id FROM media WHERE kind=$k AND unresolved_key=$u", ("$k", identity.Kind), ("$u", identity.UnresolvedKey));
                var value = await cmd.ExecuteScalarAsync(ct); if (value != null) id = Convert.ToInt64(value);
            }
            if (id == 0)
            {
                using var cmd = Command(c, tx, "INSERT INTO media(kind,anime,unresolved_key) VALUES($k,$a,$u); SELECT last_insert_rowid();", ("$k", identity.Kind), ("$a", identity.Anime), ("$u", ids.Count == 0 ? identity.UnresolvedKey : null));
                id = Convert.ToInt64(await cmd.ExecuteScalarAsync(ct));
            }
            foreach (var pair in ids) await Execute(c, tx, "INSERT OR IGNORE INTO media_ids(kind,namespace,value,media_id) VALUES($k,$n,$v,$id)", ct, ("$k", identity.Kind), ("$n", pair.Key), ("$v", pair.Value), ("$id", id));
        }, ct);
        return id;
    }

    public async Task<IReadOnlyDictionary<TorrentFileKey, StoredTorrentFile>> ReadFilesAsync(IReadOnlyCollection<TorrentFileKey> keys, CancellationToken ct = default)
    {
        var result = new Dictionary<TorrentFileKey, StoredTorrentFile>();
        if (keys.Count == 0) return result;
        using var c = await Open(ct);
        foreach (var chunk in keys.Distinct().Chunk(250))
        {
            var parameters = chunk.Select((key, i) => ("$k" + i, (object)Key(key.InfoHash, key.Index).ToString())).ToArray();
            using var cmd = Command(c, null, "SELECT infohash,file_index,path,size,streams_json,confirmed_at,provenance,normalization_version FROM torrent_files WHERE metadata_state='ready' AND file_key IN (" + string.Join(',', parameters.Select(i => i.Item1)) + ")", parameters);
            using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                try
                {
                if (reader.IsDBNull(4) || reader.IsDBNull(5) || reader.IsDBNull(6)) continue;
                var facts = new VerifiedFileFacts
                {
                    Key = Key(reader.GetString(0), reader.GetInt32(1)), Path = reader.GetString(2),
                    Size = reader.IsDBNull(3) ? null : reader.GetInt64(3), StreamsJson = reader.GetString(4),
                    ConfirmedAt = DateTimeOffset.Parse(reader.GetString(5)), Provenance = reader.GetString(6)
                };
                result[facts.Key] = new() { Facts = facts, Projection = FileMetadataProjector.Project(facts), NormalizationVersion = FileMetadataProjector.Version };
                }
                catch (Exception error) when (error is ArgumentException or JsonException or FormatException or OverflowException or InvalidCastException) { /* Corrupt rows are individual misses. */ }
            }
        }
        return result;
    }
    public Task SaveFileSuccessAsync(VerifiedFileFacts facts, FileProjection projection, CancellationToken ct = default)
    {
        projection = FileMetadataProjector.Project(facts);
        return Write(async (c, tx) =>
        {
            await Execute(c, tx, """
                INSERT INTO torrent_files(file_key,infohash,file_index,path,size,streams_json,confirmed_at,provenance,metadata_state,normalization_version)
                VALUES($key,$h,$i,$p,$s,$j,$t,$v,'ready',$version)
                ON CONFLICT(file_key) DO UPDATE SET path=excluded.path,size=excluded.size,streams_json=excluded.streams_json,confirmed_at=excluded.confirmed_at,provenance=excluded.provenance,metadata_state='ready',normalization_version=excluded.normalization_version;
                DELETE FROM file_tracks WHERE file_key=$key;
                DELETE FROM probe_attempts WHERE file_key=$key;
                """, ct, ("$key", facts.Key.ToString()), ("$h", facts.Key.InfoHash), ("$i", facts.Key.Index), ("$p", facts.Path), ("$s", facts.Size), ("$j", facts.StreamsJson), ("$t", Date(facts.ConfirmedAt)), ("$v", facts.Provenance), ("$version", FileMetadataProjector.Version));
            foreach (var track in projection.Tracks) await Execute(c, tx, "INSERT INTO file_tracks VALUES($id,$key,$type,$i,$l,$t,$c,$ch,$d,$f,$s)", ct,
                ("$id", track.TrackId), ("$key", facts.Key.ToString()), ("$type", track.Type), ("$i", track.StreamIndex), ("$l", track.Language), ("$t", track.Title), ("$c", track.Codec), ("$ch", track.Channels), ("$d", track.Default), ("$f", track.Forced), ("$s", track.LabelSource));
        }, ct);
    }
    public async Task<ProbeAttempt> ReadProbeAttemptAsync(TorrentFileKey key, CancellationToken ct = default)
    {
        using var c = await Open(ct); using var cmd = Command(c, null, "SELECT error,retry_after FROM probe_attempts WHERE file_key=$key", ("$key", Key(key.InfoHash, key.Index).ToString()));
        using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? new() { Error = reader.GetString(0), RetryAfter = DateTimeOffset.Parse(reader.GetString(1)) } : null;
    }
    public Task SaveProbeFailureAsync(TorrentFileKey key, string error, DateTimeOffset retryAfter, CancellationToken ct = default)
        => Write((c, tx) => Execute(c, tx, "INSERT INTO probe_attempts VALUES($key,$e,$r) ON CONFLICT(file_key) DO UPDATE SET error=excluded.error,retry_after=excluded.retry_after", ct, ("$key", Key(key.InfoHash, key.Index).ToString()), ("$e", error), ("$r", Date(retryAfter))), ct);

    public async Task<IReadOnlyList<DiscoveredTorrentFile>> ReadTorrentFilesAsync(string hash, CancellationToken ct = default)
    {
        hash = Key(hash, 1).InfoHash;
        using var c = await Open(ct); using var exists = Command(c, null, "SELECT 1 FROM torrent_layouts WHERE infohash=$h", ("$h", hash));
        if (await exists.ExecuteScalarAsync(ct) == null) return null;
        using var cmd = Command(c, null, "SELECT file_index,path,size FROM torrent_files WHERE infohash=$h ORDER BY file_index", ("$h", hash));
        using var reader = await cmd.ExecuteReaderAsync(ct); var files = new List<DiscoveredTorrentFile>();
        while (await reader.ReadAsync(ct)) files.Add(new() { Index = reader.GetInt32(0), Path = reader.GetString(1), Size = reader.IsDBNull(2) ? null : reader.GetInt64(2) });
        return files;
    }
    public Task SaveTorrentFilesAsync(string hash, IReadOnlyList<DiscoveredTorrentFile> files, CancellationToken ct = default)
        => SaveObservedFiles(hash, files, true, ct);
    public Task SaveObservedFilesAsync(string hash, IReadOnlyList<DiscoveredTorrentFile> files, CancellationToken ct = default)
        => SaveObservedFiles(hash, files, false, ct);
    Task SaveObservedFiles(string hash, IReadOnlyList<DiscoveredTorrentFile> files, bool completeLayout, CancellationToken ct)
    {
        hash = Key(hash, 1).InfoHash;
        return Write(async (c, tx) =>
        {
            foreach (var file in files)
            {
                var key = Key(hash, file.Index);
                await Execute(c, tx, """
                    INSERT INTO torrent_files(file_key,infohash,file_index,path,size) VALUES($key,$h,$i,$p,$s)
                    ON CONFLICT(file_key) DO UPDATE SET
                      metadata_state=CASE WHEN torrent_files.path<>excluded.path OR (torrent_files.size IS NOT NULL AND excluded.size IS NOT NULL AND torrent_files.size<>excluded.size) THEN 'missing' ELSE torrent_files.metadata_state END,
                      path=excluded.path,size=COALESCE(excluded.size,torrent_files.size);
                    """, ct, ("$key", key.ToString()), ("$h", hash), ("$i", file.Index), ("$p", file.Path), ("$s", file.Size));
            }
            if (completeLayout) await Execute(c, tx, "INSERT INTO torrent_layouts VALUES($h,$t) ON CONFLICT(infohash) DO UPDATE SET discovered_at=excluded.discovered_at", ct, ("$h", hash), ("$t", Date(clock.GetUtcNow())));
        }, ct);
    }
    public async Task<IReadOnlyList<MediaFileBinding>> ReadBindingsAsync(MediaContext context, CancellationToken ct = default)
    {
        using var c = await Open(ct); using var cmd = Command(c, null, """
            SELECT f.infohash,f.file_index,b.physical_season,b.season,b.episode,b.mapping_method,b.mapping_version
            FROM media_files b JOIN torrent_files f ON f.file_key=b.file_key
            WHERE b.media_id=$m AND b.season=$s AND ($p=0 OR b.physical_season=$p) ORDER BY b.episode,f.file_index
            """, ("$m", context.MediaId), ("$s", context.Season), ("$p", context.PhysicalSeason));
        using var reader = await cmd.ExecuteReaderAsync(ct); var result = new List<MediaFileBinding>();
        while (await reader.ReadAsync(ct)) result.Add(new() { MediaId = context.MediaId, Key = Key(reader.GetString(0), reader.GetInt32(1)), PhysicalSeason = reader.GetInt32(2), Season = reader.GetInt32(3), Episode = reader.GetInt32(4), MappingMethod = reader.GetString(5), MappingVersion = reader.GetInt32(6) });
        return result;
    }
    public Task SaveBindingsAsync(MediaContext context, IReadOnlyList<MediaFileBinding> bindings, CancellationToken ct = default)
        => Write(async (c, tx) =>
        {
            foreach (var binding in bindings)
            {
                if (binding.MediaId != 0 && binding.MediaId != context.MediaId) throw new ArgumentException("Foreign media binding");
                if (binding.Season != context.Season || (context.PhysicalSeason != 0 && binding.PhysicalSeason != context.PhysicalSeason)) throw new ArgumentException("Foreign season binding");
                var key = Key(binding.Key.InfoHash, binding.Key.Index);
                await Execute(c, tx, "INSERT OR IGNORE INTO torrent_files(file_key,infohash,file_index,path) VALUES($key,$h,$i,'')", ct, ("$key", key.ToString()), ("$h", key.InfoHash), ("$i", key.Index));
                using var previous = Command(c, tx, "SELECT mapping_method FROM media_files WHERE media_id=$m AND physical_season=$p AND season=$s AND file_key=$key AND mapping_version >= $v", ("$m", context.MediaId), ("$p", binding.PhysicalSeason), ("$s", binding.Season), ("$key", key.ToString()), ("$v", binding.MappingVersion));
                if ((string)await previous.ExecuteScalarAsync(ct) == "explicit_filename" && binding.MappingMethod == "inferred_sequential") continue;
                await Execute(c, tx, "DELETE FROM media_files WHERE media_id=$m AND physical_season=$p AND season=$s AND file_key=$key", ct, ("$m", context.MediaId), ("$p", binding.PhysicalSeason), ("$s", binding.Season), ("$key", key.ToString()));
                await Execute(c, tx, "INSERT INTO media_files VALUES($m,$key,$p,$s,$e,$method,$v) ON CONFLICT(media_id,physical_season,season,episode,file_key) DO UPDATE SET mapping_method=excluded.mapping_method,mapping_version=excluded.mapping_version", ct,
                    ("$m", context.MediaId), ("$key", Key(binding.Key.InfoHash, binding.Key.Index).ToString()), ("$p", binding.PhysicalSeason), ("$s", binding.Season), ("$e", binding.Episode), ("$method", binding.MappingMethod), ("$v", binding.MappingVersion));
            }
        }, ct);

    public async Task<CatalogueSnapshot> ReadCatalogueAsync(CatalogueKey key, CancellationToken ct = default)
    {
        using var c = await Open(ct); using var header = Command(c, null, "SELECT fetched_at FROM catalogue_headers WHERE media_id=$m AND context_key=$c", ("$m", key.MediaId), ("$c", key.ContextKey));
        var fetched = await header.ExecuteScalarAsync(ct); if (fetched == null) return null;
        var result = new CatalogueSnapshot { Key = key, FetchedAt = DateTimeOffset.Parse((string)fetched) };
        using var cmd = Command(c, null, "SELECT release_json,seen_at,availability FROM catalogue_releases WHERE media_id=$m AND context_key=$c", ("$m", key.MediaId), ("$c", key.ContextKey));
        using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            var release = JsonConvert.DeserializeObject<CatalogueRelease>(reader.GetString(0));
            release.SeenAt = DateTimeOffset.Parse(reader.GetString(1)); release.Availability = reader.GetString(2); result.Releases.Add(release);
        }
        return result;
    }
    public Task MergeCatalogueAsync(CatalogueKey key, IReadOnlyList<CatalogueRelease> releases, DateTimeOffset fetchedAt, CancellationToken ct = default)
        => Write(async (c, tx) =>
        {
            await Execute(c, tx, "INSERT INTO catalogue_headers VALUES($m,$c,$t) ON CONFLICT(media_id,context_key) DO UPDATE SET fetched_at=excluded.fetched_at; UPDATE catalogue_releases SET availability='stale' WHERE media_id=$m AND context_key=$c;", ct, ("$m", key.MediaId), ("$c", key.ContextKey), ("$t", Date(fetchedAt)));
            foreach (var item in releases)
            {
                var release = JsonConvert.DeserializeObject<CatalogueRelease>(JsonConvert.SerializeObject(item));
                release.Hash = Key(release.Hash, 1).InfoHash;
                if (release.Result != null) release.Result.MagnetUri = null;
                release.Trackers = PublicTrackers(release.Trackers);
                release.SeenAt = fetchedAt; release.Availability = "observed";
                await Execute(c, tx, "INSERT INTO catalogue_releases VALUES($m,$c,$h,$j,$t,'observed') ON CONFLICT(media_id,context_key,infohash) DO UPDATE SET release_json=excluded.release_json,seen_at=excluded.seen_at,availability='observed'", ct,
                    ("$m", key.MediaId), ("$c", key.ContextKey), ("$h", release.Hash), ("$j", JsonConvert.SerializeObject(release)), ("$t", Date(fetchedAt)));
            }
        }, ct);
    static string PublicTrackers(string query)
    {
        var values = HttpUtility.ParseQueryString((query ?? "").TrimStart('?', '&')).GetValues("tr") ?? Array.Empty<string>();
        return string.Join('&', values.Where(value => Uri.TryCreate(value, UriKind.Absolute, out var uri)
            && new[] { "udp", "http", "https" }.Contains(uri.Scheme) && string.IsNullOrEmpty(uri.UserInfo)
            && new[] { "/", "/announce", "/announce/", "/announce.php" }.Contains(uri.AbsolutePath.ToLowerInvariant()))
            .Select(value => new UriBuilder(value) { Query = "", Fragment = "" }.Uri.AbsoluteUri).Distinct().Take(20).Select(value => "tr=" + HttpUtility.UrlEncode(value)));
    }
}
