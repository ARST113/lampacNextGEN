using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web;

namespace PidTor;

public sealed class TorrentFileProbe
{
    static readonly SemaphoreSlim capacity = new(2, 2);
    readonly string target;
    readonly HttpClient client;
    static readonly ConcurrentDictionary<string, Lazy<Task<FileProbeResponse>>> pending = new();
    readonly PidTorCacheStore store;
    readonly TimeProvider clock;
    readonly Func<string, int, string, CancellationToken, Task<JsonDocument>> localProbe;

    public TorrentFileProbe(string target, HttpClient client)
        : this(target, client, ModInit.Cache, TimeProvider.System, new LocalMatroskaProbe(target).ProbeAsync) { }

    public TorrentFileProbe(string target, HttpClient client, PidTorCacheStore store, TimeProvider clock,
        Func<string, int, string, CancellationToken, Task<JsonDocument>> localProbe = null)
    {
        if (!Uri.TryCreate(target, UriKind.Absolute, out Uri uri)
            || (uri.Scheme != "http" && uri.Scheme != "https")
            || !string.IsNullOrEmpty(uri.UserInfo))
            throw new ArgumentException("Invalid probe target", nameof(target));
        this.target = target.TrimEnd('/');
        this.client = client;
        this.store = store;
        this.clock = clock ?? TimeProvider.System;
        this.localProbe = localProbe;
    }

    public async Task<FileProbeResponse> ProbeAsync(string hash, int index, string trackers)
    {
        if (!TorrentFileKey.TryCreate(hash, index, out var fileKey))
            return Failure("invalid_request");
        try
        {
            var files = await store.ReadFilesAsync(new[] { fileKey });
            if (files.TryGetValue(fileKey, out var saved)) return FromStored(saved);
            var attempt = await store.ReadProbeAttemptAsync(fileKey);
            if (attempt != null && attempt.RetryAfter > clock.GetUtcNow()) return Failure(attempt.Error);
        }
        catch (Exception error) when (CacheFailure(error)) { CacheDiagnostic("read", error); }
        string key = store.DatabasePath + "|" + fileKey;
        var task = pending.GetOrAdd(key, _ => new Lazy<Task<FileProbeResponse>>(() => ProbeAndSave(fileKey, trackers)));
        try
        {
            return await task.Value.ConfigureAwait(false);
        }
        finally
        {
            ((ICollection<KeyValuePair<string, Lazy<Task<FileProbeResponse>>>>)pending).Remove(new(key, task));
        }
    }

    async Task<FileProbeResponse> ProbeAndSave(TorrentFileKey key, string trackers)
    {
        // Another request may have committed between the initial read and flight creation.
        try
        {
            var saved = await store.ReadFilesAsync(new[] { key }); if (saved.TryGetValue(key, out var file)) return FromStored(file);
            var attempt = await store.ReadProbeAttemptAsync(key);
            if (attempt != null && attempt.RetryAfter > clock.GetUtcNow()) return Failure(attempt.Error);
        }
        catch (Exception error) when (CacheFailure(error)) { CacheDiagnostic("read", error); }
        var result = await ProbeCoreAsync(key.InfoHash, key.Index, trackers);
        if (!string.IsNullOrEmpty(result.error))
        {
            try { await store.SaveProbeFailureAsync(key, result.error, clock.GetUtcNow().AddSeconds(30)); }
            catch (Exception error) when (CacheFailure(error)) { CacheDiagnostic("failure", error); }
        }
        return result;
    }
    public static FileProbeResponse FromStored(StoredTorrentFile file) => new() { streams = file.Projection.Streams, file_metadata = file.Metadata() };
    static bool CacheFailure(Exception error) => error is Microsoft.Data.Sqlite.SqliteException or System.IO.IOException or UnauthorizedAccessException;
    static void CacheDiagnostic(string stage, Exception error) => Console.WriteLine("PidTor file cache " + stage + " failed: " + error.GetType().Name);

