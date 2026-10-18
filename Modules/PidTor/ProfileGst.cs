using Newtonsoft.Json.Linq;
using Shared;
using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using IO = System.IO;

namespace PidTor;

/// <summary>
/// GStreamer для конкретного профиля.
///
/// ModInit.conf.gst (init.conf -> PidTor.gst) остаётся мастер-выключателем, но
/// персонально решает галочка плагина GStreamer в админке: она лежит в users.json
/// (user._admin.plugins["p" + sha256(url)[:12]]). Раньше её не читал никто, поэтому
/// включённый «только для Тани» gst работал у всех.
/// </summary>
static class ProfileGst
{
    const string FallbackKey = "p37fd57299dc3";
    const int CacheSeconds = 20;

    static readonly object _lock = new();
    static string _uid;
    static bool _allowed = true;
    static DateTime _stamp;

    public static bool Allowed(string uid)
    {
        if (!ModInit.conf.gst)
            return false;

        if (string.IsNullOrEmpty(uid))
            return true;

        lock (_lock)
        {
            if (_uid == uid && (DateTime.UtcNow - _stamp).TotalSeconds < CacheSeconds)
                return _allowed;
        }

        bool allowed = Resolve(uid);

        lock (_lock)
        {
            _uid = uid;
            _allowed = allowed;
            _stamp = DateTime.UtcNow;
        }

        return allowed;
    }

    static bool Resolve(string uid)
    {
        try
        {
            string key = GstPluginKey();
            string path = UsersPath();
            if (path == null)
                return true;

            var users = JArray.Parse(IO.File.ReadAllText(path));
            if (users == null)
                return true;

            foreach (var user in users)
            {
                bool match = string.Equals(user?["id"]?.ToString(), uid, StringComparison.OrdinalIgnoreCase);

                if (!match && user?["ids"] is JArray ids)
                {
                    foreach (var id in ids)
                    {
                        if (string.Equals(id?.ToString(), uid, StringComparison.OrdinalIgnoreCase))
                        {
                            match = true;
                            break;
                        }
                    }
                }

                if (!match)
                    continue;

                // Нет записи у профиля — как в панели, считаем плагин включённым.
                if (user["_admin"]?["plugins"] is not JObject plugins)
                    return true;

                var value = plugins[key];
                if (value == null || value.Type == JTokenType.Null)
                    return true;

                if (value.Type == JTokenType.Boolean)
                    return value.Value<bool>();

                return !bool.TryParse(value.ToString(), out bool parsed) || parsed;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[PidTor] profile gst: {ex.Message}");
        }

        return true;
    }

    /// <summary>Ключ галочки GStreamer в админке — считаем от url плагина в init.conf.</summary>
    static string GstPluginKey()
    {
        try
        {
            if (CoreInit.CurrentConf?["LampaWeb"]?["customPlugins"] is JArray plugins)
            {
                foreach (var plugin in plugins)
                {
                    string url = plugin?["url"]?.ToString();
                    if (!string.IsNullOrEmpty(url) && url.Contains("gst"))
                        return Key(url);
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[PidTor] gst plugin key: {ex.Message}");
        }

        return FallbackKey;
    }

    static string Key(string url)
    {
        using var sha = SHA256.Create();
        string hex = Convert.ToHexString(sha.ComputeHash(Encoding.UTF8.GetBytes((url ?? string.Empty).Trim().ToLowerInvariant()))).ToLowerInvariant();
        return "p" + hex.Substring(0, 12);
    }

    static string UsersPath()
    {
        string[] candidates =
        {
            "users.json",
            IO.Path.Combine(AppContext.BaseDirectory ?? string.Empty, "users.json"),
            "/home/lampac/users.json"
        };

        foreach (string candidate in candidates)
        {
            try
            {
                if (IO.File.Exists(candidate))
                    return candidate;
            }
            catch (Exception) { }
        }

        return null;
    }
}
