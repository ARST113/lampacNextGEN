using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using IO = System.IO;

namespace LampaWeb;

/// <summary>
/// Профильные галочки плагинов из админки (users.json -> user._admin.plugins).
///
/// Панель пишет их как { "p" + sha256(url плагина)[:12]: bool }, но во время работы
/// эту карту не читал никто: клиент всегда получал общий список, поэтому галочка,
/// снятая у одного профиля, действовала на всех. Здесь для профиля, которому
/// принадлежит uid запроса, собирается набор ЗАПРЕЩЁННЫХ плагинов; его забирает
/// lampainit.js и учитывает в lampacPluginAllowed().
/// </summary>
public static class ProfilePluginGate
{
    const string Empty = "window.lampac_profile_plugins = {};";
    const int CacheSeconds = 20;

    static readonly string[] BuiltInFiles =
    {
        "dlna.js", "tracks.js", "transcoding.js", "tmdbproxy.js", "cubproxy.js",
        "online.js", "watchtogether.js", "catalog.js", "dorama.js", "sisi.js",
        "startpage.js", "sync.js", "timecode.js", "bookmark.js", "ts.js", "backup.js"
    };

    static readonly object _lock = new();
    static string _uid, _script;
    static DateTime _stamp;

    public static string Script(string uid)
    {
        if (string.IsNullOrEmpty(uid))
            return Empty;

        lock (_lock)
        {
            if (_uid == uid && (DateTime.UtcNow - _stamp).TotalSeconds < CacheSeconds)
                return _script;
        }

        string script = Build(uid);

        lock (_lock)
        {
            _uid = uid;
            _script = script;
            _stamp = DateTime.UtcNow;
        }

        return script;
    }

    static string Build(string uid)
    {
        try
        {
            var prefs = AdminPrefs(uid);
            if (prefs == null)
                return Empty;

            var urls = new List<string>();

            if (ModInit.conf.customPlugins != null)
            {
                foreach (var plugin in ModInit.conf.customPlugins)
                    urls.Add(plugin?.url);
            }

            // Встроенные плагины LampaWeb — те же url, что уезжают клиенту в {initiale}.
            foreach (string file in BuiltInFiles)
                urls.Add("{localhost}/" + file);

            var denied = new List<string>();

            foreach (string url in urls)
            {
                if (string.IsNullOrEmpty(url))
                    continue;

                if (!prefs.TryGetValue(PluginKey(url), out bool enabled) || enabled)
                    continue;

                string key = NormalizeUrl(url);
                if (!string.IsNullOrEmpty(key) && !denied.Contains(key))
                    denied.Add(key);
            }

            if (denied.Count == 0)
                return Empty;

            var sb = new StringBuilder("window.lampac_profile_plugins = {");
            for (int i = 0; i < denied.Count; i++)
            {
                if (i > 0)
                    sb.Append(',');

                sb.Append(JToken.FromObject(denied[i]).ToString(Newtonsoft.Json.Formatting.None)).Append(":false");
            }

            return sb.Append("};").ToString();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[LampaWeb] profile plugin gate: {ex.Message}");
            return Empty;
        }
    }

    /// <summary>Галочки профиля: ключ панели -> включён ли плагин.</summary>
    static Dictionary<string, bool> AdminPrefs(string uid)
    {
        string path = UsersPath();
        if (path == null)
            return null;

        var users = JArray.Parse(IO.File.ReadAllText(path));
        if (users == null)
            return null;

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

            var result = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);

            if (user["_admin"]?["plugins"] is JObject plugins)
            {
                foreach (var property in plugins.Properties())
                {
                    if (property.Value.Type == JTokenType.Boolean)
                        result[property.Name] = property.Value.Value<bool>();
                    else if (bool.TryParse(property.Value.ToString(), out bool value))
                        result[property.Name] = value;
                }
            }

            return result;
        }

        return null;
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

    /// <summary>Ключ панели: "p" + sha256(url)[:12].</summary>
    public static string PluginKey(string url)
    {
        using var sha = SHA256.Create();
        string hex = Convert.ToHexString(sha.ComputeHash(Encoding.UTF8.GetBytes((url ?? string.Empty).Trim().ToLowerInvariant()))).ToLowerInvariant();
        return "p" + hex.Substring(0, 12);
    }

    /// <summary>Повторяет normalizePluginUrl() из lampainit.js: у локальных плагинов ключ — путь.</summary>
    public static string NormalizeUrl(string url)
    {
        string value = (url ?? string.Empty).Replace("{localhost}", string.Empty).Trim();
        if (value.Length == 0)
            return string.Empty;

        var absolute = Regex.Match(value, "^(?<scheme>https?)://(?<host>[^/]+)(?<path>/[^?#]*)?", RegexOptions.IgnoreCase);
        if (absolute.Success)
        {
            string path = absolute.Groups["path"].Success ? absolute.Groups["path"].Value : "/";
            return $"{absolute.Groups["scheme"].Value}://{absolute.Groups["host"].Value}{path}".ToLowerInvariant();
        }

        int cut = value.IndexOfAny(new[] { '?', '#' });
        if (cut >= 0)
            value = value.Substring(0, cut);

        if (!value.StartsWith("/"))
            value = "/" + value;

        return Regex.Replace(value, "/{2,}", "/").ToLowerInvariant();
    }
}