    async Task<FileProbeResponse> ProbeCoreAsync(string hash, int index, string trackers)
    {
        if (!await capacity.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(false))
            return Failure("probe_busy");
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(75));
        string stage = "torrent_get";
        string filePath = null;
        long? fileSize = null;
        try
        {
            JsonDocument stat = await RequestAsync("/torrents", new { action = "get", hash }, deadline.Token, 6).ConfigureAwait(false);
            if (stat == null)
            {
                stage = "torrent_add";
                string magnet = "magnet:?xt=urn:btih:" + hash + "&" + TrackerQuery(trackers);
                using JsonDocument added = await RequestAsync("/torrents", new { action = "add", link = magnet, title = "", poster = "", save_to_db = false }, deadline.Token, 10).ConfigureAwait(false);
                if (added == null || added.RootElement.ValueKind != JsonValueKind.Object || !added.RootElement.TryGetProperty("hash", out JsonElement addedHash)
                    || !Regex.IsMatch(addedHash.GetString() ?? "", @"\A[a-fA-F0-9]{40}\z"))
                    return Failure("torrent_unavailable");
                if (!TorrentFileKey.TryCreate(addedHash.GetString(), index, out var addedKey) || addedKey.InfoHash != hash) return Failure("torrent_identity_mismatch");
            }
            try
            {
                stage = "file_stat";
                for (int attempt = 0; attempt < 6 && !HasFileStats(stat); attempt++)
                {
                    stat?.Dispose();
                    stat = null;
                    try { stat = await RequestAsync($"/stream?link={hash}&index={index}&stat", null, deadline.Token, 5).ConfigureAwait(false); }
                    catch (OperationCanceledException) when (!deadline.IsCancellationRequested) { /* Metadata can arrive after one stat request times out. */ }
                    if (!HasFileStats(stat) && attempt < 5) await Task.Delay(500, deadline.Token).ConfigureAwait(false);
                }
                if (!HasFileStats(stat)) return Failure("torrent_unavailable");
                foreach (var file in stat.RootElement.GetProperty("file_stats").EnumerateArray())
                    if (file.TryGetProperty("id", out var id) && id.TryGetInt32(out int number) && number == index && file.TryGetProperty("path", out var path))
                    {
                        filePath = path.GetString();
                        if ((file.TryGetProperty("size", out var size) || file.TryGetProperty("length", out size)) && size.TryGetInt64(out long length)) fileSize = length;
                        break;
                    }
                if (!Regex.IsMatch(filePath ?? "", @"\.(mkv|mp4|m4v|avi|ts|m2ts|mov|webm|mpg|mpeg|wmv)$", RegexOptions.IgnoreCase)) return Failure("file_missing");
            }
            finally { stat?.Dispose(); }

            stage = "ffprobe";
            using JsonDocument probe = (localProbe == null ? null : await localProbe(hash, index, filePath, deadline.Token).ConfigureAwait(false))
                ?? await ProbeWithKeepAliveAsync(hash, index, deadline.Token).ConfigureAwait(false);
            if (probe == null || probe.RootElement.ValueKind != JsonValueKind.Object || !probe.RootElement.TryGetProperty("streams", out JsonElement streams) || streams.ValueKind != JsonValueKind.Array)
                return Failure("probe_unavailable");
            TorrentFileKey.TryCreate(hash, index, out var key);
            var facts = new VerifiedFileFacts { Key = key, Path = filePath, Size = fileSize, StreamsJson = streams.GetRawText(), ConfirmedAt = clock.GetUtcNow() };
            FileProjection projection;
            try { projection = FileMetadataProjector.Project(facts); }
            catch (ArgumentException) { return Failure("probe_empty"); }
            var metadata = new StoredTorrentFile { Facts = facts, Projection = projection }.Metadata();
            metadata.persisted = false;
            try { await store.SaveFileSuccessAsync(facts, projection); metadata.persisted = true; }
            catch (Exception error) when (CacheFailure(error)) { CacheDiagnostic("write", error); }
            return new FileProbeResponse { streams = projection.Streams, file_metadata = metadata };
        }
        catch (OperationCanceledException) { return Failure(stage + "_timeout"); }
        catch (HttpRequestException) { return Failure("probe_unavailable"); }
        catch (JsonException) { return Failure(stage + "_json"); }
        catch (Newtonsoft.Json.JsonException) { return Failure(stage + "_json"); }
        finally { capacity.Release(); }
    }

    async Task<JsonDocument> RequestAsync(string path, object body, CancellationToken cancellation, int seconds)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(seconds));
        using var request = new HttpRequestMessage(body == null ? HttpMethod.Get : HttpMethod.Post, target + path);
        if (body != null) request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) return null;
        return await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(timeout.Token), cancellationToken: timeout.Token).ConfigureAwait(false);
    }

    async Task<JsonDocument> ProbeWithKeepAliveAsync(string hash, int index, CancellationToken cancellation)
    {
        var probe = RequestAsync($"/ffp/{hash}/{index}", null, cancellation, 60);
        // A cold ffprobe may outlive TorrServer's idle TTL before its reader opens.
        while (!probe.IsCompleted)
        {
            await Task.WhenAny(probe, Task.Delay(5000, cancellation)).ConfigureAwait(false);
            if (probe.IsCompleted) break;
            try
            {
                using var state = await RequestAsync("/torrents", new { action = "get", hash }, cancellation, 4).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { }
            catch (HttpRequestException) { }
            catch (JsonException) { }
        }
        return await probe.ConfigureAwait(false);
    }

    static bool HasFileStats(JsonDocument stat)
        => stat != null && stat.RootElement.ValueKind == JsonValueKind.Object && stat.RootElement.TryGetProperty("file_stats", out JsonElement files) && files.ValueKind == JsonValueKind.Array && files.GetArrayLength() > 0;

    static string TrackerQuery(string value)
    {
        var query = HttpUtility.ParseQueryString((value ?? string.Empty).Length > 8192 ? string.Empty : value ?? string.Empty);
        var trackers = (query.GetValues("tr") ?? Array.Empty<string>()).Where(IsPublicTracker).Distinct().Take(20).ToList();

        // Фолбэк нужен не только когда tr= нет совсем: каталог часто отдаёт только retracker.local/
        // opentor.net, и тогда TorrServer не находит пиров. Дополняем список рабочими публичными.
        foreach (string tracker in TorrentTrackerFallback.Trackers)
        {
            if (trackers.Count >= 24)
                break;

            if (!trackers.Contains(tracker, StringComparer.OrdinalIgnoreCase))
                trackers.Add(tracker);
        }

        return string.Join('&', trackers.Select(tracker => "tr=" + HttpUtility.UrlEncode(tracker)));
    }

    static bool IsPublicTracker(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out Uri uri) || !new[] { "http", "https", "udp" }.Contains(uri.Scheme)
            || string.IsNullOrEmpty(uri.Host) || !string.IsNullOrEmpty(uri.UserInfo) || uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)) return false;
        if (!IPAddress.TryParse(uri.Host, out IPAddress ip)) return true;
        if (IPAddress.IsLoopback(ip)) return false;
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        byte[] bytes = ip.GetAddressBytes();
        if (bytes.Length == 4) return bytes[0] != 0 && bytes[0] != 10 && bytes[0] != 127 && bytes[0] < 224
            && !(bytes[0] == 169 && bytes[1] == 254) && !(bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) && !(bytes[0] == 192 && bytes[1] == 168);
        return !ip.IsIPv6LinkLocal && !ip.IsIPv6SiteLocal && !ip.Equals(IPAddress.IPv6Any) && (bytes[0] & 0xfe) != 0xfc;
    }

    static FileProbeResponse Failure(string code) => new() { error = code };
}

