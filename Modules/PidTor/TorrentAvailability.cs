using Shared;
using Shared.Models.Base;
using Shared.Services;
using Shared.Services.Utilities;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web;

namespace PidTor;

static class TorrentTrackerFallback
{
    public static readonly string[] Trackers =
    {
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://open.stealth.si:80/announce",
        "udp://tracker.torrent.eu.org:451/announce",
        "udp://exodus.desync.com:6969/announce",
        "udp://open.demonii.com:1337/announce",
        "udp://explodie.org:6969/announce",
        "udp://tracker.openbittorrent.com:6969/announce",
        "http://bt4.t-ru.org/ann?magnet"
    };

    // Ключевой момент: раньше фолбэк добавлялся только когда в запросе не было ни одного tr=.
    // Плагин всегда присылает trackers из каталога (нередко это только retracker.local/opentor.net,
    // которые не отвечают с внешнего TorrServer), поэтому рабочие публичные трекеры не попадали
    // в магнит вообще и TorrServer не мог получить метаданные (torrent getting info -> file_stats = null).
    public static string EnsureQuery(string query)
    {
        string value = (query ?? string.Empty).Trim('?', '&');

        var present = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string item in value.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!item.StartsWith("tr=", StringComparison.OrdinalIgnoreCase))
                continue;

            string tracker = HttpUtility.UrlDecode(item.Substring(3)).Trim();
            if (!string.IsNullOrWhiteSpace(tracker))
                present.Add(tracker);
        }

        string fallback = string.Join('&', Trackers.Where(i => !present.Contains(i)).Select(i => "tr=" + HttpUtility.UrlEncode(i)));
        if (string.IsNullOrEmpty(fallback))
            return value;

        return string.IsNullOrWhiteSpace(value) ? fallback : value + "&" + fallback;
    }

    public static string FromMagnet(string magnet)
    {
        string result = string.Empty;
        Match match = Regex.Match(magnet ?? string.Empty, @"(?:&|\?)tr=([^&?]+)", RegexOptions.IgnoreCase);
        while (match.Success)
        {
            string tracker = match.Groups[1].Value.Trim();
            if (!string.IsNullOrWhiteSpace(tracker))
            {
                string item = "tr=" + (tracker.Contains('/') || tracker.Contains(':') ? HttpUtility.UrlEncode(tracker) : tracker);
                if (!result.Split('&', StringSplitOptions.RemoveEmptyEntries).Contains(item, StringComparer.OrdinalIgnoreCase))
                    result += (result.Length == 0 ? string.Empty : "&") + item;
            }
            match = match.NextMatch();
        }

        return EnsureQuery(result);
    }
}

static class TorrentAvailability
{
    sealed record Entry(bool available, DateTimeOffset expires);

    static readonly ConcurrentDictionary<string, Entry> cache = new(StringComparer.OrdinalIgnoreCase);
    static readonly ConcurrentDictionary<string, SemaphoreSlim> locks = new(StringComparer.OrdinalIgnoreCase);

    public static async Task<bool> CheckAsync(string infohash, string trackerQuery)
    {
        if (string.IsNullOrWhiteSpace(infohash))
            return false;

        if (cache.TryGetValue(infohash, out Entry cached) && cached.expires > DateTimeOffset.UtcNow)
            return cached.available;

        SemaphoreSlim gate = locks.GetOrAdd(infohash, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (cache.TryGetValue(infohash, out cached) && cached.expires > DateTimeOffset.UtcNow)
                return cached.available;

            bool available = await ProbeAsync(infohash, trackerQuery).ConfigureAwait(false);
            cache[infohash] = new Entry(available, DateTimeOffset.UtcNow.Add(available ? TimeSpan.FromHours(12) : TimeSpan.FromMinutes(1)));
            return available;
        }
        finally
        {
            gate.Release();
        }
    }

