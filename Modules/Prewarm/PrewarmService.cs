using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Web;

namespace Prewarm;

/// <summary>
/// Прогрев онлайн-источников: при открытии карточки запрашивает все балансеры,
/// затем заранее тянет ссылки выбора озвучки (call), чтобы переключение озвучки
/// в плеере происходило из кэша самого Lampac, а не ждало внешние сайты.
/// </summary>
public static class PrewarmService
{
    const string BaseUrl = "http://127.0.0.1:8242";
    const string LogPath = "/home/lampac/logs/prewarm.log";
    const int SourceLimit = 14;
    const int CallLimit = 24;
    const int CallsPerVoice = 2;

    const int CacheMaxEntries = 400;
    const int CacheMaxBody = 64 * 1024;
    const long CacheMaxBytes = 24L * 1024 * 1024;
    static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(8);

    static readonly HttpClient http = CreateClient();
    static readonly SemaphoreSlim warms = new(2);
    static readonly SemaphoreSlim parallel = new(4);
    static readonly ConcurrentDictionary<string, DateTime> recent = new();
    static readonly ConcurrentDictionary<string, CacheEntry> responses = new();
    static readonly object logLock = new();
    static long served = 0;
    static long stored = 0;
    static long storedBytes = 0;

    sealed class CacheEntry
    {
        public string Body;
        public string ContentType;
        public DateTime Time;
    }