// TorrServer's generic ffprobe can seek to distant MKV cues before returning
// streams. For a confirmed local MKV, the same analyzer reads the header once.
public sealed class LocalMatroskaProbe
{
    readonly string target;
    readonly string executable;
    readonly TimeSpan timeout;
    readonly bool eligible;

    public LocalMatroskaProbe(string target, string executable = null, TimeSpan? timeout = null)
    {
        eligible = Uri.TryCreate(target, UriKind.Absolute, out Uri uri) && uri.IsLoopback
            && (uri.Scheme == "http" || uri.Scheme == "https") && string.IsNullOrEmpty(uri.UserInfo)
            && string.IsNullOrEmpty(uri.Query) && string.IsNullOrEmpty(uri.Fragment);
        this.target = target?.TrimEnd('/');
        this.executable = executable ?? (File.Exists("/usr/local/bin/ffprobe") ? "/usr/local/bin/ffprobe" : "/usr/bin/ffprobe");
        this.timeout = timeout.HasValue && timeout.Value > TimeSpan.Zero && timeout.Value <= TimeSpan.FromSeconds(15)
            ? timeout.Value : TimeSpan.FromSeconds(15);
    }

    public async Task<JsonDocument> ProbeAsync(string hash, int index, string path, CancellationToken cancellation)
    {
        if (!eligible || !string.Equals(Path.GetExtension(path), ".mkv", StringComparison.OrdinalIgnoreCase)
            || !TorrentFileKey.TryCreate(hash, index, out var key) || !File.Exists(executable)) return null;
        cancellation.ThrowIfCancellationRequested();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(timeout);
        using var process = new Process { StartInfo = new ProcessStartInfo(executable)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        } };
        foreach (string argument in new[] { "-v", "error", "-protocol_whitelist", "http,https,tcp,tls",
            "-seekable", "0", "-analyzeduration", "2000000", "-probesize", "5000000",
            "-show_streams", "-print_format", "json", target + "/stream?link=" + key.InfoHash + "&index=" + key.Index + "&play" })
            process.StartInfo.ArgumentList.Add(argument);
        bool started = false;
        Task[] ownedTasks = Array.Empty<Task>();
        try
        {
            started = process.Start();
            if (!started) return null;
            var output = CaptureAsync(process.StandardOutput.BaseStream, 4 * 1024 * 1024, deadline.Token);
            var errors = CaptureAsync(process.StandardError.BaseStream, 64 * 1024, deadline.Token);
            ownedTasks = new Task[] { output, errors, process.WaitForExitAsync(deadline.Token) };
            var pending = new List<Task>(ownedTasks);
            while (pending.Count > 0)
            {
                var finished = await Task.WhenAny(pending).ConfigureAwait(false);
                await finished.ConfigureAwait(false);
                pending.Remove(finished);
            }
            if (process.ExitCode != 0) return null;
            var document = JsonDocument.Parse(await output.ConfigureAwait(false));
            if (document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("streams", out var streams) && streams.ValueKind == JsonValueKind.Array)
                return document;
            document.Dispose();
            return null;
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { return null; }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or IOException or InvalidDataException or JsonException or UnauthorizedAccessException)
        { return null; }
        finally
        {
            deadline.Cancel();
            if (started)
            {
                try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
                catch (InvalidOperationException) { }
                try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false); }
                catch (TimeoutException) { }
            }
            // Observe both pipe readers before disposing their process/handles.
            if (ownedTasks.Length > 0)
                try { await Task.WhenAll(ownedTasks).WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false); }
                catch (Exception error) when (error is OperationCanceledException or IOException or InvalidDataException or ObjectDisposedException or TimeoutException) { }
        }
    }

    static async Task<byte[]> CaptureAsync(Stream stream, int limit, CancellationToken cancellation)
    {
        using var output = new MemoryStream();
        var buffer = new byte[8192];
        int count;
        while ((count = await stream.ReadAsync(buffer, cancellation).ConfigureAwait(false)) > 0)
        {
            if (output.Length + count > limit) throw new InvalidDataException("Probe output limit exceeded");
            output.Write(buffer, 0, count);
        }
        return output.ToArray();
    }
}

public sealed class FileProbeResponse
{
    public FileMetadata file_metadata { get; set; }
    public List<FfStream> streams { get; set; } = new();
    public string error { get; set; }
}
