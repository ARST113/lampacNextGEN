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
using System.Web;

namespace PidTor;

public sealed class TorrentFileProbe
{
    static readonly SemaphoreSlim capacity = new(2, 2);
    readonly string target;
    readonly HttpClient client;
    readonly ConcurrentDictionary<string, Lazy<Task<FileProbeResponse>>> pending = new();
    readonly ConcurrentDictionary<string, CacheEntry> cache = new();

    public TorrentFileProbe(string target, HttpClient client)
    {
        if (!Uri.TryCreate(target, UriKind.Absolute, out Uri uri)
            || (uri.Scheme != "http" && uri.Scheme != "https")
            || !string.IsNullOrEmpty(uri.UserInfo))
            throw new ArgumentException("Invalid probe target", nameof(target));
        this.target = target.TrimEnd('/');
        this.client = client;
    }

    public async Task<FileProbeResponse> ProbeAsync(string hash, int index, string trackers)
    {
        if (!Regex.IsMatch(hash ?? string.Empty, @"\A(?:[a-fA-F0-9]{40}|[A-Z2-7a-z]{32})\z") || index < 1 || index > short.MaxValue)
            return Failure("invalid_request");
        hash = hash.ToLowerInvariant();
        string key = hash + ":" + index;
        if (cache.TryGetValue(key, out CacheEntry entry) && entry.expires > DateTimeOffset.UtcNow)
            return entry.response;
        var task = pending.GetOrAdd(key, _ => new Lazy<Task<FileProbeResponse>>(() => ProbeCoreAsync(hash, index, trackers)));
        try
        {
            FileProbeResponse response = await task.Value.ConfigureAwait(false);
            if (response.streams.Count > 0)
            {
                cache[key] = new(response, DateTimeOffset.UtcNow.AddHours(6));
                foreach (var old in cache.Where(i => i.Value.expires <= DateTimeOffset.UtcNow)) cache.TryRemove(old.Key, out _);
                if (cache.Count > 256)
                    foreach (var old in cache.OrderBy(i => i.Value.expires).Take(cache.Count - 256)) cache.TryRemove(old.Key, out _);
            }
            return response;
        }
        finally
        {
            ((ICollection<KeyValuePair<string, Lazy<Task<FileProbeResponse>>>>)pending).Remove(new(key, task));
        }
    }

    async Task<FileProbeResponse> ProbeCoreAsync(string hash, int index, string trackers)
    {
        if (!await capacity.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(false))
            return Failure("probe_busy");
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(75));
        string stage = "torrent_get";
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
                hash = addedHash.GetString().ToLowerInvariant();
            }
            try
            {
                stage = "file_stat";
                for (int attempt = 0; attempt < 6 && !HasFileStats(stat); attempt++)
                {
                    stat?.Dispose();
                    stat = await RequestAsync($"/stream?link={hash}&index={index}&stat", null, deadline.Token, 5).ConfigureAwait(false);
                    if (!HasFileStats(stat) && attempt < 5) await Task.Delay(500, deadline.Token).ConfigureAwait(false);
                }
                if (!HasFileStats(stat)) return Failure("torrent_unavailable");
                bool fileExists = stat.RootElement.GetProperty("file_stats").EnumerateArray().Any(file =>
                    file.TryGetProperty("id", out JsonElement id) && id.TryGetInt32(out int number) && number == index
                    && file.TryGetProperty("path", out JsonElement path)
                    && Regex.IsMatch(path.GetString() ?? "", @"\.(mkv|mp4|m4v|avi|ts|m2ts|mov|webm|mpg|mpeg|wmv)$", RegexOptions.IgnoreCase));
                if (!fileExists) return Failure("file_missing");
            }
            finally { stat?.Dispose(); }

            stage = "ffprobe";
            using JsonDocument probe = await ProbeWithKeepAliveAsync(hash, index, deadline.Token).ConfigureAwait(false);
            if (probe == null || probe.RootElement.ValueKind != JsonValueKind.Object || !probe.RootElement.TryGetProperty("streams", out JsonElement streams) || streams.ValueKind != JsonValueKind.Array)
                return Failure("probe_unavailable");
            var result = Newtonsoft.Json.JsonConvert.DeserializeObject<List<FfStream>>(streams.GetRawText()) ?? new();
            if (!result.Any(stream => stream.codec_type == "video" && stream.disposition?.attached_pic != 1))
                return Failure("probe_empty");
            return new FileProbeResponse { streams = result };
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
        var trackers = (query.GetValues("tr") ?? Array.Empty<string>()).Where(IsPublicTracker).Distinct().Take(20).ToArray();
        if (trackers.Length == 0) trackers = new[] { "udp://tracker.opentrackr.org:1337/announce", "udp://open.stealth.si:80/announce" };
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
    sealed record CacheEntry(FileProbeResponse response, DateTimeOffset expires);
}

public sealed class FileProbeResponse
{
    public List<FfStream> streams { get; set; } = new();
    public string error { get; set; }
}