    static async Task<bool> ProbeAsync(string infohash, string trackerQuery)
    {
        (string host, IReadOnlyList<HeadersModel> headers) = ProbeTarget();
        if (string.IsNullOrWhiteSpace(host))
            return true;

        string query = TorrentTrackerFallback.EnsureQuery(trackerQuery);
        string magnet = $"magnet:?xt=urn:btih:{infohash}&{query}";

        string added = await Http.Post(
            $"{host}/torrents",
            "{\"action\":\"add\",\"link\":\"" + magnet + "\",\"title\":\"\",\"poster\":\"\",\"save_to_db\":false}",
            timeoutSeconds: 3,
            headers: headers
        ).ConfigureAwait(false);

        string hash = Regex.Match(added ?? string.Empty, "\"hash\":\"([^\"]+)\"").Groups[1].Value;
        if (string.IsNullOrWhiteSpace(hash))
            return false;

        Stat stat = await WaitForStatAsync(host, hash, headers).ConfigureAwait(false);
        return stat?.file_stats?.Length > 0;
    }

    static (string host, IReadOnlyList<HeadersModel> headers) ProbeTarget()
    {
        var init = ModInit.conf;
        var auth = init.auth_torrs?.FirstOrDefault(i => i.enable);
        if (auth != null)
        {
            if ((auth.login ?? string.Empty).Contains("{user_", StringComparison.Ordinal))
                return (null, null);

            var basic = HeadersModel.Init("Authorization", $"Basic {CrypTo.Base64($"{auth.login}:{auth.passwd}")}");
            return (auth.host?.TrimEnd('/'), HeadersModel.Join(basic, auth.headers));
        }

        string configured = init.torrs?.FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(configured))
        {
            if (init.base_auth?.enable == true)
            {
                if ((init.base_auth.login ?? string.Empty).Contains("{user_", StringComparison.Ordinal))
                    return (null, null);

                var basic = HeadersModel.Init("Authorization", $"Basic {CrypTo.Base64($"{init.base_auth.login}:{init.base_auth.passwd}")}");
                return (configured.TrimEnd('/'), HeadersModel.Join(basic, init.base_auth.headers));
            }

            return (configured.TrimEnd('/'), null);
        }

        string path = "data/ts/accs.db";
        if (!File.Exists(path))
            return (null, null);

        string password = Regex.Match(File.ReadAllText(path), "\"ts\":\"([^\"]+)\"").Groups[1].Value;
        var headers = HeadersModel.Init("Authorization", $"Basic {CrypTo.Base64($"ts:{password}")}");
        return ($"http://{CoreInit.conf.listen.localhost}:{ModInit.tsport}", headers);
    }

    // Метаданные магнита на внешнем TorrServer приходят не мгновенно. Шесть попыток по 300 мс
    // истекали раньше, чем TorrServer успевал скачать .torrent у релиза с одним-двумя сидами,
    // и плеер получал 503 «file_stats» - «Бездомный бог» (OVA) так и не запускался.
    // Ждём до budget (по умолчанию без ограничения - как раньше), опрашивая раз в delayMs.
    public static async Task<Stat> WaitForStatAsync(string host, string hash, IReadOnlyList<HeadersModel> headers,
        int attempts = 6, TimeSpan? budget = null, int delayMs = 300)
    {
        DateTimeOffset started = DateTimeOffset.UtcNow;

        for (int attempt = 0; attempt < attempts; attempt++)
        {
            Stat stat = await Http.Get<Stat>($"{host.TrimEnd('/')}/stream?link={hash}&index=1&stat", timeoutSeconds: 3, headers: headers).ConfigureAwait(false);
            if (stat?.file_stats?.Length > 0)
                return stat;

            if (attempt + 1 >= attempts)
                break;

            if (budget.HasValue && DateTimeOffset.UtcNow - started + TimeSpan.FromMilliseconds(delayMs) >= budget.Value)
                break;

            await Task.Delay(delayMs).ConfigureAwait(false);
        }

        return null;
    }
}
