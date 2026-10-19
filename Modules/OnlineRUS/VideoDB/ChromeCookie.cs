using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace VideoDB;

/// <summary>
/// Cookie антибота obrut.show (wd_approval) из внешнего Chrome через CDP.
/// Chrome должен выходить в сеть с того же IP, что и Lampac: cookie привязана к IP.
///
/// Cookie живёт ~2 суток. Если её не обновлять заранее, первый запрос после рестарта
/// lampac тратит 10-20 с на CDP-челлендж и не укладывается в 10-секундный checksearch
/// списка онлайна — источник пропадает из выдачи. Поэтому значение сохраняется на диск,
/// подгружается при старте и обновляется фоновым прогревом.
/// </summary>
public static class ChromeCookie
{
    static readonly SemaphoreSlim semaphore = new(1, 1);
    static readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(5) };
    static readonly object sync = new();

    const string cacheFile = "cache/videodb-waf.json";
    const string logFile = "logs/videodb-cookie.log";

    static DateTime lastRefresh;
    static DateTime lastSave;
    static DateTime valueExpires;
    static string warmUrl;
    static Timer warmTimer;

    public static string Value { get; private set; }

    #region init
    /// <summary>Вызывается из ModInit при загрузке/обновлении конфига (cdp из init.conf).</summary>
    public static void Init(string cdp)
    {
        lock (sync)
        {
            LoadFromDisk();

            warmTimer?.Dispose();
            warmTimer = null;

            if (string.IsNullOrEmpty(cdp))
                return;

            // фоновый прогрев: lampac поднялся -> обновляем cookie до того, как её попросит клиент
            warmTimer = new Timer(_ => _ = Warm(cdp), null, TimeSpan.FromSeconds(8), TimeSpan.FromMinutes(30));
        }
    }

    public static void Dispose()
    {
        lock (sync)
        {
            warmTimer?.Dispose();
            warmTimer = null;
        }
    }

    /// <summary>URL embed-страницы, на которой WAF выдаёт wd_approval — используется для прогрева.</summary>
    public static void Remember(string pageUrl)
    {
        if (string.IsNullOrWhiteSpace(pageUrl) || pageUrl == warmUrl)
            return;

        warmUrl = pageUrl;

        // не дёргаем диск на каждый новый фильм — сохраняем не чаще раза в 5 минут
        if (DateTime.UtcNow - lastSave > TimeSpan.FromMinutes(5))
            SaveToDisk();
    }
    #endregion

    #region get
    /// <summary>Актуальная cookie: из памяти, с диска или свежая из Chrome. null — если получить не удалось.</summary>
    public static async Task<string> GetAsync(string cdp, string pageUrl)
    {
        if (!string.IsNullOrEmpty(pageUrl))
            Remember(pageUrl);

        if (IsFresh(Value))
            return Value;

        if (string.IsNullOrEmpty(cdp))
            return Value;

        await semaphore.WaitAsync();
        try
        {
            if (IsFresh(Value))
                return Value;

            lastRefresh = DateTime.UtcNow;
            await TryFetch(cdp, pageUrl ?? warmUrl, Value);
            return Value;
        }
        finally
        {
            semaphore.Release();
        }
    }

    /// <summary>Принудительное обновление (для повтора после 403), не чаще раза в минуту.</summary>
    public static async Task<string> Refresh(string cdp, string pageUrl)
    {
        string used = Value;

        await semaphore.WaitAsync();
        try
        {
            if (Value != used || DateTime.UtcNow - lastRefresh < TimeSpan.FromMinutes(1))
                return Value;

            lastRefresh = DateTime.UtcNow;
            await TryFetch(cdp, pageUrl ?? warmUrl, used);
            return Value;
        }
        finally
        {
            semaphore.Release();
        }
    }
    #endregion

    #region state
    static bool IsFresh(string value)
    {
        if (string.IsNullOrEmpty(value))
            return false;

        if (valueExpires == default)
            return true; // срок жизни неизвестен — считаем значение рабочим

        return valueExpires > DateTime.UtcNow.AddMinutes(10);
    }

    static string Approval(string cookies)
    {
        if (string.IsNullOrEmpty(cookies))
            return null;

        var m = Regex.Match(cookies, "wd_approval=([^;]+)");
        return m.Success ? m.Groups[1].Value : null;
    }

    static async Task<bool> TryFetch(string cdp, string pageUrl, string used)
    {
        try
        {
            var fresh = await Fetch(cdp, pageUrl, used);
            if (fresh == null)
            {
                Log($"refresh: пусто (page={(pageUrl ?? "null")})");
                return false;
            }

            if (IsFresh(Value) && fresh.Value.value == Value)
                return true;

            Value = fresh.Value.value;
            valueExpires = fresh.Value.expires;
            SaveToDisk();
            Log($"refresh: ok, expires={valueExpires:u}");
            return true;
        }
        catch (Exception ex)
        {
            Log($"refresh: {ex.Message}");
            return false;
        }
    }

    // прогрев в фоне: обновляем cookie, если она отсутствует или скоро протухнет
    static async Task Warm(string cdp)
    {
        try
        {
            if (string.IsNullOrEmpty(warmUrl))
                return;

            if (IsFresh(Value) && valueExpires > DateTime.UtcNow.AddHours(12))
                return;

            await semaphore.WaitAsync();
            try
            {
                if (IsFresh(Value) && valueExpires > DateTime.UtcNow.AddHours(12))
                    return;

                lastRefresh = DateTime.UtcNow;
                await TryFetch(cdp, warmUrl, Value);
            }
            finally
            {
                semaphore.Release();
            }
        }
        catch (Exception ex)
        {
            Log($"warm: {ex.Message}");
        }
    }
    #endregion

    #region fetch
    static async Task<(string value, DateTime expires)?> Fetch(string cdp, string pageUrl, string used)
    {
        if (string.IsNullOrEmpty(pageUrl))
            return null;

        // DevTools принимает только Host в виде IP или localhost, поэтому имя сервиса резолвим сами
        var uri = new Uri(cdp);
        var ip = (await Dns.GetHostAddressesAsync(uri.Host, AddressFamily.InterNetwork)).First();
        string endpoint = $"{ip}:{uri.Port}";

        var version = JsonNode.Parse(await http.GetStringAsync($"http://{endpoint}/json/version"));
        string ws = Regex.Replace(version["webSocketDebuggerUrl"].GetValue<string>(), "^ws://[^/]+", $"ws://{endpoint}");

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        using var socket = new ClientWebSocket();
        await socket.ConnectAsync(new Uri(ws), cts.Token);

        int id = 0;
        async Task<JsonNode> send(string method, object args = null)
        {
            int msgId = ++id;
            byte[] msg = JsonSerializer.SerializeToUtf8Bytes(new { id = msgId, method, @params = args ?? new { } });
            await socket.SendAsync(msg, WebSocketMessageType.Text, true, cts.Token);

            var buffer = new byte[64 * 1024];
            while (true)
            {
                using var ms = new MemoryStream();
                WebSocketReceiveResult res;
                do
                {
                    res = await socket.ReceiveAsync(buffer, cts.Token);
                    ms.Write(buffer, 0, res.Count);
                }
                while (!res.EndOfMessage);

                var node = JsonNode.Parse(ms.ToArray());
                if (node["id"]?.GetValue<int>() == msgId)
                    return node["error"] != null ? throw new Exception(node["error"].ToJsonString()) : node["result"];
            }
        }

        // Только Target/Storage: Runtime.enable и прочая автоматизация палятся антиботом
        string targetId = (await send("Target.createTarget", new { url = pageUrl }))["targetId"].GetValue<string>();
        string host = new Uri(pageUrl).Host;

        try
        {
            for (int i = 0; i < 24; i++)
            {
                await Task.Delay(1000, cts.Token);

                var all = (await send("Storage.getCookies"))["cookies"].AsArray();

                var cookies = new List<string>();
                string approval = null;
                DateTime approvalExpires = default;

                foreach (var node in all)
                {
                    try
                    {
                        string domain = node["domain"].GetValue<string>().TrimStart('.');
                        if (host != domain && !host.EndsWith("." + domain))
                            continue;

                        string name = node["name"].GetValue<string>();
                        string value = node["value"].GetValue<string>();
                        cookies.Add($"{name}={value}");

                        if (name == "wd_approval")
                        {
                            double expires = node["expires"]?.GetValue<double>() ?? -1;
                            DateTime exp = expires > 0
                                ? DateTimeOffset.FromUnixTimeSeconds((long)expires).UtcDateTime
                                : DateTime.UtcNow.AddHours(6);

                            // просроченную cookie из профиля Chrome не принимаем
                            if (exp > DateTime.UtcNow.AddMinutes(5))
                            {
                                approval = value;
                                approvalExpires = exp;
                            }
                        }
                    }
                    catch { }
                }

                if (approval == null)
                    continue;

                string usedApproval = Approval(used);
                if (usedApproval == approval && IsFresh(used))
                    continue; // это та же самая (рабочая) cookie, ждём новую

                return (string.Join("; ", cookies), approvalExpires);
            }

            return null;
        }
        finally
        {
            try { await send("Target.closeTarget", new { targetId }); } catch { }
        }
    }
    #endregion

    #region disk
    static void LoadFromDisk()
    {
        try
        {
            if (!File.Exists(cacheFile))
                return;

            using var doc = JsonDocument.Parse(File.ReadAllText(cacheFile));
            string value = doc.RootElement.TryGetProperty("value", out var v) ? v.GetString() : null;
            string page = doc.RootElement.TryGetProperty("page", out var p) ? p.GetString() : null;
            string expires = doc.RootElement.TryGetProperty("expires", out var e) ? e.GetString() : null;

            DateTime diskExpires = default;
            if (DateTime.TryParse(expires, null, System.Globalization.DateTimeStyles.RoundtripKind, out var exp))
                diskExpires = exp.ToUniversalTime();

            if (!string.IsNullOrEmpty(page) && string.IsNullOrEmpty(warmUrl))
                warmUrl = page;

            // диск не должен затирать более свежее значение, уже полученное в этом процессе
            if (!string.IsNullOrEmpty(value) && diskExpires > DateTime.UtcNow.AddMinutes(10)
                && (string.IsNullOrEmpty(Value) || diskExpires > valueExpires))
            {
                Value = value;
                valueExpires = diskExpires;
                Log($"load: cookie с диска, expires={valueExpires:u}");
            }
        }
        catch (Exception ex)
        {
            Log($"load: {ex.Message}");
        }
    }

    static void SaveToDisk()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(cacheFile));
            Directory.CreateDirectory(Path.GetDirectoryName(logFile));

            File.WriteAllText(cacheFile, JsonSerializer.Serialize(new
            {
                value = Value,
                expires = valueExpires == default ? null : valueExpires.ToString("O"),
                page = warmUrl
            }));

            lastSave = DateTime.UtcNow;
        }
        catch (Exception ex)
        {
            Log($"save: {ex.Message}");
        }
    }

    static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(logFile));

            if (File.Exists(logFile) && new FileInfo(logFile).Length > 2 * 1024 * 1024)
                File.Move(logFile, logFile + ".1", overwrite: true);

            File.AppendAllText(logFile, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}\n");
        }
        catch { }
    }
    #endregion
}