    static HttpClient CreateClient()
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            MaxConnectionsPerServer = 16
        };

        return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(12) };
    }

    public static void Log(string message)
    {
        try
        {
            lock (logLock)
            {
                var file = new FileInfo(LogPath);
                if (file.Exists && file.Length > 4 * 1024 * 1024) File.Delete(LogPath);
                File.AppendAllText(LogPath, DateTime.Now.ToString("dd.MM HH:mm:ss") + " " + message + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch
        {
        }
    }

    public static void Trigger(string query)
    {
        try
        {
            var qs = HttpUtility.ParseQueryString(query.TrimStart('?'));
            string id = qs["id"] ?? qs["kinopoisk_id"] ?? "";
            string imdb = qs["imdb_id"] ?? "";

            if (string.IsNullOrWhiteSpace(id) && string.IsNullOrWhiteSpace(imdb)) return;

            string key = string.Join("|", id, imdb, qs["serial"] ?? "0", qs["s"] ?? "1");
            var now = DateTime.UtcNow;

            if (recent.TryGetValue(key, out var last) && (now - last).TotalMinutes < 8) return;
            recent[key] = now;

            if (recent.Count > 400)
            {
                foreach (var pair in recent.Where(p => (now - p.Value).TotalMinutes > 60).ToList())
                    recent.TryRemove(pair.Key, out _);
            }

            _ = Task.Run(async () =>
            {
                await warms.WaitAsync();
                try
                {
                    await Warm(query, qs);
                }
                catch (Exception error)
                {
                    Log("error " + key + ": " + error.Message);
                }
                finally
                {
                    warms.Release();
                }
            });
        }
        catch
        {
        }
    }

    static async Task Warm(string query, NameValueCollection qs)
    {
        var started = DateTime.UtcNow;
        string season = qs["s"] ?? "1";
        string uid = qs["uid"] ?? "";
        string queryForSource = SourceQuery(qs, season);

        // 1. Список источников, который Lampac уже собрал для этого запроса.
        // Online-модули после рестарта отвечают не сразу, поэтому цикл с повторами.
        var sources = new List<string>();

        for (int cycle = 0; cycle < 3 && sources.Count == 0; cycle++)
        {
            if (cycle > 0) await Task.Delay(1500);

            string memkey = ExtractMemkey(await Get(BaseUrl + "/lite/events" + query, 8));
            if (memkey.Length == 0) continue;

            for (int i = 0; i < 10; i++)
            {
                bool ready = ParseOnline(await Get(BaseUrl + "/lifeevents?memkey=" + Uri.EscapeDataString(memkey), 6), sources);
                if (ready && sources.Count > 0) break;
                await Task.Delay(500);
            }
        }

        if (sources.Count == 0)
        {
            Log("no sources " + query);
            return;
        }

        // 2. Параллельно опрашиваем балансеры теми же параметрами, что и клиент.
        var bodies = new ConcurrentDictionary<string, string>();
        var jobs = sources.Take(SourceLimit).Select(async source =>
        {
            await parallel.WaitAsync();
            try
            {
                string body = await Get(BaseUrl + "/lite/" + source + queryForSource);
                if (body.Length > 0) bodies[source] = body;
            }
            catch
            {
            }
            finally
            {
                parallel.Release();
            }
        });
        await Task.WhenAll(jobs);

        // 3. Достаём ссылки выбора озвучки (call) и заранее тянем их: именно этот шаг
        //    заставляет ждать при переключении перевода.
        var calls = CollectCalls(bodies.Values);

        var fetching = calls.Select(async url =>
        {
            await parallel.WaitAsync();
            try { await Get(WithUid(url, uid), 5); }
            catch { }
            finally { parallel.Release(); }
        });
        await Task.WhenAll(fetching);

        Log($"ok sources={bodies.Count} calls={calls.Count} ms={(int)(DateTime.UtcNow - started).TotalMilliseconds} {query}");
    }

    static readonly string[] IgnoredParams =
    {
        "account_email", "profile_id", "token", "nws_id", "rchtype", "rjson",
        "life", "similar"
    };

    public static bool TryServe(string path, string query, out string body, out string contentType)
    {
        body = null;
        contentType = null;

        if (path.IndexOf("/lite/", StringComparison.OrdinalIgnoreCase) != 0) return false;
        if (path.StartsWith("/lite/events", StringComparison.OrdinalIgnoreCase)) return false;
        if (path.IndexOf("pidtor", StringComparison.OrdinalIgnoreCase) >= 0) return false;

        var key = CanonKey(path, query);
        if (!responses.TryGetValue(key, out var entry)) return false;

        if (DateTime.UtcNow - entry.Time > CacheTtl)
        {
            responses.TryRemove(key, out _);
            return false;
        }

        body = entry.Body;
        contentType = entry.ContentType;

        long hits = Interlocked.Increment(ref served);
        if (hits % 50 == 0)
            Log($"cache hit={hits} stored={stored} entries={responses.Count}");

        return true;
    }

    static string CanonKey(string path, string query)
    {
        var parsed = HttpUtility.ParseQueryString(query.TrimStart('?'));
        var parts = new List<string>();

        foreach (string name in parsed)
        {
            if (string.IsNullOrEmpty(name)) continue;
            if (Array.Exists(IgnoredParams, item => item.Equals(name, StringComparison.OrdinalIgnoreCase))) continue;

            string value = parsed[name] ?? "";
            if (value.Length == 0) continue;

            parts.Add(name.ToLowerInvariant() + "=" + value);
        }

        parts.Sort(StringComparer.Ordinal);
        return path.ToLowerInvariant() + "|" + string.Join("&", parts);
    }

    static void Store(string url, string body)
    {
        try
        {
            if (string.IsNullOrEmpty(body) || body.Length < 20 || body.Length > CacheMaxBody) return;

            char first = body[0];
            if (first != '{' && first != '[') return;
            if (body.IndexOf("\"rch\"", StringComparison.OrdinalIgnoreCase) >= 0) return;
            if (body.IndexOf("\"accsdb\":true", StringComparison.OrdinalIgnoreCase) >= 0) return;

            var uri = new Uri(url, UriKind.Absolute);
            string path = uri.AbsolutePath.TrimEnd('/');

            if (path.IndexOf("/lite/", StringComparison.OrdinalIgnoreCase) != 0) return;
            if (path.StartsWith("/lite/events", StringComparison.OrdinalIgnoreCase)) return;
            if (path.IndexOf("pidtor", StringComparison.OrdinalIgnoreCase) >= 0) return;

            responses[CanonKey(path, uri.Query)] = new CacheEntry
            {
                Body = body,
                ContentType = "application/json; charset=utf-8",
                Time = DateTime.UtcNow
            };

            Interlocked.Increment(ref stored);
            Interlocked.Add(ref storedBytes, body.Length);

            if (responses.Count > CacheMaxEntries || Interlocked.Read(ref storedBytes) > CacheMaxBytes) Trim();
        }
        catch
        {
        }
    }

    static void Trim()
    {
        try
        {
            int extra = responses.Count - CacheMaxEntries;
            if (extra <= 0 && Interlocked.Read(ref storedBytes) <= CacheMaxBytes) return;

            long freed = 0;
            int removed = 0;

            foreach (var key in responses.OrderBy(pair => pair.Value.Time).Select(pair => pair.Key).ToList())
            {
                if (removed >= extra && Interlocked.Read(ref storedBytes) - freed <= CacheMaxBytes) break;

                if (responses.TryRemove(key, out var entry))
                {
                    freed += entry.Body.Length;
                    removed++;
                }
            }

            Interlocked.Add(ref storedBytes, -freed);
        }
        catch
        {
        }
    }

    static async Task<string> Get(string url, int timeoutSeconds = 12)
    {
        try
        {
            using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds));
            using var response = await http.GetAsync(url, HttpCompletionOption.ResponseContentRead, cancel.Token);
            string body = await response.Content.ReadAsStringAsync();

            if (body.Length > 0 && url.IndexOf("/lite/", StringComparison.OrdinalIgnoreCase) >= 0)
                Store(url, body);

            return body;
        }
        catch
        {
            return "";
        }
    }

    static string SourceQuery(NameValueCollection source, string season)
    {
        var copy = HttpUtility.ParseQueryString("");
        foreach (string name in source)
        {
            if (string.IsNullOrEmpty(name)) continue;
            if (name.Equals("life", StringComparison.OrdinalIgnoreCase)) continue;
            copy[name] = source[name];
        }

        // Клиент добивает эти параметры у себя, поэтому в прогретом URL они должны быть теми же.
        if (copy["clarification"] == null) copy["clarification"] = "0";
        if (copy["s"] == null) copy["s"] = season;

        return "?" + ToQuery(copy);
    }

    static string ToQuery(NameValueCollection source)
    {
        var parts = new List<string>();
        foreach (string name in source)
        {
            if (string.IsNullOrEmpty(name)) continue;
            parts.Add(Uri.EscapeDataString(name) + "=" + Uri.EscapeDataString(source[name] ?? ""));
        }
        return string.Join("&", parts);
    }

    static string WithUid(string url, string uid)
    {
        if (string.IsNullOrEmpty(uid)) return url;
        try
        {
            var uri = new Uri(url, UriKind.Absolute);
            var parsed = HttpUtility.ParseQueryString(uri.Query);
            if (parsed["uid"] != null) return url;
            parsed["uid"] = uid;
            return uri.GetLeftPart(UriPartial.Path) + "?" + ToQuery(parsed);
        }
        catch
        {
            return url;
        }
    }

    static string ExtractMemkey(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("memkey", out var memkey))
                return memkey.GetString() ?? "";
        }
        catch
        {
        }

        return "";
    }

    static bool ParseOnline(string body, List<string> result)
    {
        if (string.IsNullOrWhiteSpace(body)) return false;

        try
        {
            using var doc = JsonDocument.Parse(body);
            JsonElement root = doc.RootElement;
            JsonElement list = default;
            bool found = false;

            if (root.ValueKind == JsonValueKind.Array)
            {
                list = root;
                found = true;
            }
            else if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("online", out var online) && online.ValueKind == JsonValueKind.Array)
            {
                list = online;
                found = true;
            }

            if (!found) return false;

            foreach (var item in list.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) continue;
                if (item.TryGetProperty("show", out var show) && show.ValueKind == JsonValueKind.False) continue;

                string balancer = null;
                foreach (var name in new[] { "balanser", "balancer", "name" })
                {
                    if (item.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
                    {
                        balancer = value.GetString();
                        break;
                    }
                }

                if (string.IsNullOrWhiteSpace(balancer)) continue;
                if (balancer.IndexOf(' ') >= 0) balancer = balancer.Split(' ')[0];
                balancer = balancer.ToLowerInvariant().Trim();
                if (balancer.Length == 0 || result.Contains(balancer)) continue;
                if (balancer.Equals("pidtor", StringComparison.OrdinalIgnoreCase)) continue;
                result.Add(balancer);
            }

            return root.ValueKind == JsonValueKind.Object && root.TryGetProperty("ready", out var readyFlag) && readyFlag.ValueKind == JsonValueKind.True;
        }
        catch
        {
        }

        return false;
    }

    static List<string> CollectCalls(IEnumerable<string> bodies)
    {
        var byVoice = new Dictionary<string, List<string>>();
        var seen = new HashSet<string>();

        foreach (var body in bodies)
        {
            if (string.IsNullOrWhiteSpace(body) || body[0] != '{') continue;

            try
            {
                using var doc = JsonDocument.Parse(body);
                Walk(doc.RootElement, "", byVoice, seen);
            }
            catch
            {
            }
        }

        var result = new List<string>();
        foreach (var list in byVoice.Values)
        {
            foreach (var url in list.Take(CallsPerVoice))
            {
                result.Add(url);
                if (result.Count >= CallLimit) return result;
            }
        }

        return result;
    }

    static void Walk(JsonElement element, string voice, Dictionary<string, List<string>> byVoice, HashSet<string> seen)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            string ownVoice = voice;
            foreach (var name in new[] { "translate_name", "translate", "details", "name" })
            {
                if (element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
                {
                    string text = value.GetString();
                    if (!string.IsNullOrWhiteSpace(text) && text != "no translate" && text != "no details")
                    {
                        ownVoice = text.Trim();
                        break;
                    }
                }
            }

            foreach (var property in element.EnumerateObject())
            {
                if (property.NameEquals("url") || property.NameEquals("reserve"))
                {
                    AddLinks(property.Value, ownVoice, byVoice, seen);
                    continue;
                }

                if (property.Value.ValueKind == JsonValueKind.Object || property.Value.ValueKind == JsonValueKind.Array)
                    Walk(property.Value, ownVoice, byVoice, seen);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
                Walk(item, voice, byVoice, seen);
        }
    }

    static void AddLinks(JsonElement element, string voice, Dictionary<string, List<string>> byVoice, HashSet<string> seen)
    {
        if (element.ValueKind == JsonValueKind.String)
        {
            string url = element.GetString();
            if (string.IsNullOrWhiteSpace(url)) return;
            if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return;
            if (url.IndexOf("/lite/", StringComparison.OrdinalIgnoreCase) < 0) return;
            if (!seen.Add(url)) return;

            if (!byVoice.TryGetValue(voice, out var list))
                byVoice[voice] = list = new List<string>();

            list.Add(url);
            return;
        }

        if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
                AddLinks(item, voice, byVoice, seen);
        }
    }
}
